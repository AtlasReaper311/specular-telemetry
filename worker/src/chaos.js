const CHAOS_KEY = "specular:chaos:active:v1";

export const LIVE_FAULTS = new Set([
  "status_503",
  "latency",
  "kv_write_reject",
]);

export const TEST_ONLY_FAULTS = new Set([
  "stale_response",
  "webhook_drop",
]);

export const ALLOWED_FAULTS = new Set([
  ...LIVE_FAULTS,
  ...TEST_ONLY_FAULTS,
]);

let activationQueue = Promise.resolve();

async function withActivationLock(action) {
  const previous = activationQueue;
  let release;
  activationQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

export function timingSafeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export function validateFault(payload, { allowTestFaults = false } = {}) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "body must be a JSON object" };
  }
  const experimentId = String(payload.experiment_id || "");
  if (!/^[a-z0-9][a-z0-9._-]{5,79}$/i.test(experimentId)) {
    return { ok: false, error: "experiment_id must be 6-80 safe characters" };
  }
  const fault = String(payload.fault || "");
  if (!ALLOWED_FAULTS.has(fault)) {
    return { ok: false, error: `unsupported fault: ${fault}` };
  }
  if (TEST_ONLY_FAULTS.has(fault) && !allowTestFaults) {
    return { ok: false, error: `test-only fault is disabled: ${fault}` };
  }
  const durationSeconds = Number(payload.duration_seconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 300) {
    return { ok: false, error: "duration_seconds must be an integer from 10 to 300" };
  }
  const latencyMs = fault === "latency" ? Number(payload.latency_ms || 2000) : 0;
  if (fault === "latency" && (!Number.isInteger(latencyMs) || latencyMs < 250 || latencyMs > 5000)) {
    return { ok: false, error: "latency_ms must be an integer from 250 to 5000" };
  }
  return {
    ok: true,
    value: {
      schema: "atlas-chaos-lease/v1",
      experiment_id: experimentId,
      fault,
      duration_seconds: durationSeconds,
      latency_ms: latencyMs,
      activated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + durationSeconds * 1000).toISOString(),
      target: "specular-edge",
    },
  };
}

async function notifyChaos(env, record, phase, reason = null) {
  if (!record || record.fault === "webhook_drop" || !env.NOTIFY_TOKEN) return false;
  const level = phase === "recovered" ? "success" : "warning";
  const body = {
    source: "alert",
    signal_class: "infra_health",
    level,
    title: `Chaos ${phase}: ${record.experiment_id}`,
    message: `${record.fault} on ${record.target}; experiment ${record.experiment_id}`,
    fields: {
      experiment_id: record.experiment_id,
      fault: record.fault,
      target: record.target,
      phase,
      ...(reason ? { reason } : {}),
    },
  };
  const init = {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.NOTIFY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  try {
    const response = env.ATLAS_NOTIFY
      ? await env.ATLAS_NOTIFY.fetch("https://atlas-notify/notify", init)
      : env.NOTIFY_URL
        ? await fetch(env.NOTIFY_URL, init)
        : null;
    return Boolean(response?.ok);
  } catch (error) {
    console.log("chaos notification failed:", error.message);
    return false;
  }
}

async function scheduleNotification(env, record, phase, reason, ctx) {
  const task = notifyChaos(env, record, phase, reason);
  if (ctx?.waitUntil) {
    ctx.waitUntil(task);
    return;
  }
  await task;
}

export async function currentChaos(env, ctx = null) {
  if (env.CHAOS_ENABLED !== "true" || !env.TELEMETRY_KV) return null;
  const record = await env.TELEMETRY_KV.get(CHAOS_KEY, "json");
  if (!record) return null;
  const expiresAt = Date.parse(record.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await env.TELEMETRY_KV.delete(CHAOS_KEY);
    const reason = Number.isFinite(expiresAt) ? "lease_expired" : "invalid_expiry";
    await scheduleNotification(env, record, "recovered", reason, ctx);
    return null;
  }
  return record;
}

function authOkay(request, env) {
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(env.CHAOS_TOKEN) && timingSafeEqual(supplied, env.CHAOS_TOKEN);
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function activeSummary(record) {
  return {
    experiment_id: record.experiment_id,
    fault: record.fault,
    expires_at: record.expires_at,
  };
}

export async function handleChaosControl(request, env, ctx) {
  if (env.CHAOS_ENABLED !== "true") return response({ error: "not found" }, 404);
  if (!authOkay(request, env)) return response({ error: "unauthorised" }, 401);
  if (!env.TELEMETRY_KV) return response({ error: "TELEMETRY_KV not bound" }, 503);

  if (request.method === "GET") {
    return response({ ok: true, active: await currentChaos(env, ctx) });
  }

  if (request.method === "DELETE") {
    const active = await currentChaos(env, ctx);
    await env.TELEMETRY_KV.delete(CHAOS_KEY);
    if (active) {
      await scheduleNotification(env, active, "recovered", "explicit_delete", ctx);
    }
    return response({ ok: true, rolled_back: active?.experiment_id || null });
  }

  if (request.method !== "POST") {
    return response({ error: "method not allowed" }, 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return response({ error: "invalid JSON" }, 400);
  }
  const validation = validateFault(payload, {
    allowTestFaults: env.CHAOS_ALLOW_TEST_FAULTS === "true",
  });
  if (!validation.ok) return response({ error: validation.error }, 422);

  return withActivationLock(async () => {
    const active = await currentChaos(env, ctx);
    if (active) {
      return response(
        {
          error: "another chaos lease is already active",
          active: activeSummary(active),
        },
        409,
      );
    }

    const record = validation.value;
    await env.TELEMETRY_KV.put(CHAOS_KEY, JSON.stringify(record), {
      // Logical expiry is enforced by currentChaos. The longer physical TTL
      // keeps the record available long enough to emit event-driven recovery
      // evidence on the first request after expiry.
      expirationTtl: record.duration_seconds + 3600,
    });
    await scheduleNotification(env, record, "injected", null, ctx);
    return response({ ok: true, active: record }, 202);
  });
}

export async function applyChaos(record) {
  if (!record) return { response: null, delay_ms: 0, marker: null };
  if (record.fault === "latency") {
    await new Promise((resolve) => setTimeout(resolve, record.latency_ms));
    return { response: null, delay_ms: record.latency_ms, marker: record.fault };
  }
  if (record.fault === "status_503") {
    return {
      response: response(
        {
          ok: false,
          error: "controlled chaos fault",
          experiment_id: record.experiment_id,
          fault: record.fault,
          expires_at: record.expires_at,
        },
        503,
      ),
      delay_ms: 0,
      marker: record.fault,
    };
  }
  return { response: null, delay_ms: 0, marker: record.fault };
}

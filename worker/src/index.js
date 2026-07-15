import { handleMeta } from "./_meta.js";
import { applyChaos, currentChaos, handleChaosControl } from "./chaos.js";

const TELEMETRY_KEY = "specular:last-known-good:v1";
const ANOMALY_KEY = "specular:anomaly:latest:v1";
const ANOMALY_HISTORY_KEY = "specular:anomaly:history:v1";

const META = {
  name: "specular-edge",
  description:
    "Live hardware telemetry and shape-aware anomaly evidence from SPECULAR-CORE",
  version: "1.1.0",
  endpoints: [
    { method: "GET", path: "/specular", description: "Latest telemetry snapshot" },
    { method: "GET", path: "/specular/anomaly", description: "Latest DSP-derived anomaly evidence" },
    { method: "GET", path: "/specular/anomaly/history", description: "Bounded anomaly evidence history" },
    { method: "GET", path: "/specular/_meta", description: "This document" },
  ],
  source: "https://github.com/AtlasReaper311/specular-telemetry",
};

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const headers = { vary: "origin" };
  if (!origin) return headers;
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
    headers["access-control-allow-headers"] = "authorization, content-type";
    headers["access-control-max-age"] = "86400";
  }
  return headers;
}

function json(body, request, env, { status = 200, cacheControl, extra = {} } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(request, env),
    ...extra,
  };
  if (cacheControl) headers["cache-control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

async function persistTelemetryIfDue(env, payload, fault) {
  if (fault?.fault === "kv_write_reject") {
    console.log("controlled chaos: telemetry KV write rejected", fault.experiment_id);
    return;
  }
  const minInterval = Number(env.KV_MIN_WRITE_INTERVAL_SECONDS || "600") * 1000;
  const stored = await env.TELEMETRY_KV.get(TELEMETRY_KEY, "json");
  const due =
    !stored ||
    stored.online === false ||
    Date.now() - Date.parse(stored.saved_at) >= minInterval;
  if (!due) return;
  await env.TELEMETRY_KV.put(
    TELEMETRY_KEY,
    JSON.stringify({
      online: true,
      saved_at: payload.fetched_at,
      telemetry: payload.telemetry,
    }),
  );
}

async function persistOffline(env, nowIso) {
  const stored = await env.TELEMETRY_KV.get(TELEMETRY_KEY, "json");
  if (stored && stored.online === false) return;
  await env.TELEMETRY_KV.put(
    TELEMETRY_KEY,
    JSON.stringify({
      online: false,
      saved_at: stored ? stored.saved_at : null,
      went_offline_at: nowIso,
      telemetry: stored ? stored.telemetry : null,
    }),
  );
}

async function persistAnomalyIfDue(env, anomaly, fault) {
  if (!anomaly || fault?.fault === "kv_write_reject") return;
  const stored = await env.TELEMETRY_KV.get(ANOMALY_KEY, "json");
  const due =
    !stored ||
    stored.state !== anomaly.state ||
    Math.abs(Number(stored.score || 0) - Number(anomaly.score || 0)) >= 0.08 ||
    Date.now() - Date.parse(stored.saved_at || 0) >= 600000;
  if (!due) return;

  const record = { ...anomaly, saved_at: new Date().toISOString() };
  await env.TELEMETRY_KV.put(ANOMALY_KEY, JSON.stringify(record));
  const history = (await env.TELEMETRY_KV.get(ANOMALY_HISTORY_KEY, "json")) || [];
  history.unshift(record);
  if (history.length > 192) history.length = 192;
  await env.TELEMETRY_KV.put(ANOMALY_HISTORY_KEY, JSON.stringify(history));
}

function applyStaleResponse(payload, fault) {
  if (fault?.fault !== "stale_response" || !payload?.telemetry) return payload;
  const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  return {
    ...payload,
    fetched_at: stale,
    telemetry: { ...payload.telemetry, sampled_at: stale },
    chaos: { experiment_id: fault.experiment_id, fault: fault.fault },
  };
}

async function upstreamJson(env, path) {
  const timeoutMs = Number(env.TUNNEL_TIMEOUT_MS || "5000");
  const upstream = await fetch(`${env.TUNNEL_ORIGIN}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "specular-edge/1.1" },
  });
  if (!upstream.ok) throw new Error(`tunnel answered ${upstream.status}`);
  return upstream.json();
}

async function serveTelemetry(request, env, ctx) {
  const fault = await currentChaos(env);
  const applied = await applyChaos(fault);
  if (applied.response) {
    const body = await applied.response.text();
    return new Response(body, {
      status: applied.response.status,
      headers: {
        ...Object.fromEntries(applied.response.headers),
        ...corsHeaders(request, env),
        "x-atlas-chaos": fault.experiment_id,
      },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request("https://specular-edge.atlas/telemetry");
  if (!fault) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(await cached.text(), {
        status: cached.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-specular-cache": "hit",
          ...corsHeaders(request, env),
        },
      });
    }
  }

  const nowIso = new Date().toISOString();
  const ttl = Number(env.CACHE_TTL_SECONDS || "60");
  const offlineTtl = Number(env.OFFLINE_CACHE_TTL_SECONDS || "30");

  try {
    const telemetry = await upstreamJson(env, "/telemetry");
    let payload = {
      online: true,
      fetched_at: nowIso,
      last_seen: nowIso,
      telemetry,
    };
    payload = applyStaleResponse(payload, fault);

    ctx.waitUntil(persistTelemetryIfDue(env, payload, fault));
    ctx.waitUntil(persistAnomalyIfDue(env, telemetry.anomaly, fault));
    if (!fault) {
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(JSON.stringify(payload), {
            headers: {
              "content-type": "application/json",
              "cache-control": `public, s-maxage=${ttl}`,
            },
          }),
        ),
      );
    }
    return json(payload, request, env, {
      cacheControl: fault ? "no-store" : `public, max-age=${Math.min(ttl, 15)}`,
      extra: fault ? { "x-atlas-chaos": fault.experiment_id } : {},
    });
  } catch (error) {
    console.log("tunnel unreachable:", error.message);
    const stored = await env.TELEMETRY_KV.get(TELEMETRY_KEY, "json");
    const payload = {
      online: false,
      fetched_at: nowIso,
      last_seen: stored ? stored.saved_at : null,
      telemetry: stored ? stored.telemetry : null,
    };
    ctx.waitUntil(persistOffline(env, nowIso));
    if (!fault) {
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(JSON.stringify(payload), {
            headers: {
              "content-type": "application/json",
              "cache-control": `public, s-maxage=${offlineTtl}`,
            },
          }),
        ),
      );
    }
    return json(payload, request, env, {
      cacheControl: "no-store",
      extra: fault ? { "x-atlas-chaos": fault.experiment_id } : {},
    });
  }
}

async function serveAnomaly(request, env, history = false) {
  if (history) {
    const items = (await env.TELEMETRY_KV.get(ANOMALY_HISTORY_KEY, "json")) || [];
    return json(
      {
        schema: "specular-anomaly-history/v1",
        count: items.length,
        items,
        generated_at: new Date().toISOString(),
      },
      request,
      env,
      { cacheControl: "public, max-age=60" },
    );
  }

  let latest = await env.TELEMETRY_KV.get(ANOMALY_KEY, "json");
  if (!latest) {
    try {
      latest = await upstreamJson(env, "/anomaly");
      await persistAnomalyIfDue(env, latest, null);
    } catch {
      return json(
        {
          schema: "specular-anomaly/v1",
          state: "unknown",
          score: null,
          warmup: true,
          metrics: {},
          generated_at: null,
          error: "no anomaly evidence has reached the edge",
        },
        request,
        env,
        { status: 503, cacheControl: "no-store" },
      );
    }
  }
  return json(latest, request, env, { cacheControl: "public, max-age=30" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (path === "/specular/__chaos") {
      return handleChaosControl(request, env, ctx);
    }

    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, request, env, { status: 405 });
    }
    if (path === "/specular") return serveTelemetry(request, env, ctx);
    if (path === "/specular/anomaly") return serveAnomaly(request, env, false);
    if (path === "/specular/anomaly/history") return serveAnomaly(request, env, true);
    return json({ error: "not found" }, request, env, { status: 404 });
  },
};

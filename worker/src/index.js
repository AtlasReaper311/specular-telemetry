/**
 * specular-edge
 *
 * The public face of SPECULAR-CORE's telemetry. Fetches the local
 * service through its Cloudflare Tunnel hostname, serves it at
 * api.atlas-systems.uk/specular, and keeps answering with a consistent
 * schema when the machine is off.
 *
 * Two-tier caching, deliberately not "KV for 60 seconds":
 *   - Cache API is the 60s hot cache. Free, unlimited, per-colo.
 *   - TELEMETRY_KV holds one last-known-good snapshot, written only on
 *     an online/offline flip or when the stored copy is stale
 *     (KV_MIN_WRITE_INTERVAL_SECONDS). Naive 60s KV writes would be up
 *     to 1,440/day against the 1,000/day free cap; the guard holds the
 *     worst case near 150. Same conditional-write pattern as the
 *     deploy-watch fix.
 *
 * Degraded contract: when the tunnel is unreachable the response keeps
 * the same shape with online:false, last_seen, and the stale telemetry
 * from KV (null when the machine has never reported).
 */

import { handleMeta } from "./_meta.js";

const KV_KEY = "specular:last-known-good:v1";

const META = {
  name: "specular-edge",
  description:
    "Live hardware telemetry from SPECULAR-CORE, cached at the edge",
  version: "1.0.0",
  endpoints: [
    {
      method: "GET",
      path: "/specular",
      description: "Latest telemetry snapshot; online:false when the box is off",
    },
    { method: "GET", path: "/specular/_meta", description: "This document" },
  ],
  source: "https://github.com/AtlasReaper311/specular-telemetry",
};

/** Build CORS headers for an allowlisted browser origin. */
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
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
    headers["access-control-max-age"] = "86400";
  }
  return headers;
}

/** JSON response with CORS and optional extra headers. */
function json(body, request, env, { status = 200, cacheControl } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(request, env),
  };
  if (cacheControl) headers["cache-control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Persist a fresh snapshot to KV only when it earns a write: the
 * stored copy is missing, marks the machine offline (state flip), or
 * is older than the minimum write interval.
 */
async function persistIfDue(env, payload) {
  const minInterval = Number(env.KV_MIN_WRITE_INTERVAL_SECONDS || "600") * 1000;
  const stored = await env.TELEMETRY_KV.get(KV_KEY, "json");
  const due =
    !stored ||
    stored.online === false ||
    Date.now() - Date.parse(stored.saved_at) >= minInterval;
  if (!due) return;
  await env.TELEMETRY_KV.put(
    KV_KEY,
    JSON.stringify({
      online: true,
      saved_at: payload.fetched_at,
      telemetry: payload.telemetry,
    }),
  );
}

/** Record the online→offline flip once, preserving the last snapshot. */
async function persistOffline(env, nowIso) {
  const stored = await env.TELEMETRY_KV.get(KV_KEY, "json");
  if (stored && stored.online === false) return; // already recorded
  await env.TELEMETRY_KV.put(
    KV_KEY,
    JSON.stringify({
      online: false,
      saved_at: stored ? stored.saved_at : null,
      went_offline_at: nowIso,
      telemetry: stored ? stored.telemetry : null,
    }),
  );
}

async function serveTelemetry(request, env, ctx) {
  const cache = caches.default;
  // A fixed synthetic key: every path/query variant of the endpoint
  // shares one cached body, and the key never collides with real URLs.
  const cacheKey = new Request("https://specular-edge.atlas/telemetry");
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: cached.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-specular-cache": "hit",
        ...corsHeaders(request, env),
      },
    });
  }

  const nowIso = new Date().toISOString();
  const timeoutMs = Number(env.TUNNEL_TIMEOUT_MS || "5000");
  const ttl = Number(env.CACHE_TTL_SECONDS || "60");
  const offlineTtl = Number(env.OFFLINE_CACHE_TTL_SECONDS || "30");

  try {
    const upstream = await fetch(`${env.TUNNEL_ORIGIN}/telemetry`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "specular-edge/1.0" },
    });
    if (!upstream.ok) throw new Error(`tunnel answered ${upstream.status}`);
    const telemetry = await upstream.json();

    const payload = {
      online: true,
      fetched_at: nowIso,
      last_seen: nowIso,
      telemetry,
    };
    ctx.waitUntil(persistIfDue(env, payload));
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
    return json(payload, request, env, {
      cacheControl: `public, max-age=${Math.min(ttl, 15)}`,
    });
  } catch (err) {
    console.log("tunnel unreachable:", err.message);
    const stored = await env.TELEMETRY_KV.get(KV_KEY, "json");
    const payload = {
      online: false,
      fetched_at: nowIso,
      last_seen: stored ? stored.saved_at : null,
      telemetry: stored ? stored.telemetry : null,
    };
    ctx.waitUntil(persistOffline(env, nowIso));
    // Short offline cache: shields the dead tunnel from request storms
    // without hiding a recovery for more than half a minute.
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
    return json(payload, request, env, { cacheControl: "no-store" });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (url.pathname !== "/specular" && url.pathname !== "/specular/") {
      return json({ error: "not found" }, request, env, { status: 404 });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, request, env, { status: 405 });
    }
    return serveTelemetry(request, env, ctx);
  },
};

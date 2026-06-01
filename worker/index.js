/**
 * Zenith edge API gateway.
 *
 * Responsibilities:
 *   - Terminate CORS for the Pages frontend.
 *   - KV-cache GET responses from the FastAPI backend with per-route TTLs.
 *   - Route /api/plan, /api/targets, /api/weather to the backend on the
 *     DigitalOcean droplet (BACKEND_URL var).
 *
 * Bindings (see wrangler.toml):
 *   env.ZENITH_CACHE  - KV namespace for response cache
 *   env.ZENITH_IMAGES - R2 bucket for MAST reference images (unused here)
 *   env.DB            - D1 database for user profiles + sessions
 *   env.BACKEND_URL   - FastAPI origin
 */

// Per-route cache TTLs in seconds. Anything not listed is uncached.
const CACHE_TTL = {
  "/api/targets": 60 * 60 * 24, // 24 hr — catalog is slow-changing
  "/api/weather": 60 * 60,      // 1 hr  — Open-Meteo refreshes hourly
  // /api/plan is intentionally NOT cached: plans are per-user, per-session.
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const PROXY_PREFIXES = ["/api/plan", "/api/targets", "/api/weather"];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (!PROXY_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return json({ error: "not found", path: url.pathname }, 404);
    }

    const ttl = CACHE_TTL[url.pathname] ?? 0;
    const cacheable = request.method === "GET" && ttl > 0;
    const cacheKey = cacheable ? await buildCacheKey(request, url) : null;

    if (cacheable) {
      const hit = await env.ZENITH_CACHE.get(cacheKey, { type: "json" });
      if (hit) {
        return json(hit.body, hit.status, { "X-Zenith-Cache": "HIT" });
      }
    }

    const originResponse = await proxyToBackend(request, url, env);

    // Only cache 2xx JSON responses.
    if (
      cacheable &&
      originResponse.ok &&
      (originResponse.headers.get("content-type") || "").includes("application/json")
    ) {
      const body = await originResponse.clone().json();
      ctx.waitUntil(
        env.ZENITH_CACHE.put(
          cacheKey,
          JSON.stringify({ status: originResponse.status, body }),
          { expirationTtl: ttl },
        ),
      );
    }

    return withCors(originResponse, { "X-Zenith-Cache": cacheable ? "MISS" : "BYPASS" });
  },
};

async function proxyToBackend(request, url, env) {
  const backend = (env.BACKEND_URL || "").replace(/\/$/, "");
  if (!backend) {
    return json({ error: "BACKEND_URL not configured" }, 500);
  }

  const upstreamUrl = backend + url.pathname + url.search;
  const upstream = new Request(upstreamUrl, {
    method: request.method,
    headers: stripHopByHop(request.headers),
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "follow",
  });

  try {
    return await fetch(upstream);
  } catch (err) {
    return json({ error: "backend unreachable", detail: String(err) }, 502);
  }
}

async function buildCacheKey(request, url) {
  // Include path + sorted query so semantically identical requests share keys.
  const params = [...url.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&");
  return `v1:${url.pathname}?${params}`;
}

function stripHopByHop(headers) {
  const out = new Headers(headers);
  ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "cf-connecting-ip"].forEach((h) =>
    out.delete(h),
  );
  return out;
}

function withCors(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extra })) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

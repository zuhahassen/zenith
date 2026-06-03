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

import { getFeedback, insertFeedback } from "./db.js";

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

// Proxy everything under /api/ to the backend (health, plan, plan-ai,
// explain, targets, weather). Per-route caching is still controlled by
// CACHE_TTL below; uncached routes simply pass through.
const PROXY_PREFIX = "/api/";

// ---------------------------------------------------------------------------
// Token-bucket rate limiting (KV-backed).
//
// The LLM endpoints are the only ones that cost real money (OpenRouter), so we
// meter them per user. A single bucket of 10 tokens refills at 1 token / 5 min;
// a plan-ai call spends 3 tokens, an explain call spends 1. That works out to a
// sustained ceiling of ~3 plans per 15 minutes with a small burst allowance,
// which is plenty for a human planning a night but cheap to bound.
// ---------------------------------------------------------------------------
const RL_MAX_TOKENS = 10;
const RL_REFILL_SECONDS = 300; // one token every 5 minutes
const RL_COST = { "/api/plan-ai": 3, "/api/explain": 1 };
const RL_TTL_SECONDS = RL_MAX_TOKENS * RL_REFILL_SECONDS; // full bucket lifetime

/**
 * Spend `cost` tokens from the caller's bucket. Lazily refills based on elapsed
 * wall-clock time since the last write, so no background timer is needed.
 *
 * @returns {Promise<{allowed: boolean, remaining: number, reset_in_seconds: number}>}
 */
async function rateLimit(userId, env, cost = 1) {
  // No KV binding (e.g. local dev without --kv) → fail open rather than 500.
  if (!env || !env.ZENITH_CACHE) {
    return { allowed: true, remaining: RL_MAX_TOKENS, reset_in_seconds: 0 };
  }

  const key = `rl:${userId}`;
  const now = Math.floor(Date.now() / 1000);

  let state = await env.ZENITH_CACHE.get(key, { type: "json" });
  if (!state || typeof state.tokens !== "number") {
    state = { tokens: RL_MAX_TOKENS, last_refill: now };
  }

  // Refill whole tokens for each elapsed interval, carrying the remainder so
  // partial intervals aren't lost.
  const elapsed = Math.max(0, now - state.last_refill);
  const refill = Math.floor(elapsed / RL_REFILL_SECONDS);
  if (refill > 0) {
    state.tokens = Math.min(RL_MAX_TOKENS, state.tokens + refill);
    state.last_refill = state.last_refill + refill * RL_REFILL_SECONDS;
  }

  const allowed = state.tokens >= cost;
  if (allowed) {
    state.tokens -= cost;
  }

  // Seconds until the bucket holds enough tokens to satisfy `cost`.
  const deficit = Math.max(0, cost - state.tokens);
  let reset_in_seconds = 0;
  if (deficit > 0) {
    const untilNextToken = RL_REFILL_SECONDS - (now - state.last_refill);
    reset_in_seconds = untilNextToken + (deficit - 1) * RL_REFILL_SECONDS;
  }

  await env.ZENITH_CACHE.put(key, JSON.stringify(state), {
    expirationTtl: RL_TTL_SECONDS,
  });

  return { allowed, remaining: state.tokens, reset_in_seconds };
}

function rateLimitResponse(rl, message) {
  return json(
    {
      error: "Rate limit exceeded",
      remaining: rl.remaining,
      reset_in_seconds: rl.reset_in_seconds,
      message,
    },
    429,
    { "Retry-After": String(rl.reset_in_seconds) },
  );
}

// The caller identity for metering: prefer the client UUID, fall back to the
// Cloudflare-provided edge IP so anonymous users are still bounded.
function rateLimitKeyFor(request, body) {
  return (
    (body && body.user_id) ||
    request.headers.get("cf-connecting-ip") ||
    "anon"
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (!url.pathname.startsWith(PROXY_PREFIX)) {
      return json({ error: "not found", path: url.pathname }, 404);
    }

    // Feedback is handled at the edge — it writes straight to D1 and never
    // touches the FastAPI origin.
    if (url.pathname === "/api/feedback" && request.method === "POST") {
      return handleFeedback(request, env);
    }

    // plan-ai needs its JSON body enriched with the user's stored feedback
    // before being proxied, so it can't be a transparent stream proxy.
    if (url.pathname === "/api/plan-ai" && request.method === "POST") {
      return handlePlanAi(request, url, env);
    }

    // explain is metered (cheap LLM call) and proxied through after the body
    // is read for the rate-limit key.
    if (url.pathname === "/api/explain" && request.method === "POST") {
      return handleExplain(request, url, env);
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

async function handleFeedback(request, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const { user_id, target_name, rating, note } = body || {};
  if (!user_id || !target_name || typeof rating !== "number") {
    return json({ error: "user_id, target_name and numeric rating required" }, 400);
  }
  try {
    await insertFeedback(env.DB, { user_id, target_name, rating, note });
  } catch (err) {
    return json({ error: "db write failed", detail: String(err) }, 500);
  }
  return json({ ok: true });
}

async function handlePlanAi(request, url, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // Meter the expensive planner call before doing any work.
  const rl = await rateLimit(rateLimitKeyFor(request, body), env, RL_COST["/api/plan-ai"]);
  if (!rl.allowed) {
    return rateLimitResponse(
      rl,
      "Plan generation is limited to 3 requests per 15 minutes.",
    );
  }

  // Inject the user's liked/disliked targets so the planner can use them.
  if (env.DB && body && body.user_id) {
    try {
      const { liked, disliked } = await getFeedback(env.DB, body.user_id);
      body.liked_targets = liked;
      body.disliked_targets = disliked;
    } catch {
      /* feedback enrichment is best-effort, never fatal */
    }
  }

  const backend = (env.BACKEND_URL || "").replace(/\/$/, "");
  if (!backend) return json({ error: "BACKEND_URL not configured" }, 500);

  const upstream = new Request(backend + url.pathname + url.search, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const resp = await fetch(upstream);
    return withCors(resp, { "X-Zenith-Cache": "BYPASS" });
  } catch (err) {
    return json({ error: "backend unreachable", detail: String(err) }, 502);
  }
}

async function handleExplain(request, url, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const rl = await rateLimit(rateLimitKeyFor(request, body), env, RL_COST["/api/explain"]);
  if (!rl.allowed) {
    return rateLimitResponse(
      rl,
      "Follow-up questions are temporarily rate limited. Try again shortly.",
    );
  }

  const backend = (env.BACKEND_URL || "").replace(/\/$/, "");
  if (!backend) return json({ error: "BACKEND_URL not configured" }, 500);

  // Body was consumed to read the rate-limit key, so re-serialize it.
  const upstream = new Request(backend + url.pathname + url.search, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const resp = await fetch(upstream);
    return withCors(resp, { "X-Zenith-Cache": "BYPASS" });
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

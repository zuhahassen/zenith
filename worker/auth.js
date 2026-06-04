/**
 * Magic-link email authentication for Zenith, implemented entirely on the
 * Cloudflare Workers runtime — no third-party auth service.
 *
 * Flow:
 *   1. POST /api/auth/request  { email }
 *        → 32-byte hex token, stored in D1 `auth_tokens` (15-min expiry),
 *          emailed to the user as a one-time sign-in link.
 *   2. GET  /api/auth/verify?token=…
 *        → validates the token (exists, unused, unexpired), marks it used,
 *          creates/fetches the `users` row, returns a signed session JWT.
 *   3. GET  /api/auth/me   (Authorization: Bearer <jwt>)
 *        → verifies the JWT signature + expiry, returns the user record.
 *   4. POST /api/auth/merge  { guest_id, jwt }
 *        → reassigns a guest UUID's history/feedback rows to the signed-in
 *          account so nothing is lost when an anonymous user signs in.
 *
 * JWTs are HS256, signed with the JWT_SECRET Worker secret via WebCrypto.
 * Sessions are stateless; the `sessions` table records each jti so tokens can
 * be revoked in a future iteration (issued tokens are not checked against it
 * yet — expiry alone bounds their lifetime).
 *
 * Each handler returns a plain { status, body } object; worker/index.js wraps
 * it with CORS headers via its json() helper.
 */

const TOKEN_TTL_MS = 15 * 60 * 1000; // magic-link tokens live 15 minutes
const JWT_TTL_SECONDS = 30 * 24 * 60 * 60; // sessions live 30 days
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/request — issue and email a magic link.
 * Always returns a generic success message so the endpoint can't be used to
 * probe which emails have accounts.
 */
export async function handleAuthRequest(db, env, body) {
  const email = normalizeEmail(body && body.email);
  if (!email || !EMAIL_RE.test(email)) {
    return { status: 400, body: { error: "A valid email is required." } };
  }

  const token = randomHex(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO auth_tokens (token, email, expires_at, used)
         VALUES (?, ?, ?, 0)`,
      )
      .bind(token, email, expiresAt)
      .run();
  } catch (err) {
    return { status: 500, body: { error: "Could not create sign-in token.", detail: String(err) } };
  }

  const link = `${appBaseUrl(env)}/auth/verify?token=${token}`;
  await sendMagicLinkEmail(env, email, link); // best-effort; never leaks failures

  return {
    status: 200,
    body: {
      ok: true,
      message: "Check your email — the sign-in link expires in 15 minutes.",
    },
  };
}

/**
 * GET /api/auth/verify?token=… — consume a magic link, return a session JWT.
 */
export async function handleAuthVerify(db, env, token) {
  if (!token) {
    return { status: 400, body: { error: "Missing token." } };
  }

  const row = await db
    .prepare(`SELECT token, email, expires_at, used FROM auth_tokens WHERE token = ?`)
    .bind(token)
    .first();

  if (!row) {
    return { status: 400, body: { error: "Invalid or unknown sign-in link." } };
  }
  if (row.used) {
    return { status: 400, body: { error: "This sign-in link has already been used." } };
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    return { status: 400, body: { error: "This sign-in link has expired. Request a new one." } };
  }

  // Single-use: burn the token immediately, before issuing the session.
  await db.prepare(`UPDATE auth_tokens SET used = 1 WHERE token = ?`).bind(token).run();

  const user = await upsertUser(db, row.email);

  const secret = env.JWT_SECRET;
  if (!secret) {
    return { status: 500, body: { error: "Auth is not configured (JWT_SECRET missing)." } };
  }

  const jti = randomHex(16);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_TTL_SECONDS;
  const jwt = await signJWT({ sub: user.id, email: user.email, jti, iat, exp }, secret);

  // Record the session for future revocation support (best-effort).
  try {
    await db
      .prepare(
        `INSERT INTO sessions (jti, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(jti, user.id, new Date(iat * 1000).toISOString(), new Date(exp * 1000).toISOString())
      .run();
  } catch {
    /* non-fatal: the JWT is valid regardless of the audit row */
  }

  return {
    status: 200,
    body: {
      token: jwt,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    },
  };
}

/**
 * GET /api/auth/me — resolve the bearer token to a user record.
 */
export async function handleAuthMe(db, env, authHeader) {
  const claims = await authenticate(env, authHeader);
  if (!claims) {
    return { status: 401, body: { error: "Not signed in." } };
  }

  // Touch last_seen; tolerate a missing row (token valid but user pruned).
  const user = await db
    .prepare(`SELECT id, email, display_name, created_at FROM users WHERE id = ?`)
    .bind(claims.sub)
    .first();
  if (!user) {
    return { status: 401, body: { error: "Account no longer exists." } };
  }
  await db
    .prepare(`UPDATE users SET last_seen = ? WHERE id = ?`)
    .bind(new Date().toISOString(), claims.sub)
    .run();

  return { status: 200, body: { user } };
}

/**
 * POST /api/auth/merge — reassign a guest UUID's data to the signed-in account.
 * Idempotent: re-running just moves any remaining guest rows.
 */
export async function handleAuthMerge(db, env, body) {
  const guestId = body && body.guest_id;
  const jwt = body && body.jwt;
  if (!guestId || !jwt) {
    return { status: 400, body: { error: "guest_id and jwt are required." } };
  }

  const claims = await verifyJWT(jwt, env.JWT_SECRET);
  if (!claims) {
    return { status: 401, body: { error: "Invalid session token." } };
  }
  if (guestId === claims.sub) {
    return { status: 200, body: { ok: true, merged: 0, note: "guest_id already equals account id" } };
  }

  // Reassign every per-user table that the guest may have written to. Each is
  // best-effort/independent so a missing table never aborts the rest.
  let merged = 0;
  for (const sql of [
    `UPDATE session_summaries SET user_id = ? WHERE user_id = ?`,
    `UPDATE session_history   SET user_id = ? WHERE user_id = ?`,
    `UPDATE target_feedback   SET user_id = ? WHERE user_id = ?`,
  ]) {
    try {
      const res = await db.prepare(sql).bind(claims.sub, guestId).run();
      merged += (res.meta && res.meta.changes) || 0;
    } catch {
      /* table may not exist in every environment; skip */
    }
  }

  return { status: 200, body: { ok: true, merged } };
}

// ---------------------------------------------------------------------------
// Token validation shared with index.js (request enrichment)
// ---------------------------------------------------------------------------

/**
 * Resolve an Authorization header to JWT claims, or null when absent/invalid.
 * Used both by /api/auth/me and by index.js to prefer the authenticated user
 * id over a client-supplied guest UUID.
 */
export async function authenticate(env, authHeader) {
  if (!env || !env.JWT_SECRET) return null;
  const token = bearer(authHeader);
  if (!token) return null;
  return verifyJWT(token, env.JWT_SECRET);
}

function bearer(authHeader) {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// D1 user helpers
// ---------------------------------------------------------------------------

async function upsertUser(db, email) {
  const existing = await db
    .prepare(`SELECT id, email, display_name, created_at FROM users WHERE email = ?`)
    .bind(email)
    .first();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (id, email, created_at, display_name, last_seen)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .bind(id, email, now, now)
    .run();
  return { id, email, display_name: null, created_at: now };
}

// ---------------------------------------------------------------------------
// Email delivery (Cloudflare → MailChannels)
// ---------------------------------------------------------------------------

async function sendMagicLinkEmail(env, email, link) {
  const from = env.EMAIL_FROM || "noreply@zenith.observer";
  const text =
    "Click the link below to sign in. This link expires in 15 minutes and " +
    "can only be used once.\n\n" +
    `${link}\n\n` +
    "If you didn't request this, ignore this email.";

  const payload = {
    personalizations: [{ to: [{ email }] }],
    from: { email: from, name: "Zenith" },
    subject: "Sign in to Zenith",
    content: [{ type: "text/plain", value: text }],
  };

  try {
    const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      // Log only; never surface delivery state to the caller (avoids leaking
      // whether an address exists, and keeps the UX uniform in dev).
      console.warn("magic-link email send failed:", resp.status, await safeText(resp));
    }
  } catch (err) {
    console.warn("magic-link email send threw:", String(err));
  }
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// JWT (HS256) via WebCrypto
// ---------------------------------------------------------------------------

export async function signJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const data = `${encHeader}.${encPayload}`;
  const sig = await hmacSign(data, secret);
  return `${data}.${sig}`;
}

export async function verifyJWT(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, sig] = parts;
  const expected = await hmacSign(`${encHeader}.${encPayload}`, secret);
  if (!timingSafeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encPayload));
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    return null; // expired
  }
  return payload;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlBytes(new Uint8Array(sig));
}

// Constant-time-ish string compare to blunt signature timing oracles.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Encoding utilities
// ---------------------------------------------------------------------------

function randomHex(nBytes) {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

function b64urlBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

function appBaseUrl(env) {
  return (env.APP_BASE_URL || "https://zenith-cja.pages.dev").replace(/\/$/, "");
}

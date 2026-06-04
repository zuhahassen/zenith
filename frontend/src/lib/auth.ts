// Client-side auth state. Sign-in is purely additive: when no JWT is present
// the app runs in guest mode against the anonymous localStorage UUID exactly
// as it always has. A valid JWT simply swaps the identity used for user_id and
// adds an Authorization header to API calls.

const JWT_KEY = "zenith_jwt";
// Same key the app has always used for the anonymous guest id, so guest mode
// is byte-for-byte unchanged and a pre-existing guest keeps their history.
const GUEST_KEY = "zenith_user_id";

interface JwtClaims {
  sub: string;
  email?: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

export function getJWT(): string | null {
  const token = localStorage.getItem(JWT_KEY);
  if (!token) return null;
  // Drop a locally-expired token so the UI falls back to guest mode cleanly.
  const claims = decodeJWT(token);
  if (!claims || (typeof claims.exp === "number" && claims.exp * 1000 < Date.now())) {
    localStorage.removeItem(JWT_KEY);
    return null;
  }
  return token;
}

export function setJWT(token: string): void {
  localStorage.setItem(JWT_KEY, token);
}

export function clearJWT(): void {
  localStorage.removeItem(JWT_KEY);
}

export function isSignedIn(): boolean {
  return getJWT() !== null;
}

// Anonymous guest UUID — created once and persisted. Shared with the legacy
// feedback module so a guest's ratings/history survive across the app.
export function getGuestId(): string {
  let id = localStorage.getItem(GUEST_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(GUEST_KEY, id);
  }
  return id;
}

// The identity every API call should attach as user_id: the signed-in account
// UUID when authenticated, otherwise the anonymous guest id.
export function getUserId(): string {
  const claims = currentClaims();
  return claims?.sub || getGuestId();
}

export function getUserEmail(): string | null {
  return currentClaims()?.email ?? null;
}

// Authorization header to spread into fetch/axios configs. Empty object when
// signed out, so call sites can always spread it unconditionally.
export function authHeaders(): Record<string, string> {
  const token = getJWT();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function currentClaims(): JwtClaims | null {
  const token = getJWT();
  return token ? decodeJWT(token) : null;
}

function decodeJWT(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = b64urlDecode(parts[1]);
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

function b64urlDecode(str: string): string {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  // Decode as UTF-8 so non-ASCII emails survive the round-trip.
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

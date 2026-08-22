import "server-only";

import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * ============================================================================
 * THE SECURITY BOUNDARY
 * ============================================================================
 * This console renders `max_buy` (the rate ceiling the brief says must never
 * be disclosed) and carrier PII, and HappyRobot Apps are served from a PUBLIC
 * URL at https://<slug>.happyrobot.ai. Platform RBAC governs who may *edit* an
 * App; nothing gates the deployed URL. So the App has to gate itself.
 *
 * `requireSession()` / `requireApiSession()` is called as the FIRST STATEMENT
 * of every route handler and every server component that reads data.
 *
 * It is deliberately NOT enforced only in middleware.ts. Next.js middleware is
 * not a security boundary: CVE-2025-29927 let an attacker skip middleware
 * entirely with a crafted `x-middleware-subrequest` header, and any future
 * equivalent would silently expose every screen. middleware.ts here is a
 * convenience redirect and nothing more.
 *
 * SCOPE OF THE CONTROL (say this out loud in the README and the video):
 * this is a shared credential for a scoped review window, not SSO. Production
 * posture is the customer's IdP in front of the App, or HappyRobot workspace
 * auth once Apps expose it to app code.
 * ============================================================================
 */

const COOKIE_NAME = "hr_ops_session";
const SESSION_TTL_S = 8 * 60 * 60; // one shift
const ISSUER = "hr-carrier-ops-console";

export interface Session {
  user: string;
  issuedAt: number;
  expiresAt: number;
}

export class AuthNotConfiguredError extends Error {}

function configuredPassword(): string {
  const pw = process.env.OPS_CONSOLE_PASSWORD;
  if (!pw) {
    throw new AuthNotConfiguredError(
      "OPS_CONSOLE_PASSWORD is not set. The console refuses to serve data without a credential configured.",
    );
  }
  return pw;
}

export function authConfigured(): boolean {
  return Boolean(process.env.OPS_CONSOLE_PASSWORD);
}

export function configuredUser(): string {
  return process.env.OPS_CONSOLE_USER || "ops";
}

/**
 * Signing key for the session cookie. A dedicated OPS_SESSION_SECRET is
 * strongly preferred; when it is absent we derive one from the password so the
 * POC needs a single env var. The derived form means rotating the password
 * also invalidates every live session, which is the behaviour you want anyway.
 */
function signingKey(): Buffer {
  const explicit = process.env.OPS_SESSION_SECRET;
  if (explicit && explicit.length >= 16) {
    return crypto.createHash("sha256").update(explicit).digest();
  }
  return crypto
    .createHash("sha256")
    .update(`${ISSUER}:derived:${configuredPassword()}`)
    .digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function signPayload(payload: string): string {
  return b64url(crypto.createHmac("sha256", signingKey()).update(payload).digest());
}

export function issueToken(user: string): { token: string; maxAge: number } {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    iss: ISSUER,
    sub: user,
    iat: now,
    exp: now + SESSION_TTL_S,
    jti: crypto.randomBytes(9).toString("base64url"),
  });
  const payload = b64url(Buffer.from(body, "utf8"));
  return { token: `${payload}.${signPayload(payload)}`, maxAge: SESSION_TTL_S };
}

function verifyToken(token: string | undefined): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  let expected: string;
  try {
    expected = signPayload(payload);
  } catch {
    return null; // auth not configured -> no session can be valid
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.iss !== ISSUER) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    return { user: claims.sub, issuedAt: claims.iat, expiresAt: claims.exp };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = COOKIE_NAME;

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifyToken(store.get(COOKIE_NAME)?.value);
}

/**
 * For SERVER COMPONENTS. First statement of every page that reads Twin.
 * Redirects to /login when there is no valid session.
 */
export async function requireSession(returnTo?: string): Promise<Session> {
  const session = await getSession();
  if (!session) {
    const next = returnTo ? `?next=${encodeURIComponent(returnTo)}` : "";
    redirect(`/login${next}`);
  }
  return session;
}

/**
 * For ROUTE HANDLERS. First statement of every handler.
 * Returns a 401 Response to return immediately, or null when authorised.
 */
export async function requireApiSession(): Promise<Response | null> {
  const session = await getSession();
  if (session) return null;
  return Response.json(
    { error: "unauthorized", message: "Sign in to the operations console." },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Session realm="hr-ops-console"',
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Credential check + login throttling
// ---------------------------------------------------------------------------

export function checkCredential(user: string, password: string): boolean {
  const expectedUser = configuredUser();
  const expectedPassword = configuredPassword();
  // Hash both sides so timingSafeEqual gets equal-length buffers regardless of
  // the attempted value's length.
  const digest = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();
  const userOk = crypto.timingSafeEqual(digest(user), digest(expectedUser));
  const pwOk = crypto.timingSafeEqual(digest(password), digest(expectedPassword));
  return userOk && pwOk;
}

/**
 * Login throttle, in two layers.
 *
 * LAYER 1 — per client key. Good UX: one careless operator does not lock out
 * the whole team. The key is derived from X-Forwarded-For, which is CLIENT
 * SUPPLIED and therefore SPOOFABLE. Rotating that header defeats layer 1
 * completely, and a locked-out client escapes its own lockout just by
 * prepending a fake hop. So layer 1 is a courtesy, not a control.
 *
 * LAYER 2 — a process-wide floor that no header can move. Every failed attempt
 * counts against it regardless of who claims to have made it, so a header-
 * rotating attacker is capped at GLOBAL_MAX guesses per window rather than
 * being unlimited. This is the layer that actually protects a shared
 * credential on a public URL.
 *
 * ACCEPTED TRADE-OFF: 20 bad guesses from anywhere freeze NEW sign-ins for 15
 * minutes, so an anonymous attacker can deny sign-in. That is deliberate. Live
 * sessions are unaffected — the lockout only guards POST /api/auth/login, never
 * session validation — so an ops manager already signed in keeps working, and a
 * 15-minute sign-in delay is a far cheaper outcome than a guessed shared
 * credential on a public URL that renders max_buy.
 *
 * In-memory on purpose: this is a single-tenant POC console behind one shared
 * credential, and Redis would be more moving parts than the control is worth.
 * The honest limitation — stated in the README — is that a serverless platform
 * may run several instances, so the effective budget is (MAX x instances).
 */
const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_MAX = 6;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Process-wide failure budget per window. Unspoofable: not keyed on anything. */
const GLOBAL_MAX = 20;
const GLOBAL_LOCKOUT_MS = 15 * 60 * 1000;
const GLOBAL_KEY = " global";

interface Bucket {
  failures: number[];
  lockedUntil: number;
}
const buckets = new Map<string, Bucket>();

function bucketFor(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { failures: [], lockedUntil: 0 };
    buckets.set(key, b);
  }
  return b;
}

function sweep() {
  if (buckets.size < 512) return;
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, b] of buckets) {
    if (k === GLOBAL_KEY) continue;
    if (b.lockedUntil < Date.now() && (b.failures.at(-1) ?? 0) < cutoff) {
      buckets.delete(k);
    }
  }
}

/**
 * Best-effort client identity for the per-client layer only. X-Forwarded-For is
 * attacker-controlled — the leading space on GLOBAL_KEY keeps a caller from
 * ever colliding with (and thereby reading or resetting) the global bucket.
 */
export async function clientKey(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0]!.trim() : h.get("x-real-ip") || "unknown";
  return `ip:${ip || "unknown"}`;
}

export interface ThrottleState {
  allowed: boolean;
  retryAfterS: number;
  remaining: number;
}

function checkBucket(key: string, max: number): ThrottleState {
  const b = bucketFor(key);
  const now = Date.now();
  if (b.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterS: Math.ceil((b.lockedUntil - now) / 1000),
      remaining: 0,
    };
  }
  b.failures = b.failures.filter((t) => t > now - WINDOW_MS);
  return { allowed: true, retryAfterS: 0, remaining: Math.max(0, max - b.failures.length) };
}

function failBucket(key: string, max: number, lockoutMs: number, label: string): ThrottleState {
  const b = bucketFor(key);
  const now = Date.now();
  b.failures = b.failures.filter((t) => t > now - WINDOW_MS);
  b.failures.push(now);
  if (b.failures.length >= max) {
    b.lockedUntil = now + lockoutMs;
    b.failures = [];
    console.warn(
      `[ops-console] ${label} login lockout for ${lockoutMs / 60000}m after ${max} failed attempts (${key})`,
    );
    return { allowed: false, retryAfterS: Math.ceil(lockoutMs / 1000), remaining: 0 };
  }
  return { allowed: true, retryAfterS: 0, remaining: Math.max(0, max - b.failures.length) };
}

/** The stricter of the two layers wins. */
function tighter(a: ThrottleState, b: ThrottleState): ThrottleState {
  if (a.allowed && b.allowed) {
    return { allowed: true, retryAfterS: 0, remaining: Math.min(a.remaining, b.remaining) };
  }
  const blocked = !a.allowed ? a : b;
  const other = !a.allowed ? b : a;
  return {
    allowed: false,
    retryAfterS: Math.max(blocked.retryAfterS, other.allowed ? 0 : other.retryAfterS),
    remaining: 0,
  };
}

export function throttleCheck(key: string): ThrottleState {
  sweep();
  // The global bucket is evaluated first and cannot be sidestepped by spoofing
  // X-Forwarded-For, because it is not keyed on anything the caller controls.
  return tighter(checkBucket(GLOBAL_KEY, GLOBAL_MAX), checkBucket(key, WINDOW_MAX));
}

export function throttleFailure(key: string): ThrottleState {
  // Both layers are always charged, so header rotation buys attempts against
  // the per-client budget only — never against the process-wide floor.
  const g = failBucket(GLOBAL_KEY, GLOBAL_MAX, GLOBAL_LOCKOUT_MS, "GLOBAL");
  const c = failBucket(key, WINDOW_MAX, LOCKOUT_MS, "per-client");
  return tighter(g, c);
}

/**
 * A successful sign-in clears that client's bucket. It deliberately does NOT
 * clear the global bucket: knowing the password must not hand an attacker a
 * way to reset the floor that is protecting it.
 */
export function throttleReset(key: string) {
  if (key === GLOBAL_KEY) return;
  buckets.delete(key);
}

/** Constant-ish floor on login latency, so a wrong user is not faster than a wrong password. */
export function loginDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 150)));
}

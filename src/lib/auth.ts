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
 * Per-client login throttle. In-memory on purpose: this is a single-tenant POC
 * console behind one shared credential, and a Redis dependency would be more
 * moving parts than the control is worth. The honest limitation — stated in
 * the README — is that a serverless platform may run several instances, so the
 * effective budget is (WINDOW_MAX x instances). It still turns an unbounded
 * online guessing attack into a slow one, and the lockout is logged.
 */
const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_MAX = 6;
const LOCKOUT_MS = 15 * 60 * 1000;

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
    if (b.lockedUntil < Date.now() && (b.failures.at(-1) ?? 0) < cutoff) {
      buckets.delete(k);
    }
  }
}

export async function clientKey(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0]!.trim() : h.get("x-real-ip") || "unknown";
  return ip || "unknown";
}

export interface ThrottleState {
  allowed: boolean;
  retryAfterS: number;
  remaining: number;
}

export function throttleCheck(key: string): ThrottleState {
  sweep();
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
  return {
    allowed: true,
    retryAfterS: 0,
    remaining: Math.max(0, WINDOW_MAX - b.failures.length),
  };
}

export function throttleFailure(key: string): ThrottleState {
  const b = bucketFor(key);
  const now = Date.now();
  b.failures = b.failures.filter((t) => t > now - WINDOW_MS);
  b.failures.push(now);
  if (b.failures.length >= WINDOW_MAX) {
    b.lockedUntil = now + LOCKOUT_MS;
    b.failures = [];
    console.warn(
      `[ops-console] login lockout for ${LOCKOUT_MS / 60000}m after ${WINDOW_MAX} failed attempts from ${key}`,
    );
    return { allowed: false, retryAfterS: LOCKOUT_MS / 1000, remaining: 0 };
  }
  return {
    allowed: true,
    retryAfterS: 0,
    remaining: Math.max(0, WINDOW_MAX - b.failures.length),
  };
}

export function throttleReset(key: string) {
  buckets.delete(key);
}

/** Constant-ish floor on login latency, so a wrong user is not faster than a wrong password. */
export function loginDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 150)));
}

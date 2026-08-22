import { cookies } from "next/headers";
import {
  AuthNotConfiguredError,
  SESSION_COOKIE,
  authConfigured,
  checkCredential,
  clientKey,
  configuredUser,
  issueToken,
  loginDelay,
  throttleCheck,
  throttleFailure,
  throttleReset,
} from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The one unauthenticated route in the console, by definition. It is throttled
 * per client IP and it never distinguishes a wrong user from a wrong password.
 */
export async function POST(request: Request) {
  if (!authConfigured()) {
    return json(503, {
      error: "not_configured",
      message: "OPS_CONSOLE_PASSWORD is not set on this deployment.",
    });
  }

  const key = await clientKey();
  const state = throttleCheck(key);
  if (!state.allowed) {
    return json(
      429,
      {
        error: "throttled",
        message: `Too many failed attempts. Locked for ${Math.ceil(state.retryAfterS / 60)} more minute(s).`,
      },
      { "Retry-After": String(state.retryAfterS) },
    );
  }

  let body: { user?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "bad_request", message: "Expected a JSON body." });
  }

  const user = typeof body.user === "string" ? body.user : configuredUser();
  const password = typeof body.password === "string" ? body.password : "";

  await loginDelay();

  let ok = false;
  try {
    ok = checkCredential(user, password);
  } catch (err) {
    if (err instanceof AuthNotConfiguredError) {
      return json(503, { error: "not_configured", message: err.message });
    }
    throw err;
  }

  if (!ok) {
    const after = throttleFailure(key);
    return json(
      401,
      {
        error: "invalid_credentials",
        // Deliberately identical for a wrong user and a wrong password.
        message: after.allowed
          ? `Invalid credentials. ${after.remaining} attempt(s) remaining before lockout.`
          : "Invalid credentials. This client is now locked out for 15 minutes.",
      },
      after.allowed ? undefined : { "Retry-After": String(after.retryAfterS) },
    );
  }

  throttleReset(key);
  const { token, maxAge } = issueToken(user);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });

  return json(200, { ok: true, user });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

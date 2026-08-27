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

  // Two content types, deliberately. The JS path sends JSON; a NATIVE form
  // submit — which is what happens whenever the client bundle has not
  // hydrated — sends url-encoded. Accepting only JSON meant the browser fell
  // back to a GET, putting the password in the query string, the address bar
  // and the server log. A login form must not depend on JavaScript to keep
  // the password out of the URL.
  const ctype = request.headers.get("content-type") ?? "";
  const isForm = ctype.includes("application/x-www-form-urlencoded")
    || ctype.includes("multipart/form-data");
  let body: { user?: unknown; password?: unknown; next?: unknown };
  try {
    if (isForm) {
      const form = await request.formData();
      body = {
        user: form.get("user") ?? undefined,
        password: form.get("password") ?? undefined,
        next: form.get("next") ?? undefined,
      };
    } else {
      body = await request.json();
    }
  } catch {
    return json(400, { error: "bad_request", message: "Expected a JSON body." });
  }

  // Same open-redirect guard the login page applies: same-origin paths only.
  const rawNext = typeof body.next === "string" ? body.next : "/";
  const nextPath = rawNext.startsWith("/") && !rawNext.startsWith("//")
    ? rawNext : "/";

  // An absent username is an EMPTY username, never the configured one.
  // Defaulting to configuredUser() here meant `{"password": "..."}` with no
  // user field authenticated: the username check did not fail, it ceased to
  // exist. Verified against the running console — that body returned 200 and
  // a valid session cookie. The password was still required, so this was
  // never an open door, but "omit the field to skip the check" is not a
  // property an auth boundary may have.
  const user = typeof body.user === "string" ? body.user : "";
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
    if (isForm) {
      // Never echo the submitted credentials back into the URL.
      const q = new URLSearchParams({
        next: nextPath,
        error: after.allowed ? "invalid" : "locked",
      });
      return redirectTo(`/login?${q}`);
    }
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

  if (isForm) return redirectTo(nextPath);
  return json(200, { ok: true, user });
}

/** 303 so the browser re-issues as GET and the POST never lands in history. */
function redirectTo(location: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

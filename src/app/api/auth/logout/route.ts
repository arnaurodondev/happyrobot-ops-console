import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Clears the session cookie. Deliberately session-agnostic: signing out with an
 * already-expired cookie must still succeed, so this returns 200 either way.
 *
 * CSRF: the session cookie is SameSite=Lax, so a cross-site POST never carries
 * it and the endpoint discloses nothing. The residual risk is a forced sign-out
 * (a third-party page POSTing here to drop the operator's cookie mid-audit) —
 * annoyance, not disclosure. It is still an attacker-triggered state change on
 * a public URL, and the check below costs four lines, so we take it: a browser
 * request must be same-origin. Non-browser clients (curl, the smoke test) send
 * neither header and are unaffected.
 */
export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  const crossSite = site
    ? site === "cross-site"
    : Boolean(origin) && originHost(origin) !== host;

  if (crossSite) {
    return Response.json(
      { error: "cross_origin", message: "Sign-out must be requested from the console itself." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

function originHost(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

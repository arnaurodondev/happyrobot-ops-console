import { NextResponse, type NextRequest } from "next/server";

/**
 * ⚠️ THIS IS NOT THE SECURITY BOUNDARY. ⚠️
 *
 * Next.js middleware is a routing convenience, not an authorisation layer:
 * CVE-2025-29927 allowed a crafted `x-middleware-subrequest` header to skip
 * middleware entirely on affected versions. Anything that relies on middleware
 * alone is one header away from being public.
 *
 * The real control is `requireSession()` / `requireApiSession()` in
 * src/lib/auth.ts, called as the FIRST STATEMENT of every server component and
 * every route handler that touches data. This file only saves an unauthenticated
 * visitor a round trip to a page that would have redirected them anyway. It
 * checks for the *presence* of a cookie and never validates it — validation is
 * the server-side check's job, and duplicating it here would invite someone to
 * trust this file.
 */

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout", "/api/health"]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const hasCookie = Boolean(request.cookies.get("hr_ops_session")?.value);
  if (hasCookie) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in to the operations console." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

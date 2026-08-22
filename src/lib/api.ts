import "server-only";

import { TwinConfigError, TwinQueryError } from "./twin";

/** Uniform JSON envelope + no-store on every console API response. */
export function ok(body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, {
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export function fail(status: number, error: string, message: string) {
  return Response.json(
    { error, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Maps a Twin failure onto an honest status code and a message an ops manager
 * can act on. Never leaks the query or the API key.
 */
export function twinError(err: unknown) {
  if (err instanceof TwinConfigError) {
    return fail(503, "twin_not_configured", err.message);
  }
  if (err instanceof TwinQueryError) {
    return fail(502, "twin_error", err.message);
  }
  console.error("[ops-console] unexpected error", err);
  return fail(500, "internal_error", "The console hit an unexpected error.");
}

export function searchString(
  params: URLSearchParams,
  key: string,
  fallback = "",
): string {
  const v = params.get(key);
  return v === null ? fallback : v.trim();
}

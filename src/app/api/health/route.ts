export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness only, and deliberately unauthenticated — it is the single route in
 * the console that answers without a session, and it discloses nothing: no
 * row counts, no configuration values, no environment names. Stated here so it
 * reads as a decision rather than an oversight.
 */
export async function GET() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

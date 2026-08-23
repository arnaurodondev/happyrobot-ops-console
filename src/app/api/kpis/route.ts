import { requireApiSession } from "@/lib/auth";
import { fail, ok, searchString, twinError } from "@/lib/api";
import { getDailyTrend, getKpis, getOutcomeMix } from "@/lib/queries";
import { DEFAULT_RANGE, RANGES, isRange } from "@/lib/callParams";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const requested = searchString(params, "range", DEFAULT_RANGE) || DEFAULT_RANGE;
  // rangeClause() falls back to 7d for anything it does not recognise, so
  // echoing the caller's string back would label 7-day numbers as, say, "90d".
  // Reject instead: a mislabelled window is a wrong number, not a cosmetic bug.
  if (!isRange(requested)) {
    return fail(
      400,
      "invalid_range",
      `range must be one of: ${Object.keys(RANGES).join(", ")}.`,
    );
  }
  const range = requested;
  const environment = searchString(params, "environment") || null;

  try {
    const [kpis, mix, trend] = await Promise.all([
      getKpis(range, environment),
      getOutcomeMix(range, environment),
      getDailyTrend(14, environment),
    ]);
    return ok({ range, environment, kpis, outcomeMix: mix, trend, timezone: "UTC" });
  } catch (err) {
    return twinError(err);
  }
}

import { requireApiSession } from "@/lib/auth";
import { ok, searchString, twinError } from "@/lib/api";
import { getDailyTrend, getKpis, getOutcomeMix } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const range = searchString(params, "range", "7d");
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

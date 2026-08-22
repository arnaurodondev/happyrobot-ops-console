import { requireApiSession } from "@/lib/auth";
import { ok, searchString, twinError } from "@/lib/api";
import { getCallLog } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const range = searchString(params, "range", "7d");
  const limit = Number(searchString(params, "limit", "200")) || 200;

  try {
    const result = await getCallLog(
      {
        outcome: searchString(params, "outcome") || null,
        environment: searchString(params, "environment") || null,
        mc: searchString(params, "mc") || null,
        q: searchString(params, "q") || null,
        flagged: searchString(params, "flagged") === "1",
      },
      range,
      limit,
    );
    return ok({ range, timezone: "UTC", ...result });
  } catch (err) {
    return twinError(err);
  }
}

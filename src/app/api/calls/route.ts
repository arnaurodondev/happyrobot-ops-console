import { requireApiSession } from "@/lib/auth";
import { fail, ok, searchString, twinError } from "@/lib/api";
import { getCallLog } from "@/lib/queries";
import { parseCallQuery } from "@/lib/callParams";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const limit = Number(searchString(params, "limit", "200")) || 200;

  // Reject an unknown range/outcome/tms rather than answering a different
  // question under the label the caller sent.
  const { query, invalid } = parseCallQuery(params);
  if (invalid.length) {
    return fail(400, "invalid_filter", `Unrecognised value for: ${invalid.join(", ")}.`);
  }
  const { range } = query;

  try {
    const result = await getCallLog(
      {
        outcome: query.outcome || null,
        environment: query.environment || null,
        mc: query.mc || null,
        q: query.q || null,
        tms: query.tms || null,
        flagged: query.flagged,
      },
      range,
      limit,
    );
    return ok({ range, filters: query, timezone: "UTC", ...result });
  } catch (err) {
    return twinError(err);
  }
}

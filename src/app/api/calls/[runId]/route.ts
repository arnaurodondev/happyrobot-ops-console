import { requireApiSession } from "@/lib/auth";
import { fail, ok, twinError } from "@/lib/api";
import { getCallDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The full audit trail for one run, as JSON. Same data as the detail screen. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const { runId } = await params;
  try {
    const detail = await getCallDetail(runId);
    if (!detail) return fail(404, "not_found", `No call in Twin with run_id ${runId}.`);
    return ok({ timezone: "UTC", ...detail });
  } catch (err) {
    return twinError(err);
  }
}

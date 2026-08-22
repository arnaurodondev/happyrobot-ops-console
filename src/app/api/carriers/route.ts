import { requireApiSession } from "@/lib/auth";
import { ok, searchString, twinError } from "@/lib/api";
import { getCarriers } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  try {
    const carriers = await getCarriers(searchString(params, "q") || null);
    // Carrier email is PII: only the masked form ever leaves the server (§I).
    return ok({ timezone: "UTC", count: carriers.length, carriers });
  } catch (err) {
    return twinError(err);
  }
}

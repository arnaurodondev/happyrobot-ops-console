import { requireApiSession } from "@/lib/auth";
import { searchString, twinError } from "@/lib/api";
import { getCallLog } from "@/lib/queries";
import { csvRow } from "@/lib/format";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADER = [
  "run_id",
  "started_at_utc",
  "ended_at_utc",
  "duration_s",
  "environment",
  "outcome",
  "outcome_reason",
  "mc_number",
  "carrier_legal_name",
  "authority_ok",
  "load_id",
  "lane",
  "equipment_type",
  "posted_rate_usd",
  "max_buy_usd",
  "agreed_rate_usd",
  "agent_rounds",
  "tms_sync_state",
  "ceiling_ok",
  "fraud_signal",
  "ceiling_disclosed",
  "run_dump_present",
  "notes",
];

/**
 * ACTION: export the filtered call log.
 * The customer's stated pain is "no structured record of what was said,
 * offered, or agreed" — this is the record, in a format their ops and finance
 * teams already work in. Read-only; nothing is written back to Twin.
 */
export async function GET(request: Request) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const range = searchString(params, "range", "7d");

  try {
    const { rows } = await getCallLog(
      {
        outcome: searchString(params, "outcome") || null,
        environment: searchString(params, "environment") || null,
        mc: searchString(params, "mc") || null,
        q: searchString(params, "q") || null,
        flagged: searchString(params, "flagged") === "1",
      },
      range,
      500,
    );

    const lines = [csvRow(HEADER)];
    for (const r of rows) {
      lines.push(
        csvRow([
          r.runId,
          r.startedAt ?? "",
          r.endedAt ?? "",
          r.durationS === null ? "" : Math.round(r.durationS),
          r.environment ?? "",
          r.outcome ?? "",
          r.outcomeReason ?? "",
          r.mcNumber ?? "",
          r.legalName ?? "",
          r.authorityOk === null ? "" : r.authorityOk,
          r.loadId ?? "",
          r.lane ?? "",
          r.equipment ?? "",
          r.postedRate ?? "",
          r.maxBuy ?? "",
          r.agreedRate ?? "",
          r.rounds ?? "",
          r.tmsSyncState ?? "",
          r.maxBuy !== null && r.agreedRate !== null ? r.agreedRate <= r.maxBuy : "",
          r.fraudSignal ?? "",
          r.ceilingDisclosed ?? "",
          r.hasDump,
          r.notes ?? "",
        ]),
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(`﻿${lines.join("\r\n")}\r\n`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="carrier-calls-${range}-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return twinError(err);
  }
}

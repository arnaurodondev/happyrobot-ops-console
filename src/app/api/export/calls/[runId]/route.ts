import { requireApiSession } from "@/lib/auth";
import { fail, twinError } from "@/lib/api";
import { getCallDetail } from "@/lib/queries";
import { csvRow } from "@/lib/format";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ACTION: export ONE call's audit trail.
 * This is the artifact an ops manager attaches to a dispute: every event on the
 * run, in order, with the actor, the amount and the UTC timestamp, plus the
 * ceiling-adherence verdict and how it was reached. Read-only.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const denied = await requireApiSession(); // FIRST STATEMENT — see lib/auth.ts
  if (denied) return denied;

  const { runId } = await params;

  try {
    const d = await getCallDetail(runId);
    if (!d) return fail(404, "not_found", `No call in Twin with run_id ${runId}.`);

    const lines: string[] = [];
    const push = (...v: unknown[]) => lines.push(csvRow(v));

    push("section", "timestamp_utc", "actor", "event", "detail", "amount_usd", "outcome");

    push(
      "call",
      d.call.startedAt ?? "",
      "system",
      "call_started",
      `run_id=${d.call.runId} environment=${d.call.environment ?? ""} mc=${d.call.mcNumber ?? ""}`,
      "",
      "",
    );

    for (const v of d.verifications) {
      push(
        "verification",
        v.checkedAt ?? "",
        "fmcsa",
        v.verified ? "authority_verified" : "authority_rejected",
        `mc_as_spoken=${v.mcNumber ?? ""} dot=${v.dotNumber ?? ""} legal_name=${v.legalName ?? ""} status=${v.authorityStatus ?? ""} reason=${v.reason ?? ""}`,
        "",
        v.verified ? "pass" : "fail",
      );
    }

    for (const a of d.otpAttempts) {
      push(
        "otp",
        a.createdAt ?? "",
        a.failureReason === "sent" ? "system" : "carrier",
        a.failureReason === "sent" ? "otp_sent" : `otp_attempt_${a.attemptNo ?? ""}`,
        `channel=${a.channel ?? ""} reason=${a.failureReason ?? ""}`,
        "",
        a.verified ? "verified" : a.failureReason === "sent" ? "sent" : "failed",
      );
    }

    for (const o of d.offers) {
      push(
        "load_offer",
        "",
        "system",
        o.wasPitched ? "load_pitched" : "load_searched",
        `load_id=${o.loadId ?? ""} lane=${o.origin ?? ""} -> ${o.destination ?? ""} equipment=${o.equipmentType ?? ""} posted=${o.postedRate ?? ""} max_buy=${o.maxBuy ?? ""}`,
        o.openingOffer ?? "",
        o.wasPitched ? "pitched" : "not_pitched",
      );
    }

    for (const r of d.rounds) {
      push(
        "negotiation",
        r.createdAt ?? "",
        r.actor ?? "",
        `round_${r.roundNo ?? ""}`,
        `load_id=${r.loadId ?? ""}`,
        r.amount ?? "",
        r.outcome ?? "",
      );
    }

    if (d.booking) {
      push(
        "booking",
        d.booking.bookedAt ?? "",
        "system",
        "booking_written",
        `booking_id=${d.booking.bookingId} load_id=${d.booking.loadId ?? ""} tms_ref=${d.booking.tmsRef ?? ""}`,
        d.booking.agreedRate ?? "",
        d.booking.tmsSyncState ?? "",
      );
    }

    if (d.call.handoffAt || d.call.handoffState) {
      push(
        "handoff",
        d.call.handoffAt ?? "",
        "system",
        "handoff",
        `state=${d.call.handoffState ?? ""}`,
        "",
        d.call.handoffState ?? "",
      );
    }

    push(
      "call",
      d.call.endedAt ?? "",
      "system",
      "call_ended",
      `status=${d.call.status ?? ""} reason=${d.call.outcomeReason ?? ""}`,
      "",
      d.call.outcome ?? "",
    );

    push(
      "ceiling_audit",
      "",
      "console",
      "ceiling_adherence_verdict",
      d.ceiling.reasons.join(" "),
      d.ceiling.maxBuy ?? "",
      d.ceiling.verdict,
    );

    if (d.call.notes) push("notes", "", "agent", "call_notes", d.call.notes, "", "");
    if (d.dump?.notes) push("notes", "", "run_dump", "dump_notes", d.dump.notes, "", "");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(`﻿${lines.join("\r\n")}\r\n`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-trail-${runId}-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return twinError(err);
  }
}

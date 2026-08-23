import "server-only";

import {
  bool,
  count,
  isUuid,
  jsonb,
  num,
  raw,
  sql,
  text,
  twinQuery,
  twinQueryOne,
  utc,
  type TwinRow,
} from "./twin";
import { RANGES as RANGE_SPECS } from "./callParams";

/**
 * Every screen's SQL lives here, in one file, so the read surface of the
 * console is auditable at a glance. Nothing in here writes.
 *
 * Type discipline (measured against the live database, per twin.ts):
 *   int8      -> JSON string, cast with num()/count() before any arithmetic
 *   jsonb     -> already an object, read with jsonb() and never JSON.parse
 *   timestamp -> naive UTC, normalised with utc() and always labelled UTC
 *   call_outcomes.* -> all text, including response_final_rate / _rounds_count
 */

// The filter vocabulary lives in ./callParams (dependency-free so the page, the
// JSON API, the CSV export and the tests all read a request identically).
export { CALL_OUTCOMES, RANGES, TMS_SYNC_STATES } from "./callParams";

/** A call with no ended_at older than this is treated as abandoned (§D note 3). */
const ABANDON_AFTER = raw("interval '30 minutes'");
const NOW_UTC = raw("(now() AT TIME ZONE 'utc')");

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface CallFilters {
  since?: string | null; // ISO instant
  environment?: string | null;
  outcome?: string | null;
  mc?: string | null;
  q?: string | null;
  flagged?: boolean;
  /** Latest booking's tms_sync_state. Filtered in SQL — see callWhere(). */
  tms?: string | null;
}

export function rangeClause(range: string): string {
  const spec = RANGE_SPECS[range] ?? RANGE_SPECS["7d"];
  if (spec.hours === null) return "TRUE";
  if (spec.hours === 0) return `c.started_at >= date_trunc('day', ${NOW_UTC.text})`;
  return `c.started_at >= ${NOW_UTC.text} - interval '${spec.hours} hours'`;
}

/**
 * The two ceiling signals the CONSOLE computes rather than trusting from a
 * column, expressed as a correlated EXISTS on `c.run_id`:
 *
 *   ENFORCEMENT — a booking landed above the load's max_buy.
 *   DISCLOSURE  — an agent quote reached or passed max_buy. Quoting the ceiling
 *                 discloses it to the dollar, so >= is the correct test, not >.
 *
 * Kept as one constant so the flagged filter, the KPI query and the per-call
 * verdict in assessCeiling() can never drift apart. `max_buy` lives only in
 * load_offers.load_snapshot; NULLIF guards the empty-string case.
 */
const MAX_BUY = `NULLIF(lo_c.load_snapshot->>'max_buy','')::bigint`;

const CEILING_BREACH_EXISTS = `EXISTS (
  SELECT 1 FROM bookings bo_c
  JOIN load_offers lo_c ON lo_c.run_id = bo_c.run_id AND lo_c.load_id = bo_c.load_id
  WHERE bo_c.run_id = c.run_id AND bo_c.agreed_rate > ${MAX_BUY}
)`;

const CEILING_QUOTED_EXISTS = `EXISTS (
  SELECT 1 FROM negotiation_rounds nr_c
  JOIN load_offers lo_c ON lo_c.id = nr_c.load_offer_id
  WHERE nr_c.run_id = c.run_id AND nr_c.actor = 'agent' AND nr_c.amount >= ${MAX_BUY}
)`;

const CEILING_SIGNAL_EXISTS = `(${CEILING_BREACH_EXISTS} OR ${CEILING_QUOTED_EXISTS})`;

/** The TMS sync state the call log shows: the run's most recent booking. */
const LATEST_TMS_STATE = `(
  SELECT bo_t.tms_sync_state FROM bookings bo_t
  WHERE bo_t.run_id = c.run_id
  ORDER BY bo_t.booked_at DESC NULLS LAST, bo_t.booking_id DESC LIMIT 1
)`;

function callWhere(f: CallFilters, range: string): string {
  const parts: string[] = [rangeClause(range)];
  if (f.environment) parts.push(sql`c.environment = ${f.environment}`);
  if (f.outcome) parts.push(sql`c.outcome = ${f.outcome}`);
  if (f.mc) parts.push(sql`c.mc_number = ${f.mc}`);
  // TMS sync state is a property of the run's LATEST booking — the same row the
  // table's TMS column renders (CALL_LOG_FROM's `bk` lateral). Expressed as a
  // scalar subquery so the identical predicate works in the row query, the
  // count query and the CSV export. It MUST stay in SQL: narrowing the fetched
  // page client-side would make the "TMS exceptions" export cover rows the
  // operator never saw, and would hide matches beyond the row cap.
  if (f.tms) parts.push(sql`${raw(LATEST_TMS_STATE)} = ${f.tms}`);
  // "Flagged" has to mean every compliance signal the console itself raises,
  // not just the two boolean columns the workflow wrote. A booking above
  // max_buy, or an agent quote that touched the ceiling, is the finding an ops
  // manager clicks "Review flagged" to see — leaving them out made the
  // dashboard's own breach callout link to an empty table.
  if (f.flagged) parts.push(`(c.fraud_signal IS TRUE OR c.ceiling_disclosed IS TRUE OR ${CEILING_SIGNAL_EXISTS})`);
  if (f.q) {
    const like = `%${f.q}%`;
    parts.push(
      sql`(c.mc_number ILIKE ${like} OR c.notes ILIKE ${like} OR c.run_id::text ILIKE ${like} OR cr.legal_name ILIKE ${like} OR lo.load_id ILIKE ${like} OR lo.origin ILIKE ${like} OR lo.destination ILIKE ${like})`,
    );
  }
  return parts.join(" AND ");
}

// ---------------------------------------------------------------------------
// Overview / KPIs
// ---------------------------------------------------------------------------

export interface Kpis {
  callsTotal: number;
  callsToday: number;
  callsEnded: number;
  callsInFlight: number;
  callsAbandoned: number;
  verifTotal: number;
  verifPass: number;
  verifFailed: number;
  otpAttempts: number;
  otpFailed: number;
  otpLockouts: number;
  bookedRuns: number;
  tms: { synced: number; pending: number; failed: number; ambiguous: number };
  avgRounds: number | null;
  negotiatedRuns: number;
  avgAgreed: number | null;
  avgPosted: number | null;
  agreedVsPostedPct: number | null;
  ceilingKnown: number;
  ceilingOk: number;
  ceilingAudited: number;
  ceilingLeaked: number;
  /** Runs where an AGENT quote reached or passed max_buy — the console's own
   *  disclosure test, independent of the Auditor node's opinion. */
  ceilingQuoted: number;
  /** Runs with ANY ceiling signal (booking over the ceiling, or a quote that
   *  touched it, or the Auditor node flagging an indirect disclosure). */
  ceilingSignals: number;
  fraudFlagged: number;
  distinctMcs: number;
  avgDurationS: number | null;
}

export async function getKpis(range: string, environment?: string | null): Promise<Kpis> {
  const where = [rangeClause(range), environment ? sql`c.environment = ${environment}` : "TRUE"].join(
    " AND ",
  );

  const query = `
WITH c AS (
  SELECT * FROM calls c WHERE ${where}
), ve AS (
  SELECT v.* FROM verification_events v JOIN c ON c.run_id = v.run_id
), oa AS (
  SELECT o.* FROM otp_attempts o JOIN c ON c.run_id = o.run_id
), lo AS (
  SELECT l.* FROM load_offers l JOIN c ON c.run_id = l.run_id
), nr AS (
  SELECT n.* FROM negotiation_rounds n JOIN c ON c.run_id = n.run_id
), bk AS (
  SELECT bo.* FROM bookings bo JOIN c ON c.run_id = bo.run_id
), lo1 AS (
  -- One offer row per (run, load). A retried write or a re-search can leave two
  -- load_offers rows for the same load on the same run. Without this, the join
  -- below counts that booking twice, inflating ceiling_known / ceiling_ok and
  -- skewing avg_agreed and avg_agreed_vs_posted. The pitched row wins, then the
  -- earliest — the same precedence the lo lateral in the log query uses.
  -- NB: keep apostrophes, semicolons and write keywords out of SQL comments.
  -- The read-only guard in twin.ts scans the whole statement, comments too.
  SELECT DISTINCT ON (run_id, load_id) *
  FROM lo ORDER BY run_id, load_id, was_pitched DESC NULLS LAST, id ASC
), bk1 AS (
  -- Same defence on the booking side. bookings carries UNIQUE(run_id, load_id)
  -- today, and this query should not be what breaks if that ever changes.
  SELECT DISTINCT ON (run_id, load_id) *
  FROM bk ORDER BY run_id, load_id, booked_at DESC NULLS LAST, booking_id DESC
), ceil AS (
  SELECT bk1.run_id, bk1.agreed_rate, lo1.posted_rate,
         NULLIF(lo1.load_snapshot->>'max_buy','')::bigint AS max_buy
  FROM bk1 JOIN lo1 ON lo1.run_id = bk1.run_id AND lo1.load_id = bk1.load_id
), rpr AS (
  SELECT run_id, max(round_no) FILTER (WHERE actor = 'agent') AS agent_rounds
  FROM nr GROUP BY run_id
), otp_lock AS (
  SELECT run_id FROM oa
  WHERE verified IS NOT TRUE AND failure_reason IS DISTINCT FROM 'sent'
  GROUP BY run_id HAVING count(*) >= 3
)
SELECT
  (SELECT count(*) FROM c) AS calls_total,
  (SELECT count(*) FROM c WHERE started_at >= date_trunc('day', ${NOW_UTC.text})) AS calls_today,
  (SELECT count(*) FROM c WHERE ended_at IS NOT NULL) AS calls_ended,
  (SELECT count(*) FROM c WHERE ended_at IS NULL AND started_at >= ${NOW_UTC.text} - ${ABANDON_AFTER.text}) AS calls_in_flight,
  (SELECT count(*) FROM c WHERE ended_at IS NULL AND started_at <  ${NOW_UTC.text} - ${ABANDON_AFTER.text}) AS calls_abandoned,
  (SELECT count(*) FROM ve) AS verif_total,
  (SELECT count(*) FROM ve WHERE verified IS TRUE) AS verif_pass,
  (SELECT count(*) FROM ve WHERE verified IS NOT TRUE) AS verif_failed,
  (SELECT count(*) FROM oa WHERE failure_reason IS DISTINCT FROM 'sent') AS otp_attempts,
  (SELECT count(*) FROM oa WHERE verified IS NOT TRUE AND failure_reason IS DISTINCT FROM 'sent') AS otp_failed,
  (SELECT count(*) FROM otp_lock) AS otp_lockouts,
  (SELECT count(DISTINCT run_id) FROM bk) AS booked_runs,
  (SELECT count(*) FROM bk1 WHERE tms_sync_state = 'synced') AS tms_synced,
  (SELECT count(*) FROM bk1 WHERE tms_sync_state = 'pending') AS tms_pending,
  (SELECT count(*) FROM bk1 WHERE tms_sync_state = 'failed') AS tms_failed,
  (SELECT count(*) FROM bk1 WHERE tms_sync_state = 'ambiguous') AS tms_ambiguous,
  (SELECT round(avg(agent_rounds), 2) FROM rpr WHERE agent_rounds > 0) AS avg_rounds,
  (SELECT count(*) FROM rpr WHERE agent_rounds > 0) AS negotiated_runs,
  (SELECT round(avg(agreed_rate)) FROM ceil) AS avg_agreed,
  (SELECT round(avg(posted_rate)) FROM ceil WHERE posted_rate IS NOT NULL) AS avg_posted,
  (SELECT round(avg(agreed_rate::numeric / NULLIF(posted_rate,0)) * 100, 1) FROM ceil WHERE posted_rate IS NOT NULL) AS agreed_vs_posted_pct,
  (SELECT count(*) FROM ceil WHERE max_buy IS NOT NULL) AS ceiling_known,
  (SELECT count(*) FROM ceil WHERE max_buy IS NOT NULL AND agreed_rate <= max_buy) AS ceiling_ok,
  (SELECT count(*) FROM c WHERE ceiling_disclosed IS NOT NULL) AS ceiling_audited,
  (SELECT count(*) FROM c WHERE ceiling_disclosed IS TRUE) AS ceiling_leaked,
  (SELECT count(*) FROM c WHERE ${CEILING_QUOTED_EXISTS}) AS ceiling_quoted,
  (SELECT count(*) FROM c WHERE ceiling_disclosed IS TRUE OR ${CEILING_SIGNAL_EXISTS}) AS ceiling_signals,
  (SELECT count(*) FROM c WHERE fraud_signal IS TRUE) AS fraud_flagged,
  (SELECT count(DISTINCT mc_number) FROM c WHERE mc_number IS NOT NULL) AS distinct_mcs,
  (SELECT round(avg(EXTRACT(EPOCH FROM (ended_at - started_at)))) FROM c WHERE ended_at IS NOT NULL) AS avg_duration_s`;

  const r = (await twinQueryOne(query)) ?? {};
  return {
    callsTotal: count(r.calls_total),
    callsToday: count(r.calls_today),
    callsEnded: count(r.calls_ended),
    callsInFlight: count(r.calls_in_flight),
    callsAbandoned: count(r.calls_abandoned),
    verifTotal: count(r.verif_total),
    verifPass: count(r.verif_pass),
    verifFailed: count(r.verif_failed),
    otpAttempts: count(r.otp_attempts),
    otpFailed: count(r.otp_failed),
    otpLockouts: count(r.otp_lockouts),
    bookedRuns: count(r.booked_runs),
    tms: {
      synced: count(r.tms_synced),
      pending: count(r.tms_pending),
      failed: count(r.tms_failed),
      ambiguous: count(r.tms_ambiguous),
    },
    avgRounds: num(r.avg_rounds),
    negotiatedRuns: count(r.negotiated_runs),
    avgAgreed: num(r.avg_agreed),
    avgPosted: num(r.avg_posted),
    agreedVsPostedPct: num(r.agreed_vs_posted_pct),
    ceilingKnown: count(r.ceiling_known),
    ceilingOk: count(r.ceiling_ok),
    ceilingAudited: count(r.ceiling_audited),
    ceilingLeaked: count(r.ceiling_leaked),
    ceilingQuoted: count(r.ceiling_quoted),
    ceilingSignals: count(r.ceiling_signals),
    fraudFlagged: count(r.fraud_flagged),
    distinctMcs: count(r.distinct_mcs),
    avgDurationS: num(r.avg_duration_s),
  };
}

export interface OutcomeSlice {
  outcome: string;
  calls: number;
}

export async function getOutcomeMix(
  range: string,
  environment?: string | null,
): Promise<OutcomeSlice[]> {
  const where = [rangeClause(range), environment ? sql`c.environment = ${environment}` : "TRUE"].join(
    " AND ",
  );
  const { rows } = await twinQuery(`
SELECT COALESCE(c.outcome, 'unclassified') AS outcome, count(*) AS calls
FROM calls c WHERE ${where}
GROUP BY 1 ORDER BY calls DESC`);
  return rows.map((r) => ({ outcome: text(r.outcome) ?? "unclassified", calls: count(r.calls) }));
}

export interface TrendPoint {
  day: string;
  calls: number;
  booked: number;
}

export async function getDailyTrend(
  days: number,
  environment?: string | null,
): Promise<TrendPoint[]> {
  const envClause = environment ? sql`AND c.environment = ${environment}` : "";
  const { rows } = await twinQuery(`
WITH d AS (
  SELECT generate_series(
    date_trunc('day', ${NOW_UTC.text}) - interval '${Math.max(1, Math.min(90, days)) - 1} days',
    date_trunc('day', ${NOW_UTC.text}),
    interval '1 day'
  ) AS day
)
SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       count(c.run_id) AS calls,
       count(c.run_id) FILTER (WHERE c.outcome = 'booked') AS booked
FROM d
LEFT JOIN calls c ON date_trunc('day', c.started_at) = d.day ${envClause}
GROUP BY d.day ORDER BY d.day`);
  return rows.map((r) => ({
    day: text(r.day) ?? "",
    calls: count(r.calls),
    booked: count(r.booked),
  }));
}

export async function getEnvironments(): Promise<string[]> {
  const { rows } = await twinQuery(
    `SELECT DISTINCT environment FROM calls WHERE environment IS NOT NULL ORDER BY 1`,
  );
  return rows.map((r) => text(r.environment)).filter((v): v is string => Boolean(v));
}

// ---------------------------------------------------------------------------
// Call log
// ---------------------------------------------------------------------------

export interface CallLogRow {
  runId: string;
  startedAt: string | null;
  endedAt: string | null;
  durationS: number | null;
  environment: string | null;
  status: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  mcNumber: string | null;
  legalName: string | null;
  authorityOk: boolean | null;
  lane: string | null;
  equipment: string | null;
  loadId: string | null;
  postedRate: number | null;
  maxBuy: number | null;
  agreedRate: number | null;
  tmsSyncState: string | null;
  rounds: number | null;
  fraudSignal: boolean | null;
  ceilingDisclosed: boolean | null;
  /** An agent quote reached or passed max_buy on this run — computed, not trusted. */
  ceilingQuoted: boolean;
  hasDump: boolean;
  notes: string | null;
}

/** Shared projection so the table and the CSV export can never drift. */
const CALL_LOG_SELECT = `
  c.run_id::text            AS run_id,
  c.started_at, c.ended_at, c.environment, c.status,
  c.outcome, c.outcome_reason, c.mc_number, c.notes,
  c.fraud_signal, c.ceiling_disclosed,
  EXTRACT(EPOCH FROM (c.ended_at - c.started_at)) AS duration_s,
  cr.legal_name, cr.authority_ok,
  lo.load_id, lo.origin, lo.destination, lo.equipment_type, lo.posted_rate,
  NULLIF(lo.load_snapshot->>'max_buy','')::bigint AS max_buy,
  bk.agreed_rate, bk.tms_sync_state,
  nr.rounds,
  ${CEILING_QUOTED_EXISTS} AS ceiling_quoted,
  (co.run_id IS NOT NULL) AS has_dump`;

const CALL_LOG_FROM = `
FROM calls c
LEFT JOIN carriers cr ON cr.mc_number = c.mc_number
LEFT JOIN LATERAL (
  SELECT l.* FROM load_offers l
  WHERE l.run_id = c.run_id
  ORDER BY l.was_pitched DESC NULLS LAST, l.id ASC LIMIT 1
) lo ON TRUE
LEFT JOIN LATERAL (
  SELECT bo.* FROM bookings bo WHERE bo.run_id = c.run_id
  ORDER BY bo.booked_at DESC NULLS LAST, bo.booking_id DESC LIMIT 1
) bk ON TRUE
LEFT JOIN LATERAL (
  SELECT max(n.round_no) AS rounds FROM negotiation_rounds n
  WHERE n.run_id = c.run_id AND n.actor = 'agent'
) nr ON TRUE
LEFT JOIN call_outcomes co ON co.run_id = c.run_id::text`;

function mapCallLogRow(r: TwinRow): CallLogRow {
  const origin = text(r.origin);
  const destination = text(r.destination);
  return {
    runId: text(r.run_id) ?? "",
    startedAt: utc(r.started_at),
    endedAt: utc(r.ended_at),
    durationS: num(r.duration_s),
    environment: text(r.environment),
    status: text(r.status),
    outcome: text(r.outcome),
    outcomeReason: text(r.outcome_reason),
    mcNumber: text(r.mc_number),
    legalName: text(r.legal_name),
    authorityOk: bool(r.authority_ok),
    lane: origin && destination ? `${origin} → ${destination}` : origin || destination,
    equipment: text(r.equipment_type),
    loadId: text(r.load_id),
    postedRate: num(r.posted_rate),
    maxBuy: num(r.max_buy),
    agreedRate: num(r.agreed_rate),
    tmsSyncState: text(r.tms_sync_state),
    rounds: num(r.rounds),
    fraudSignal: bool(r.fraud_signal),
    ceilingDisclosed: bool(r.ceiling_disclosed),
    ceilingQuoted: bool(r.ceiling_quoted) ?? false,
    hasDump: bool(r.has_dump) ?? false,
    notes: text(r.notes),
  };
}

export interface CallLogResult {
  rows: CallLogRow[];
  total: number;
  truncated: boolean;
  elapsedMs: number;
}

export async function getCallLog(
  filters: CallFilters,
  range: string,
  limit = 200,
): Promise<CallLogResult> {
  const where = callWhere(filters, range);
  const capped = Math.max(1, Math.min(500, limit));

  const [list, totalRow] = await Promise.all([
    twinQuery(`SELECT ${CALL_LOG_SELECT} ${CALL_LOG_FROM} WHERE ${where}
ORDER BY c.started_at DESC NULLS LAST LIMIT ${capped}`),
    twinQueryOne(`SELECT count(*) AS n
FROM calls c
LEFT JOIN carriers cr ON cr.mc_number = c.mc_number
LEFT JOIN LATERAL (
  SELECT l.* FROM load_offers l WHERE l.run_id = c.run_id
  ORDER BY l.was_pitched DESC NULLS LAST, l.id ASC LIMIT 1
) lo ON TRUE
WHERE ${where}`),
  ]);

  const total = count(totalRow?.n);
  return {
    rows: list.rows.map(mapCallLogRow),
    total,
    truncated: list.truncated || total > list.rows.length,
    elapsedMs: list.elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Call detail — the audit trail
// ---------------------------------------------------------------------------

export interface CallRecord {
  runId: string;
  sessionId: string | null;
  mcNumber: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationS: number | null;
  environment: string | null;
  status: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  notes: string | null;
  handoffAt: string | null;
  handoffState: string | null;
  fraudSignal: boolean | null;
  ceilingDisclosed: boolean | null;
  ceilingAudit: Record<string, unknown> | null;
}

export interface VerificationEvent {
  id: number | null;
  mcNumber: string | null;
  verified: boolean | null;
  reason: string | null;
  dotNumber: string | null;
  legalName: string | null;
  authorityStatus: string | null;
  checkedAt: string | null;
}

export interface OtpAttempt {
  id: number | null;
  attemptNo: number | null;
  channel: string | null;
  verified: boolean | null;
  failureReason: string | null;
  createdAt: string | null;
}

export interface LoadOffer {
  id: number | null;
  loadId: string | null;
  origin: string | null;
  destination: string | null;
  equipmentType: string | null;
  postedRate: number | null;
  openingOffer: number | null;
  maxBuy: number | null;
  wasPitched: boolean | null;
  snapshot: Record<string, unknown> | null;
}

export interface NegotiationRound {
  id: number | null;
  loadOfferId: number | null;
  loadId: string | null;
  roundNo: number | null;
  actor: string | null;
  amount: number | null;
  outcome: string | null;
  createdAt: string | null;
}

export interface BookingRecord {
  bookingId: string;
  loadId: string | null;
  agreedRate: number | null;
  tmsRef: string | null;
  tmsSyncState: string | null;
  bookedAt: string | null;
}

export interface DumpRecord {
  outcome: string | null;
  finalRate: number | null;
  roundsCount: number | null;
  mcNumber: string | null;
  loadId: string | null;
  notes: string | null;
}

export interface CarrierRecord {
  mcNumber: string;
  dotNumber: string | null;
  legalName: string | null;
  authorityOk: boolean | null;
  status: string | null;
  verifiedAt: string | null;
  emailMasked: string | null;
  contactSource: string | null;
}

export type CeilingVerdict = "clean" | "breach" | "unknown";

export interface CeilingAdherence {
  verdict: CeilingVerdict;
  maxBuy: number | null;
  postedRate: number | null;
  agreedRate: number | null;
  headroom: number | null;
  quotedAtOrAboveCeiling: NegotiationRound[];
  highestAgentQuote: number | null;
  highestQuotePctOfCeiling: number | null;
  auditorVerdict: boolean | null;
  reasons: string[];
}

export interface CallDetail {
  call: CallRecord;
  carrier: CarrierRecord | null;
  verifications: VerificationEvent[];
  otpAttempts: OtpAttempt[];
  offers: LoadOffer[];
  rounds: NegotiationRound[];
  booking: BookingRecord | null;
  dump: DumpRecord | null;
  ceiling: CeilingAdherence;
}

export async function getCallDetail(runId: string): Promise<CallDetail | null> {
  if (!isUuid(runId)) return null;

  const callRow = await twinQueryOne(sql`
SELECT c.run_id::text AS run_id, c.session_id::text AS session_id, c.mc_number,
       c.started_at, c.ended_at, c.environment, c.status, c.outcome,
       c.outcome_reason, c.notes, c.handoff_at, c.handoff_state,
       c.fraud_signal, c.ceiling_disclosed, c.ceiling_audit,
       EXTRACT(EPOCH FROM (c.ended_at - c.started_at)) AS duration_s
FROM calls c WHERE c.run_id = ${runId}::uuid`);
  if (!callRow) return null;

  const call: CallRecord = {
    runId: text(callRow.run_id) ?? runId,
    sessionId: text(callRow.session_id),
    mcNumber: text(callRow.mc_number),
    startedAt: utc(callRow.started_at),
    endedAt: utc(callRow.ended_at),
    durationS: num(callRow.duration_s),
    environment: text(callRow.environment),
    status: text(callRow.status),
    outcome: text(callRow.outcome),
    outcomeReason: text(callRow.outcome_reason),
    notes: text(callRow.notes),
    handoffAt: utc(callRow.handoff_at),
    handoffState: text(callRow.handoff_state),
    fraudSignal: bool(callRow.fraud_signal),
    ceilingDisclosed: bool(callRow.ceiling_disclosed),
    ceilingAudit: jsonb(callRow.ceiling_audit),
  };

  const [verifRes, otpRes, offerRes, roundRes, bookRes, dumpRow, carrierRow] = await Promise.all([
    twinQuery(sql`SELECT id, mc_number, verified, reason, dot_number, legal_name,
       authority_status, checked_at
FROM verification_events WHERE run_id = ${runId}::uuid ORDER BY checked_at ASC NULLS LAST, id ASC`),
    twinQuery(sql`SELECT id, attempt_no, channel, verified, failure_reason, created_at
FROM otp_attempts WHERE run_id = ${runId}::uuid ORDER BY created_at ASC NULLS LAST, id ASC`),
    twinQuery(sql`SELECT id, load_id, origin, destination, equipment_type, posted_rate,
       opening_offer, was_pitched, load_snapshot,
       NULLIF(load_snapshot->>'max_buy','')::bigint AS max_buy
FROM load_offers WHERE run_id = ${runId}::uuid
ORDER BY was_pitched DESC NULLS LAST, id ASC`),
    twinQuery(sql`SELECT n.id, n.load_offer_id, n.round_no, n.actor, n.amount, n.outcome,
       n.created_at, l.load_id
FROM negotiation_rounds n
LEFT JOIN load_offers l ON l.id = n.load_offer_id
WHERE n.run_id = ${runId}::uuid
ORDER BY n.created_at ASC NULLS LAST, n.id ASC`),
    twinQuery(sql`SELECT booking_id::text AS booking_id, load_id, agreed_rate, tms_ref,
       tms_sync_state, booked_at
FROM bookings WHERE run_id = ${runId}::uuid ORDER BY booked_at DESC NULLS LAST`),
    twinQueryOne(sql`SELECT response_classification, response_final_rate, response_rounds_count,
       response_mc_number, response_load_id, response_notes
FROM call_outcomes WHERE run_id = ${runId}`),
    call.mcNumber
      ? twinQueryOne(sql`SELECT cr.mc_number, cr.dot_number, cr.legal_name, cr.authority_ok,
       cr.status, cr.verified_at, cc.email_masked, cc.source AS contact_source
FROM carriers cr
LEFT JOIN carrier_contacts cc ON cc.mc_number = cr.mc_number
WHERE cr.mc_number = ${call.mcNumber}`)
      : Promise.resolve(null),
  ]);

  const verifications: VerificationEvent[] = verifRes.rows.map((r) => ({
    id: num(r.id),
    mcNumber: text(r.mc_number),
    verified: bool(r.verified),
    reason: text(r.reason),
    dotNumber: text(r.dot_number),
    legalName: text(r.legal_name),
    authorityStatus: text(r.authority_status),
    checkedAt: utc(r.checked_at),
  }));

  const otpAttempts: OtpAttempt[] = otpRes.rows.map((r) => ({
    id: num(r.id),
    attemptNo: num(r.attempt_no),
    channel: text(r.channel),
    verified: bool(r.verified),
    failureReason: text(r.failure_reason),
    createdAt: utc(r.created_at),
  }));

  const offers: LoadOffer[] = offerRes.rows.map((r) => ({
    id: num(r.id),
    loadId: text(r.load_id),
    origin: text(r.origin),
    destination: text(r.destination),
    equipmentType: text(r.equipment_type),
    postedRate: num(r.posted_rate),
    openingOffer: num(r.opening_offer),
    maxBuy: num(r.max_buy),
    wasPitched: bool(r.was_pitched),
    snapshot: jsonb(r.load_snapshot),
  }));

  const rounds: NegotiationRound[] = roundRes.rows.map((r) => ({
    id: num(r.id),
    loadOfferId: num(r.load_offer_id),
    loadId: text(r.load_id),
    roundNo: num(r.round_no),
    actor: text(r.actor),
    amount: num(r.amount),
    outcome: text(r.outcome),
    createdAt: utc(r.created_at),
  }));

  const bookingRow = bookRes.rows[0];
  const booking: BookingRecord | null = bookingRow
    ? {
        bookingId: text(bookingRow.booking_id) ?? "",
        loadId: text(bookingRow.load_id),
        agreedRate: num(bookingRow.agreed_rate),
        tmsRef: text(bookingRow.tms_ref),
        tmsSyncState: text(bookingRow.tms_sync_state),
        bookedAt: utc(bookingRow.booked_at),
      }
    : null;

  const dump: DumpRecord | null = dumpRow
    ? {
        outcome: text(dumpRow.response_classification),
        // call_outcomes is entirely `text`, including these two. Cast on read.
        finalRate: num(dumpRow.response_final_rate),
        roundsCount: num(dumpRow.response_rounds_count),
        mcNumber: text(dumpRow.response_mc_number),
        loadId: text(dumpRow.response_load_id),
        notes: text(dumpRow.response_notes),
      }
    : null;

  const carrier: CarrierRecord | null = carrierRow
    ? {
        mcNumber: text(carrierRow.mc_number) ?? "",
        dotNumber: text(carrierRow.dot_number),
        legalName: text(carrierRow.legal_name),
        authorityOk: bool(carrierRow.authority_ok),
        status: text(carrierRow.status),
        verifiedAt: utc(carrierRow.verified_at),
        // PII posture: only ever the masked form leaves the server (§I).
        emailMasked: text(carrierRow.email_masked),
        contactSource: text(carrierRow.contact_source),
      }
    : null;

  return {
    call,
    carrier,
    verifications,
    otpAttempts,
    offers,
    rounds,
    booking,
    dump,
    ceiling: assessCeiling(call, offers, rounds, booking),
  };
}

/**
 * The ceiling-adherence verdict, computed here rather than trusted from one
 * column — this is the answer the console has to defend in a dispute.
 *
 * Two independent tests:
 *   1. ENFORCEMENT — was the agreed rate at or below max_buy?
 *   2. DISCLOSURE — did the agent ever quote a number at or above the ceiling?
 *      Quoting max_buy exactly *is* disclosing max_buy, so the ladder must
 *      asymptote to it and never reach it.
 * Plus the native Carrier Sales Auditor node's post-call verdict, shown as a
 * third, independent opinion.
 */
export function assessCeiling(
  call: CallRecord,
  offers: LoadOffer[],
  rounds: NegotiationRound[],
  booking: BookingRecord | null,
): CeilingAdherence {
  const pitched = offers.find((o) => o.wasPitched) ?? offers[0] ?? null;
  const relevant = booking?.loadId
    ? (offers.find((o) => o.loadId === booking.loadId) ?? pitched)
    : pitched;

  const maxBuy = relevant?.maxBuy ?? null;
  const postedRate = relevant?.postedRate ?? null;
  const agreedRate = booking?.agreedRate ?? null;
  const reasons: string[] = [];

  // Only quotes on the load this ceiling belongs to. A run can negotiate two
  // loads with two different max_buys; comparing every quote against one load's
  // ceiling manufactures breaches that never happened.
  const relevantOfferId = relevant?.id ?? null;
  const relevantLoadId = relevant?.loadId ?? null;
  const onRelevantLoad = (r: NegotiationRound) =>
    relevantOfferId === null && relevantLoadId === null
      ? true
      : (relevantOfferId !== null && r.loadOfferId === relevantOfferId) ||
        (relevantLoadId !== null && r.loadId === relevantLoadId);

  const agentQuotes = rounds.filter(
    (r) => r.actor === "agent" && r.amount !== null && onRelevantLoad(r),
  );
  const highestAgentQuote = agentQuotes.length
    ? Math.max(...agentQuotes.map((r) => r.amount as number))
    : null;

  const quotedAtOrAbove =
    maxBuy !== null ? agentQuotes.filter((r) => (r.amount as number) >= maxBuy) : [];

  let verdict: CeilingVerdict = "unknown";
  if (maxBuy === null) {
    reasons.push(
      "No max_buy on the load snapshot for this run — the ceiling cannot be reconstructed from Twin.",
    );
  } else {
    verdict = "clean";
    if (agreedRate !== null && agreedRate > maxBuy) {
      verdict = "breach";
      reasons.push(
        `Agreed rate exceeds the ceiling by $${(agreedRate - maxBuy).toLocaleString("en-US")}.`,
      );
    }
    if (quotedAtOrAbove.length) {
      verdict = "breach";
      reasons.push(
        `The agent quoted at or above the ceiling in ${quotedAtOrAbove.length} round(s) — quoting max_buy discloses it to the dollar.`,
      );
    }
    if (verdict === "clean") {
      reasons.push(
        agreedRate !== null
          ? "Agreed rate is at or under the ceiling, and no agent offer reached it."
          : "No booking on this run; no agent offer reached the ceiling.",
      );
    }
  }

  if (call.ceilingDisclosed === true) {
    verdict = "breach";
    reasons.push("The post-call Carrier Sales Auditor flagged an indirect ceiling disclosure.");
  }

  return {
    verdict,
    maxBuy,
    postedRate,
    agreedRate,
    headroom: maxBuy !== null && agreedRate !== null ? maxBuy - agreedRate : null,
    quotedAtOrAboveCeiling: quotedAtOrAbove,
    highestAgentQuote,
    highestQuotePctOfCeiling:
      maxBuy !== null && maxBuy > 0 && highestAgentQuote !== null
        ? Math.round((highestAgentQuote / maxBuy) * 1000) / 10
        : null,
    auditorVerdict: call.ceilingDisclosed,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

export interface CarrierSummary extends CarrierRecord {
  calls: number;
  bookings: number;
  lastCallAt: string | null;
  failedVerifications: number;
  otpFailures: number;
  avgAgreedRate: number | null;
  fraudSignals: number;
}

/**
 * The per-MC rollup, driven by a *set of MC numbers* rather than by the
 * `carriers` table. Two callers share it:
 *
 *   getCarriers()       — every MC in the carrier master (capped at 500)
 *   getCarrierSummary() — exactly one MC, resolved in the database
 *
 * Driving off the MC, with `carriers` LEFT JOINed, means an MC that was spoken
 * on a call but never landed in the master (a not-found FMCSA lookup writes no
 * snapshot) still gets REAL call, booking and risk counts instead of a
 * synthesised row of zeroes.
 */
function carrierSummarySql(mcSource: string, tail = ""): string {
  return `
SELECT m.mc_number, cr.dot_number, cr.legal_name, cr.authority_ok, cr.status,
       cr.verified_at, cc.email_masked, cc.source AS contact_source,
       (cr.mc_number IS NOT NULL)    AS in_master,
       COALESCE(s.calls, 0)          AS calls,
       COALESCE(s.bookings, 0)       AS bookings,
       COALESCE(s.fraud_signals, 0)  AS fraud_signals,
       s.last_call_at,
       COALESCE(v.failed, 0)         AS failed_verifications,
       COALESCE(o.failed, 0)         AS otp_failures,
       s.avg_agreed_rate
FROM ${mcSource} m
LEFT JOIN carriers cr ON cr.mc_number = m.mc_number
LEFT JOIN carrier_contacts cc ON cc.mc_number = m.mc_number
LEFT JOIN LATERAL (
  -- DISTINCT throughout: this is a LEFT JOIN, so a run with two bookings would
  -- otherwise be counted as two calls and two fraud signals.
  SELECT count(DISTINCT c.run_id) AS calls,
         max(c.started_at) AS last_call_at,
         count(DISTINCT c.run_id) FILTER (WHERE c.fraud_signal IS TRUE) AS fraud_signals,
         count(DISTINCT bo.booking_id) AS bookings,
         round(avg(bo.agreed_rate)) AS avg_agreed_rate
  FROM calls c LEFT JOIN bookings bo ON bo.run_id = c.run_id
  WHERE c.mc_number = m.mc_number
) s ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS failed FROM verification_events ve
  WHERE ve.mc_number = m.mc_number AND ve.verified IS NOT TRUE
) v ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS failed FROM otp_attempts oa
  JOIN calls c2 ON c2.run_id = oa.run_id
  WHERE c2.mc_number = m.mc_number AND oa.verified IS NOT TRUE
    AND oa.failure_reason IS DISTINCT FROM 'sent'
) o ON TRUE
${tail}`;
}

function mapCarrierSummary(r: TwinRow): CarrierSummary {
  return {
    mcNumber: text(r.mc_number) ?? "",
    dotNumber: text(r.dot_number),
    legalName: text(r.legal_name),
    authorityOk: bool(r.authority_ok),
    status: text(r.status),
    verifiedAt: utc(r.verified_at),
    emailMasked: text(r.email_masked),
    contactSource: text(r.contact_source),
    calls: count(r.calls),
    bookings: count(r.bookings),
    lastCallAt: utc(r.last_call_at),
    failedVerifications: count(r.failed_verifications),
    otpFailures: count(r.otp_failures),
    avgAgreedRate: num(r.avg_agreed_rate),
    fraudSignals: count(r.fraud_signals),
  };
}

export async function getCarriers(q?: string | null): Promise<CarrierSummary[]> {
  const filter = q
    ? sql`WHERE (cr0.mc_number ILIKE ${`%${q}%`} OR cr0.legal_name ILIKE ${`%${q}%`} OR cr0.dot_number ILIKE ${`%${q}%`})`
    : "";
  const { rows } = await twinQuery(
    carrierSummarySql(
      `(SELECT cr0.mc_number FROM carriers cr0 ${filter})`,
      `ORDER BY s.last_call_at DESC NULLS LAST, m.mc_number ASC
LIMIT 500`,
    ),
  );
  return rows.map(mapCarrierSummary);
}

/**
 * One carrier, resolved in SQL. Returns null only when the MC is absent from
 * the carrier master AND has no calls, bookings, verifications or OTP attempts
 * — i.e. genuinely unknown. It never scans a capped list and never invents a
 * zero for a carrier that simply sorted past a row limit.
 */
export async function getCarrierSummary(
  mc: string,
): Promise<{ summary: CarrierSummary; known: boolean } | null> {
  const row = await twinQueryOne(carrierSummarySql(sql`(SELECT ${mc}::text AS mc_number)`));
  if (!row) return null; // a one-row VALUES source: only a Twin fault gets here
  const summary = mapCarrierSummary({ ...row, mc_number: mc });
  const known =
    bool(row.in_master) === true ||
    summary.calls > 0 ||
    summary.bookings > 0 ||
    summary.failedVerifications > 0 ||
    summary.otpFailures > 0;
  return { summary, known };
}

export interface CarrierDetail {
  carrier: CarrierSummary;
  calls: CallLogRow[];
  verifications: (VerificationEvent & { runId: string })[];
}

export async function getCarrierDetail(mc: string): Promise<CarrierDetail | null> {
  // Resolve the ONE carrier in the database. Scanning a 500-row list and
  // falling back to a synthesised record reported "0 bookings" for any carrier
  // past the cap — a wrong number, which is worse than a missing screen.
  const [summary, callRes, verifRes] = await Promise.all([
    getCarrierSummary(mc),
    twinQuery(`SELECT ${CALL_LOG_SELECT} ${CALL_LOG_FROM} WHERE ${sql`c.mc_number = ${mc}`}
ORDER BY c.started_at DESC NULLS LAST LIMIT 200`),
    twinQuery(sql`SELECT ve.id, ve.run_id::text AS run_id, ve.mc_number, ve.verified, ve.reason,
       ve.dot_number, ve.legal_name, ve.authority_status, ve.checked_at
FROM verification_events ve WHERE ve.mc_number = ${mc}
ORDER BY ve.checked_at DESC NULLS LAST LIMIT 100`),
  ]);

  // Not-found is a state, not a row of zeroes: nothing in the master, no calls,
  // no verifications. The page renders its own not-found for null.
  if (!summary || (!summary.known && !callRes.rows.length && !verifRes.rows.length)) return null;

  return {
    // A carrier can appear in verification_events (MC as spoken) without ever
    // landing in `carriers` — a not-found MC never gets an FMCSA snapshot. The
    // rollups below are still measured, not assumed: carrierSummarySql() drives
    // off the MC and LEFT JOINs the master.
    carrier: summary.summary,
    calls: callRes.rows.map(mapCallLogRow),
    verifications: verifRes.rows.map((r) => ({
      runId: text(r.run_id) ?? "",
      id: num(r.id),
      mcNumber: text(r.mc_number),
      verified: bool(r.verified),
      reason: text(r.reason),
      dotNumber: text(r.dot_number),
      legalName: text(r.legal_name),
      authorityStatus: text(r.authority_status),
      checkedAt: utc(r.checked_at),
    })),
  };
}

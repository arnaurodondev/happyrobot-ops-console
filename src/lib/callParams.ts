/**
 * Call-log filter vocabulary and URL <-> filter marshalling.
 *
 * Deliberately dependency-free (no `server-only`, no Twin import) for two
 * reasons:
 *   1. the page, the JSON API and the CSV export must read a request the SAME
 *      way — a filter that narrows the screen but not the export produces a
 *      silently wrong compliance artifact;
 *   2. it can be exercised by `npm test` without a database or a server.
 *
 * REGRESSION GUARD: `exportParams()` is derived from the same parsed filter
 * object the query runs on, so a new filter cannot be added to the screen and
 * forgotten in the export. See scripts/test-call-params.mjs.
 */

export const CALL_OUTCOMES = [
  "booked",
  "negotiation_failed",
  "not_verified",
  "otp_failed",
  "no_loads",
  "abandoned",
  "error",
] as const;

/** Written by the adapter's booking service (see adapter/app/services/booking.py). */
export const TMS_SYNC_STATES = ["pending", "synced", "failed", "ambiguous"] as const;

export const RANGES: Record<string, { label: string; hours: number | null }> = {
  today: { label: "Today (UTC)", hours: 0 },
  "24h": { label: "Last 24 hours", hours: 24 },
  "7d": { label: "Last 7 days", hours: 24 * 7 },
  "30d": { label: "Last 30 days", hours: 24 * 30 },
  all: { label: "All time", hours: null },
};

export const DEFAULT_RANGE = "7d";

export function isRange(v: string): boolean {
  return Object.prototype.hasOwnProperty.call(RANGES, v);
}

export function isOutcome(v: string): boolean {
  return (CALL_OUTCOMES as readonly string[]).includes(v);
}

export function isTmsState(v: string): boolean {
  return (TMS_SYNC_STATES as readonly string[]).includes(v);
}

/** Every narrowing the call log understands, in one place. */
export interface CallQuery {
  range: string;
  outcome: string;
  environment: string;
  q: string;
  mc: string;
  flagged: boolean;
  /** Latest booking's tms_sync_state. Applied in SQL, not over the fetched page. */
  tms: string;
}

const EMPTY_QUERY: CallQuery = {
  range: DEFAULT_RANGE,
  outcome: "",
  environment: "",
  q: "",
  mc: "",
  flagged: false,
  tms: "",
};

/**
 * Parses a request's search params into a CallQuery, silently dropping values
 * outside the allowed vocabulary (`invalid` reports what was dropped, so an API
 * handler can reject instead of quietly answering a different question).
 */
export function parseCallQuery(params: {
  get(key: string): string | null;
}): { query: CallQuery; invalid: string[] } {
  const str = (k: string) => (params.get(k) ?? "").trim();
  const invalid: string[] = [];

  const rangeRaw = str("range");
  const range = !rangeRaw ? DEFAULT_RANGE : isRange(rangeRaw) ? rangeRaw : (invalid.push("range"), DEFAULT_RANGE);

  const outcomeRaw = str("outcome");
  const outcome = !outcomeRaw ? "" : isOutcome(outcomeRaw) ? outcomeRaw : (invalid.push("outcome"), "");

  const tmsRaw = str("tms");
  const tms = !tmsRaw ? "" : isTmsState(tmsRaw) ? tmsRaw : (invalid.push("tms"), "");

  return {
    query: {
      ...EMPTY_QUERY,
      range,
      outcome,
      tms,
      environment: str("environment"),
      q: str("q"),
      mc: str("mc"),
      flagged: str("flagged") === "1",
    },
    invalid,
  };
}

/**
 * The query string the CSV export must be fetched with. Built from the SAME
 * object the on-screen query used, so the export can never cover a wider set of
 * rows than the table above it.
 */
export function exportParams(query: CallQuery): URLSearchParams {
  const out = new URLSearchParams();
  const pairs: [string, string][] = [
    ["range", query.range],
    ["outcome", query.outcome],
    ["environment", query.environment],
    ["q", query.q],
    ["mc", query.mc],
    ["tms", query.tms],
    ["flagged", query.flagged ? "1" : ""],
  ];
  for (const [k, v] of pairs) if (v) out.set(k, v);
  return out;
}

/** True when anything narrows the default view (drives the empty-state copy). */
export function hasFilters(query: CallQuery): boolean {
  return Boolean(
    query.outcome || query.environment || query.q || query.mc || query.flagged || query.tms,
  ) || query.range !== DEFAULT_RANGE;
}

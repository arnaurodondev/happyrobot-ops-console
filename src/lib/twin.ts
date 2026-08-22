import "server-only";

/**
 * Twin data access — SERVER ONLY. This module must never be imported from a
 * client component; the `server-only` import above turns that into a build
 * error rather than a security incident.
 *
 * WHY NOT THE TWIN GATEWAY:
 *   The gateway (`NEXT_PUBLIC_TWIN_GATEWAY`) authenticates on a bare
 *   `x-org-id` header, and that value is inlined into the client bundle. It is
 *   also a thin PostgREST-style reflection: no joins, no aggregates. Every
 *   screen in this console is a join or an aggregate, so we go through
 *   `POST /api/v2/twin/sql` on the platform API with an org API key held in a
 *   server-only env var (TWIN_API_KEY — deliberately NOT NEXT_PUBLIC_*).
 *
 * READ-ONLY BY CONSTRUCTION:
 *   `assertReadOnly` rejects anything that is not a single SELECT/WITH
 *   statement before it leaves this process. The console never writes to Twin.
 *
 * PLATFORM CAPS (documented + verified): 20 s timeout, 500 rows, 1 MB response.
 */

const DEFAULT_PLATFORM_URL = "https://platform.happyrobot.ai";

/** Twin's documented SELECT caps. Mirrored here so callers can show them. */
export const TWIN_LIMITS = {
  timeoutMs: 20_000,
  maxRows: 500,
  maxResponseBytes: 1_000_000,
} as const;

export class TwinConfigError extends Error {}
export class TwinQueryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function platformBase(): string {
  const raw = (process.env.HR_PLATFORM_URL || DEFAULT_PLATFORM_URL).trim();
  return raw.replace(/\/+$/, "");
}

function apiKey(): string {
  // Server-only. Never NEXT_PUBLIC_*. Never logged, never returned to a client.
  const key = process.env.TWIN_API_KEY || process.env.HR_API_KEY;
  if (!key) {
    throw new TwinConfigError(
      "TWIN_API_KEY is not set. The console cannot reach Twin without a server-side org API key.",
    );
  }
  return key;
}

/** True when the console is configured well enough to attempt a query. */
export function twinConfigured(): boolean {
  return Boolean(process.env.TWIN_API_KEY || process.env.HR_API_KEY);
}

// ---------------------------------------------------------------------------
// SQL literal escaping.
//
// POST /twin/sql takes {sql: string} and nothing else — there is no bind-
// parameter channel. So every interpolation goes through the tagged template
// below, which escapes on the way in. Nothing else in this codebase is allowed
// to build a query by concatenation.
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** A pre-escaped SQL fragment. The only way to inject raw SQL on purpose. */
export class RawSql {
  constructor(readonly text: string) {}
}
/** Use ONLY with compile-time-constant strings, never with request input. */
export function raw(text: string): RawSql {
  return new RawSql(text);
}

type SqlValue = string | number | boolean | null | undefined | RawSql;

function literal(v: SqlValue): string {
  if (v instanceof RawSql) return v.text;
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new TwinQueryError("Refusing to interpolate a non-finite number");
    }
    return String(v);
  }
  // Postgres runs with standard_conforming_strings=on, so a backslash is a
  // literal backslash and doubling the quote is sufficient. NULs are stripped
  // because Postgres text cannot hold them at all.
  const cleaned = v.replace(/\u0000/g, "");
  return `'${cleaned.replace(/'/g, "''")}'`;
}

/** Tagged template that escapes every interpolation. `sql\`... ${value} ...\`` */
export function sql(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += literal(values[i]) + strings[i + 1];
  }
  return out;
}

/** Joins pre-built fragments with a separator (e.g. WHERE clauses). */
export function join(parts: string[], sep = " AND "): RawSql {
  return new RawSql(parts.join(sep));
}

const READ_ONLY_RE = /^\s*(select|with)\b/i;
const FORBIDDEN_RE =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|vacuum|call|do|refresh)\b/i;

function assertReadOnly(query: string) {
  if (!READ_ONLY_RE.test(query)) {
    throw new TwinQueryError("Only SELECT/WITH statements are permitted");
  }
  // Strip string literals before the keyword scan so a carrier note containing
  // the word "update" cannot trip the guard.
  const withoutLiterals = query.replace(/'(?:[^']|'')*'/g, "''");
  if (FORBIDDEN_RE.test(withoutLiterals)) {
    throw new TwinQueryError("Refusing a statement containing a write keyword");
  }
  if (withoutLiterals.includes(";")) {
    throw new TwinQueryError("Refusing a multi-statement query");
  }
}

// ---------------------------------------------------------------------------
// Row typing. Measured against the live database, not assumed:
//   int8      -> JSON *string*  ("2400")            -> must be cast on read
//   jsonb     -> a real JSON object                 -> must NOT be JSON.parse'd
//   boolean   -> a real JSON boolean
//   timestamp -> naive UTC, rendered with a cosmetic ".000Z"
//   call_outcomes.* -> every column is text, including logically numeric ones
// ---------------------------------------------------------------------------

export type TwinRow = Record<string, unknown>;

/** int8 / numeric / text-numeric -> number. Returns null when absent. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** int8 -> number with a floor of 0 for counters. */
export function count(v: unknown): number {
  return num(v) ?? 0;
}

export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length ? s : null;
}

export function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "t" || s === "1") return true;
  if (s === "false" || s === "f" || s === "0") return false;
  return null;
}

/** jsonb comes back as an object already. Only parse when it is a string. */
export function jsonb(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Twin `timestamp` is `timestamp WITHOUT time zone` holding naive UTC. The
 * trailing ".000Z" is cosmetic. We normalise to a real UTC ISO instant so the
 * UI can format it, and every rendered timestamp is labelled UTC.
 */
export function utc(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const normalised = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const d = new Date(normalised.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------

export interface TwinResult<T extends TwinRow = TwinRow> {
  rows: T[];
  truncated: boolean;
  truncationReason: string | null;
  elapsedMs: number;
}

interface TwinSqlResponse {
  command?: string;
  rowCount?: number | null;
  rows?: TwinRow[];
  truncated?: boolean;
  truncationReason?: string | null;
  message?: string;
  error?: string;
  detail?: string;
}

/**
 * Runs one read-only statement against Twin.
 * Throws TwinConfigError (misconfiguration) or TwinQueryError (everything
 * else). Neither carries the API key.
 */
export async function twinQuery<T extends TwinRow = TwinRow>(
  query: string,
): Promise<TwinResult<T>> {
  assertReadOnly(query);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TWIN_LIMITS.timeoutMs + 2_000);

  let res: Response;
  try {
    res = await fetch(`${platformBase()}/api/v2/twin/sql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ sql: query }),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof TwinConfigError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new TwinQueryError(
      aborted
        ? `Twin did not respond within ${TWIN_LIMITS.timeoutMs / 1000}s.`
        : "Could not reach the Twin SQL endpoint.",
    );
  }
  clearTimeout(timer);

  const bodyText = await res.text();
  let body: TwinSqlResponse = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as TwinSqlResponse) : {};
  } catch {
    /* fall through to the status-based message */
  }

  if (!res.ok) {
    const detail = body.message || body.error || body.detail;
    throw new TwinQueryError(
      // Deliberately does not echo the query: a Postgres error string can
      // contain row values, and this message reaches the browser.
      detail
        ? `Twin rejected the query (${res.status}): ${detail}`
        : `Twin rejected the query (HTTP ${res.status}).`,
      res.status,
    );
  }

  return {
    rows: (body.rows ?? []) as T[],
    truncated: Boolean(body.truncated),
    truncationReason: body.truncationReason ?? null,
    elapsedMs: Date.now() - started,
  };
}

/** Convenience for aggregate queries that always return exactly one row. */
export async function twinQueryOne<T extends TwinRow = TwinRow>(
  query: string,
): Promise<T | null> {
  const { rows } = await twinQuery<T>(query);
  return rows[0] ?? null;
}

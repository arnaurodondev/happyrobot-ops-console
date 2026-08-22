/**
 * Formatting. Shared by server and client components, so no `server-only`.
 *
 * TIMESTAMPS ARE UTC AND ARE ALWAYS LABELLED UTC. Twin stores naive UTC in a
 * `timestamp WITHOUT time zone`; rendering it in the viewer's local zone would
 * silently shift every call time by the browser's offset, which is exactly the
 * bug the schema notes warn about. We format in UTC, on purpose, every time.
 */

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const NUM = new Intl.NumberFormat("en-US");

const DATETIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

export const EMPTY = "—";

/** Money in Twin is int8 WHOLE DOLLARS. No cents anywhere in this schema. */
export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return MONEY.format(v);
}

export function integer(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return NUM.format(v);
}

export function decimal(v: number | null | undefined, places = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return v.toFixed(places);
}

export function percent(v: number | null | undefined, places = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return `${v.toFixed(places)}%`;
}

/** ratio(part, whole) -> percentage, or null when the denominator is 0. */
export function ratio(part: number, whole: number): number | null {
  if (!whole) return null;
  return (part / whole) * 100;
}

export function dateTimeUtc(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY;
  return `${DATETIME.format(d).replace(",", "")} UTC`;
}

export function dateUtc(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? EMPTY : DATE.format(d);
}

export function timeUtc(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? EMPTY : TIME.format(d);
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EMPTY;
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m ? `${m}m ${String(rem).padStart(2, "0")}s` : `${rem}s`;
}

/** "3 min ago" — for recency only, never as the authoritative timestamp. */
export function relative(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return EMPTY;
  const diff = Math.round((Date.now() - t) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Freight/compliance acronyms that must not be Title-Cased into nonsense. */
const ACRONYMS = new Set([
  "OTP", "TMS", "MC", "DOT", "FMCSA", "ID", "SMS", "ETA", "PO", "BOL", "USDOT",
]);
const LOWER_WORDS = new Set(["of", "to", "in", "on", "at", "the", "a", "an", "and", "or"]);

/** snake_case -> Title Case, for enum-ish columns written by the workflow. */
export function humanise(v: string | null | undefined): string {
  if (!v) return EMPTY;
  const words = v.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().split(" ");
  return words
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      if (i > 0 && LOWER_WORDS.has(w.toLowerCase())) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

export function shortId(v: string | null | undefined, len = 8): string {
  if (!v) return EMPTY;
  return v.length <= len ? v : `${v.slice(0, len)}…`;
}

// --- CSV -------------------------------------------------------------------

/**
 * RFC 4180 escaping, with a leading apostrophe on anything a spreadsheet would
 * treat as a formula. Carrier speech reaches call_outcomes.notes and calls.notes
 * through post-call extraction, so an exported row is untrusted text.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

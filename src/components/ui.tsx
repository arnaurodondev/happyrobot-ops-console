import type { ReactNode } from "react";
import { EMPTY, humanise, integer, percent } from "@/lib/format";

/**
 * Presentation primitives.
 *
 * EVERY value rendered here goes through JSX text interpolation, which React
 * HTML-escapes. `dangerouslySetInnerHTML` appears nowhere in this codebase and
 * must not: carrier speech reaches `call_outcomes.notes` and `calls.notes` via
 * post-call extraction, so Twin text is untrusted input.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "mute" | "accent";

export function Pill({
  tone = "mute",
  children,
  small,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  small?: boolean;
  title?: string;
}) {
  return (
    <span className={`pill ${tone}${small ? " sm" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  tight,
  id,
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  id?: string;
}) {
  return (
    <section className="card" id={id}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {subtitle && <span className="hint muted" style={{ fontSize: 11.5 }}>{subtitle}</span>}
          <span className="spacer" />
          {actions}
        </header>
      )}
      <div className={`card-body${tight ? " tight" : ""}`}>{children}</div>
    </section>
  );
}

export function SectionHead({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {hint && <span className="hint">{hint}</span>}
      <span className="spacer" />
      {actions}
    </div>
  );
}

export function Kpi({
  label,
  value,
  sub,
  tone,
  fill,
  target,
  small,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ok" | "warn" | "bad";
  /** 0..100 — draws the progress rule under the value */
  fill?: number | null;
  target?: string;
  small?: boolean;
}) {
  const cls = tone ? ` is-${tone}` : "";
  return (
    <div className={`kpi${cls}`}>
      <div className="kpi-label">
        <span>{label}</span>
        {target && (
          <span className="dim" style={{ fontSize: 9.5, letterSpacing: 0 }}>
            {target}
          </span>
        )}
      </div>
      <div className={`kpi-value${small ? " sm" : ""}`}>{value}</div>
      <div className="kpi-sub">{sub}</div>
      {fill !== null && fill !== undefined && (
        <div className="kpi-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, fill))}%` }} />
        </div>
      )}
    </div>
  );
}

export function Empty({
  glyph = "∅",
  title,
  children,
  action,
}: {
  glyph?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="glyph" aria-hidden="true">
        {glyph}
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

export function Callout({
  tone = "info",
  icon,
  title,
  children,
}: {
  tone?: Tone;
  icon?: string;
  title?: string;
  children?: ReactNode;
}) {
  const glyph =
    icon ?? { ok: "✓", warn: "!", bad: "✕", info: "i", mute: "·", accent: "•" }[tone];
  return (
    <div className={`callout ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      <span className="icon" aria-hidden="true">
        {glyph}
      </span>
      <div style={{ minWidth: 0 }}>
        {title && <div className="strong">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/** An error state that says what broke and what to do, not "something went wrong". */
export function ErrorState({
  title,
  detail,
  hint,
}: {
  title: string;
  detail?: string | null;
  hint?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="glyph" aria-hidden="true" style={{ color: "var(--bad)" }}>
        ⚠
      </div>
      <h3>{title}</h3>
      {detail && (
        <p className="mono" style={{ fontSize: 11.5, color: "var(--bad)" }}>
          {detail}
        </p>
      )}
      {hint && <p>{hint}</p>}
    </div>
  );
}

// --- domain-specific badges ------------------------------------------------

const OUTCOME_TONE: Record<string, Tone> = {
  booked: "ok",
  negotiation_failed: "warn",
  no_loads: "mute",
  not_verified: "bad",
  otp_failed: "bad",
  abandoned: "warn",
  error: "bad",
  unclassified: "mute",
};

export const OUTCOME_COLOR: Record<string, string> = {
  booked: "#067647",
  negotiation_failed: "#b54708",
  no_loads: "#97a0b5",
  not_verified: "#b42318",
  otp_failed: "#8f1c14",
  abandoned: "#d0a24c",
  error: "#6b2318",
  unclassified: "#c3c9d4",
};

export function outcomeTone(outcome: string | null | undefined): Tone {
  return OUTCOME_TONE[outcome ?? ""] ?? "mute";
}

export function OutcomePill({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <Pill tone="mute">Unclassified</Pill>;
  return <Pill tone={outcomeTone(outcome)}>{humanise(outcome)}</Pill>;
}

export function TmsPill({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="dim">{EMPTY}</span>;
  const tone: Tone =
    state === "synced" ? "ok" : state === "ambiguous" ? "bad" : state === "failed" ? "bad" : "warn";
  return (
    <Pill tone={tone} title={state === "ambiguous" ? "Never auto-retried — resolve manually" : undefined}>
      {humanise(state)}
    </Pill>
  );
}

export function BoolPill({
  value,
  yes,
  no,
  unknown = "Not recorded",
  invert,
}: {
  value: boolean | null | undefined;
  yes: string;
  no: string;
  unknown?: string;
  /** true when `true` is the bad outcome (e.g. ceiling_disclosed) */
  invert?: boolean;
}) {
  if (value === null || value === undefined) return <Pill tone="mute">{unknown}</Pill>;
  const good = invert ? !value : value;
  return <Pill tone={good ? "ok" : "bad"}>{value ? yes : no}</Pill>;
}

export function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <div className="kpi-label">{label}</div>
      <div className="mono strong" style={{ fontSize: 15 }}>
        {value}
      </div>
      {hint && <div className="dim" style={{ fontSize: 11 }}>{hint}</div>}
    </div>
  );
}

/** Denominator-aware rate, so "100%" of nothing never reads as a green light. */
export function RateValue({ part, whole }: { part: number; whole: number }) {
  if (!whole) return <>{EMPTY}</>;
  return <>{percent((part / whole) * 100)}</>;
}

export function OutcomeMixBar({
  slices,
  total,
}: {
  slices: { outcome: string; calls: number }[];
  total: number;
}) {
  if (!total) return null;
  return (
    <>
      <div className="mixbar" role="img" aria-label="Outcome mix">
        {slices.map((s) => (
          <span
            key={s.outcome}
            style={{
              width: `${(s.calls / total) * 100}%`,
              background: OUTCOME_COLOR[s.outcome] ?? "#c3c9d4",
            }}
            title={`${humanise(s.outcome)}: ${s.calls}`}
          />
        ))}
      </div>
      <div className="mixlegend">
        {slices.map((s) => (
          <div key={s.outcome} style={{ minWidth: 148 }}>
            <span
              className="swatch"
              style={{ background: OUTCOME_COLOR[s.outcome] ?? "#c3c9d4" }}
            />
            <span>{humanise(s.outcome)}</span>
            <span className="n">
              {integer(s.calls)} · {percent((s.calls / total) * 100, 0)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function Sparkline({
  points,
}: {
  points: { day: string; calls: number; booked: number }[];
}) {
  const max = Math.max(1, ...points.map((p) => p.calls));
  return (
    <>
      <div className="spark" role="img" aria-label="Calls per day, last 14 days (UTC)">
        {points.map((p) => {
          const h = (p.calls / max) * 100;
          const bookedShare = p.calls ? (p.booked / p.calls) * h : 0;
          return (
            <div
              key={p.day}
              className="spark-col"
              title={`${p.day} (UTC) — ${p.calls} call(s), ${p.booked} booked`}
            >
              <div className="spark-bar booked" style={{ height: `${bookedShare}%` }} />
              <div className="spark-bar" style={{ height: `${Math.max(0, h - bookedShare)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="spark-axis">
        <span>{points[0]?.day ?? ""}</span>
        <span className="dim">calls / booked · UTC days</span>
        <span>{points.at(-1)?.day ?? ""}</span>
      </div>
    </>
  );
}

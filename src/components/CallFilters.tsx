"use client";

import { useRef } from "react";
import { humanise } from "@/lib/format";

/**
 * A plain GET form. Filters live in the URL, so any view an ops manager builds
 * is a link they can paste into a dispute thread. Selects auto-submit; the
 * page still works with JavaScript disabled because the submit button is real.
 */
export default function CallFilters({
  range,
  outcome,
  environment,
  q,
  flagged,
  environments,
  outcomes,
  exportHref,
}: {
  range: string;
  outcome: string;
  environment: string;
  q: string;
  flagged: boolean;
  environments: string[];
  outcomes: readonly string[];
  exportHref: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const submit = () => formRef.current?.requestSubmit();

  return (
    <form className="toolbar" method="get" action="/calls" ref={formRef}>
      <div className="field grow">
        <label htmlFor="f-q">Search</label>
        <input
          id="f-q"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="MC, carrier, load ID, lane, run ID, notes…"
          autoComplete="off"
        />
      </div>

      <div className="field" style={{ width: 150 }}>
        <label htmlFor="f-range">Window</label>
        <select id="f-range" name="range" defaultValue={range} onChange={submit}>
          <option value="today">Today (UTC)</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
      </div>

      <div className="field" style={{ width: 170 }}>
        <label htmlFor="f-outcome">Outcome</label>
        <select id="f-outcome" name="outcome" defaultValue={outcome} onChange={submit}>
          <option value="">All outcomes</option>
          {outcomes.map((o) => (
            <option key={o} value={o}>
              {humanise(o)}
            </option>
          ))}
        </select>
      </div>

      <div className="field" style={{ width: 130 }}>
        <label htmlFor="f-env">Environment</label>
        <select id="f-env" name="environment" defaultValue={environment} onChange={submit}>
          <option value="">All</option>
          {environments.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>

      <div className="field" style={{ width: 132 }}>
        <label htmlFor="f-flag">Compliance</label>
        <select id="f-flag" name="flagged" defaultValue={flagged ? "1" : ""} onChange={submit}>
          <option value="">All calls</option>
          <option value="1">Flagged only</option>
        </select>
      </div>

      <button type="submit" className="btn primary">
        Apply
      </button>
      <a className="btn" href="/calls">
        Reset
      </a>
      <a
        className="btn"
        href={exportHref}
        title="Download the filtered call log as CSV (RFC 4180, formula-escaped)"
      >
        Export CSV
      </a>
    </form>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { describeError } from "@/lib/errors";
import { getCallLog, getEnvironments, type CallLogRow } from "@/lib/queries";
import {
  CALL_OUTCOMES,
  RANGES,
  exportParams,
  hasFilters,
  parseCallQuery,
} from "@/lib/callParams";
import {
  Empty,
  ErrorState,
  OutcomePill,
  Pill,
  TmsPill,
} from "@/components/ui";
import TopBar from "@/components/TopBar";
import CallFilters from "@/components/CallFilters";
import { RefreshButton } from "@/components/Actions";
import {
  EMPTY,
  dateTimeUtc,
  duration,
  humanise,
  integer,
  money,
  relative,
  shortId,
} from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Call log" };

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession("/calls"); // FIRST STATEMENT — see lib/auth.ts

  const params = await searchParams;
  const raw = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") raw.set(k, v);
    else if (Array.isArray(v) && v.length) raw.set(k, v[0]);
  }

  // One parse for the screen, the export link and the SQL. Every narrowing —
  // including `tms` — is applied in the WHERE clause, so the table, the count
  // and the CSV always describe the same set of rows.
  const { query } = parseCallQuery(raw);
  const { range, outcome, environment, q, mc, flagged, tms } = query;
  const exportHref = `/api/export/calls?${exportParams(query).toString()}`;

  let result: Awaited<ReturnType<typeof getCallLog>> | null = null;
  let environments: string[] = [];
  let error: ReturnType<typeof describeError> | null = null;

  try {
    [result, environments] = await Promise.all([
      getCallLog(
        {
          outcome: outcome || null,
          environment: environment || null,
          mc: mc || null,
          q: q || null,
          tms: tms || null,
          flagged,
        },
        range,
        200,
      ),
      getEnvironments(),
    ]);
  } catch (err) {
    error = describeError(err);
  }

  const rows = result?.rows ?? [];
  const filtered = hasFilters(query);

  return (
    <>
      <TopBar
        title="Call log"
        crumb={
          result
            ? `${integer(rows.length)} of ${integer(result.total)} matching call(s) · ${RANGES[range]?.label}`
            : undefined
        }
        actions={
          <>
            {result && (
              <span className="dim mono" style={{ fontSize: 10.5 }}>
                {result.elapsedMs} ms
              </span>
            )}
            <RefreshButton />
          </>
        }
      />

      <div className="content">
        <CallFilters
          range={range}
          outcome={outcome}
          environment={environment}
          q={q}
          flagged={flagged}
          environments={environments}
          outcomes={CALL_OUTCOMES}
          mc={mc}
          tms={tms}
          exportHref={exportHref}
        />

        {(mc || tms) && (
          <div className="row tight" style={{ marginBottom: 10 }}>
            <span className="dim">Additional filter:</span>
            {mc && (
              <Link className="chip" href={`/calls?range=${range}`}>
                MC {mc} ✕
              </Link>
            )}
            {tms && (
              <Link className="chip" href={`/calls?range=${range}`}>
                TMS {humanise(tms)} ✕
              </Link>
            )}
          </div>
        )}

        <div className="card">
          {error ? (
            <ErrorState title={error.title} detail={error.detail} hint={error.hint} />
          ) : !rows.length ? (
            <Empty
              glyph="◎"
              title={filtered ? "No calls match these filters" : "No calls recorded yet"}
              action={
                filtered ? (
                  <Link className="btn" href="/calls?range=all">
                    Clear filters and widen to all time
                  </Link>
                ) : null
              }
            >
              {filtered
                ? "Try widening the time window or clearing the outcome filter. The console reads only the Twin system of record, so nothing is hidden behind a second data source."
                : "The Twin calls table is empty for this window. Rows appear here as soon as the voice workflow's Write-to-Twin node opens a call."}
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <CallTable rows={rows} range={range} />
              </div>
              {result?.truncated && (
                <div
                  className="callout warn"
                  style={{ margin: 12, borderRadius: 6 }}
                >
                  <span className="icon">!</span>
                  <div>
                    Showing the {integer(rows.length)} most recent of{" "}
                    {integer(result.total)} matching calls. Twin caps a single query at
                    500 rows / 1 MB / 20 s — narrow the window or add a filter to see
                    the rest.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function CallTable({ rows, range }: { rows: CallLogRow[]; range: string }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Started (UTC)</th>
          <th>Run</th>
          <th>MC / carrier</th>
          <th>Lane / load</th>
          <th>Outcome</th>
          <th className="num">Posted</th>
          <th className="num">Agreed</th>
          <th className="num">Rds</th>
          <th>TMS</th>
          <th className="num">Duration</th>
          <th>Flags</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const overCeiling =
            r.maxBuy !== null && r.agreedRate !== null && r.agreedRate > r.maxBuy;
          const flagged = r.fraudSignal || r.ceilingDisclosed || overCeiling;
          return (
            <tr key={r.runId} className={flagged ? "flagged" : undefined}>
              <td className="nowrap">
                <Link href={`/calls/${r.runId}`}>{dateTimeUtc(r.startedAt)}</Link>
                <div className="dim" style={{ fontSize: 11 }}>
                  {relative(r.startedAt)}
                  {r.environment ? ` · ${r.environment}` : ""}
                </div>
              </td>
              <td className="mono dim" style={{ fontSize: 11 }} title={r.runId}>
                {shortId(r.runId)}
              </td>
              <td>
                {r.mcNumber ? (
                  <Link className="mono" href={`/carriers/${encodeURIComponent(r.mcNumber)}`}>
                    {r.mcNumber}
                  </Link>
                ) : (
                  <span className="dim">{EMPTY}</span>
                )}
                <div className="muted">
                  {r.legalName ?? <span className="dim">Not in carrier master</span>}
                </div>
              </td>
              <td>
                {r.lane ?? <span className="dim">{EMPTY}</span>}
                <div className="dim mono" style={{ fontSize: 11 }}>
                  {r.loadId ?? ""}
                  {r.equipment ? ` · ${r.equipment}` : ""}
                </div>
              </td>
              <td>
                <OutcomePill outcome={r.outcome} />
                {r.outcomeReason && (
                  <div className="dim" style={{ fontSize: 11 }}>
                    {humanise(r.outcomeReason)}
                  </div>
                )}
              </td>
              <td className="num muted">{money(r.postedRate)}</td>
              <td className="num strong">{money(r.agreedRate)}</td>
              <td className="num">{r.rounds ?? EMPTY}</td>
              <td>
                <TmsPill state={r.tmsSyncState} />
              </td>
              <td className="num">{duration(r.durationS)}</td>
              <td>
                <span className="tag-list">
                  {r.fraudSignal && (
                    <Pill tone="bad" small title="Three failed OTP codes on this call">
                      Fraud
                    </Pill>
                  )}
                  {r.ceilingDisclosed && (
                    <Pill tone="bad" small>
                      Ceiling leak
                    </Pill>
                  )}
                  {overCeiling && (
                    <Pill tone="bad" small title="Agreed rate above max_buy">
                      Over ceiling
                    </Pill>
                  )}
                  {r.authorityOk === false && (
                    <Pill tone="warn" small>
                      Authority
                    </Pill>
                  )}
                  {!r.hasDump && r.outcome && r.outcome !== "abandoned" && (
                    <Pill tone="mute" small title="No call_outcomes row — the run dump skips failed runs">
                      No dump
                    </Pill>
                  )}
                </span>
              </td>
              <td className="right nowrap">
                <Link className="btn sm" href={`/calls/${r.runId}?range=${range}`}>
                  Audit
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

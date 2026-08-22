import Link from "next/link";
import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import {
  RANGES,
  getCallLog,
  getDailyTrend,
  getEnvironments,
  getKpis,
  getOutcomeMix,
  type Kpis,
} from "@/lib/queries";
import { describeError } from "@/lib/errors";
import {
  Callout,
  Card,
  ErrorState,
  Empty,
  Kpi,
  OutcomeMixBar,
  OutcomePill,
  Pill,
  SectionHead,
  Sparkline,
  TmsPill,
} from "@/components/ui";
import TopBar from "@/components/TopBar";
import RangeChips from "@/components/RangeChips";
import { RefreshButton } from "@/components/Actions";
import {
  EMPTY,
  dateTimeUtc,
  duration,
  integer,
  money,
  percent,
  ratio,
  relative,
  decimal,
} from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession("/"); // FIRST STATEMENT — see lib/auth.ts

  const params = await searchParams;
  const range = pick(params.range, Object.keys(RANGES), "7d");
  const environment = typeof params.environment === "string" ? params.environment : "";

  let data: {
    kpis: Kpis;
    mix: Awaited<ReturnType<typeof getOutcomeMix>>;
    trend: Awaited<ReturnType<typeof getDailyTrend>>;
    recent: Awaited<ReturnType<typeof getCallLog>>;
    environments: string[];
  } | null = null;
  let error: { title: string; detail: string; hint: string } | null = null;

  try {
    const [kpis, mix, trend, recent, environments] = await Promise.all([
      getKpis(range, environment || null),
      getOutcomeMix(range, environment || null),
      getDailyTrend(14, environment || null),
      getCallLog({ environment: environment || null }, range, 8),
      getEnvironments(),
    ]);
    data = { kpis, mix, trend, recent, environments };
  } catch (err) {
    error = describeError(err);
  }

  return (
    <>
      <TopBar
        title="Overview"
        crumb={RANGES[range]?.label}
        actions={<RefreshButton />}
      />
      <div className="content">
        <div className="row" style={{ marginBottom: 14 }}>
          <RangeChips active={range} basePath="/" extra={{ environment }} />
          <span style={{ flex: 1 }} />
          {data && data.environments.length > 1 && (
            <div className="chips">
              <Link
                className="chip"
                href={`/?range=${range}`}
                aria-current={!environment ? "true" : undefined}
              >
                All environments
              </Link>
              {data.environments.map((e) => (
                <Link
                  key={e}
                  className="chip"
                  href={`/?range=${range}&environment=${encodeURIComponent(e)}`}
                  aria-current={environment === e ? "true" : undefined}
                >
                  {e}
                </Link>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="card">
            <ErrorState title={error.title} detail={error.detail} hint={error.hint} />
          </div>
        )}

        {data && data.kpis.callsTotal === 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <Empty
              glyph="◎"
              title="No calls in this window"
              action={
                range === "all" ? null : (
                  <Link className="btn" href="/?range=all">
                    Widen to all time
                  </Link>
                )
              }
            >
              Nothing has been written to the Twin <code>calls</code> table for{" "}
              {RANGES[range]?.label.toLowerCase()}
              {environment ? ` in environment “${environment}”` : ""}. The console reads
              only the Twin system of record — it never falls back to platform run logs —
              so an empty window here means no runs were recorded, not that a query failed.
            </Empty>
          </div>
        )}

        {data && data.kpis.callsTotal > 0 && (
          <>
            <KpiRow kpis={data.kpis} />

            <div className="section" style={{ marginTop: 14 }}>
              <SectionHead
                title="Compliance & fraud"
                hint="The controls the brief calls out as hard requirements"
              />
              <ComplianceBlock kpis={data.kpis} range={range} />
            </div>

            <div className="cols two section">
              <Card title="Outcome mix" subtitle={RANGES[range]?.label}>
                <OutcomeMixBar slices={data.mix} total={data.kpis.callsTotal} />
              </Card>
              <Card title="Call volume" subtitle="Last 14 UTC days">
                <Sparkline points={data.trend} />
              </Card>
            </div>

            <div className="section">
              <SectionHead
                title="Latest calls"
                actions={
                  <Link className="btn sm" href={`/calls?range=${range}`}>
                    Open call log
                  </Link>
                }
              />
              <div className="card">
                <div className="table-wrap">
                  <RecentTable rows={data.recent.rows} />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function KpiRow({ kpis: k }: { kpis: Kpis }) {
  const verifRate = ratio(k.verifPass, k.verifTotal);
  const otpFailRate = ratio(k.otpFailed, k.otpAttempts);
  const conversion = ratio(k.bookedRuns, k.callsTotal);
  const adherence = ratio(k.ceilingOk, k.ceilingKnown);

  return (
    <div className="kpi-grid">
      <Kpi
        label="Calls in window"
        value={integer(k.callsTotal)}
        sub={
          <>
            {integer(k.callsToday)} today · {integer(k.distinctMcs)} distinct MCs
          </>
        }
        fill={null}
      />
      <Kpi
        label="Booking conversion"
        value={conversion === null ? EMPTY : percent(conversion, 0)}
        sub={`${integer(k.bookedRuns)} of ${integer(k.callsTotal)} calls booked`}
        tone={conversion === null ? undefined : conversion >= 35 ? "ok" : conversion >= 20 ? "warn" : "bad"}
        fill={conversion}
      />
      <Kpi
        label="Verification pass rate"
        value={verifRate === null ? EMPTY : percent(verifRate, 0)}
        sub={
          k.verifTotal
            ? `${integer(k.verifFailed)} FMCSA rejection(s) of ${integer(k.verifTotal)}`
            : "No FMCSA checks recorded"
        }
        tone={verifRate === null ? undefined : verifRate >= 80 ? "ok" : "warn"}
        fill={verifRate}
      />
      <Kpi
        label="OTP failure rate"
        value={otpFailRate === null ? EMPTY : percent(otpFailRate, 0)}
        sub={
          k.otpAttempts
            ? `${integer(k.otpFailed)} failed of ${integer(k.otpAttempts)} verify attempts`
            : "No OTP attempts recorded"
        }
        tone={otpFailRate === null ? undefined : otpFailRate <= 15 ? "ok" : otpFailRate <= 30 ? "warn" : "bad"}
        fill={otpFailRate}
      />
      <Kpi
        label="Rate-ceiling adherence"
        target="target 100%"
        value={adherence === null ? EMPTY : percent(adherence, 0)}
        sub={
          k.ceilingKnown
            ? `${integer(k.ceilingOk)} of ${integer(k.ceilingKnown)} bookings at or under max_buy${
                k.ceilingQuoted > 0
                  ? ` · ${integer(k.ceilingQuoted)} call(s) quoted the ceiling`
                  : ""
              }`
            : "No booking has a reconstructable ceiling"
        }
        // The headline percentage is the ENFORCEMENT test (agreed <= max_buy).
        // DISCLOSURE is a separate failure with no natural denominator, so it
        // cannot move the number — but it must never leave this tile green,
        // otherwise the overview contradicts the per-call verdict below it.
        tone={
          k.ceilingQuoted > 0 || k.ceilingLeaked > 0
            ? "bad"
            : adherence === null
              ? undefined
              : adherence >= 100
                ? "ok"
                : "bad"
        }
        fill={adherence}
      />
      <Kpi
        label="Avg negotiation rounds"
        target="cap 3"
        value={k.avgRounds === null ? EMPTY : decimal(k.avgRounds, 2)}
        sub={`${integer(k.negotiatedRuns)} call(s) reached negotiation`}
        tone={k.avgRounds === null ? undefined : k.avgRounds <= 3 ? "ok" : "bad"}
        fill={k.avgRounds === null ? null : (k.avgRounds / 3) * 100}
        small
      />
      <Kpi
        label="Agreed vs posted"
        value={k.agreedVsPostedPct === null ? EMPTY : percent(k.agreedVsPostedPct, 1)}
        sub={
          k.avgAgreed === null
            ? "No bookings with a posted rate"
            : `avg ${money(k.avgAgreed)} agreed · ${money(k.avgPosted)} posted`
        }
        fill={k.agreedVsPostedPct}
        small
      />
      <Kpi
        label="Avg call duration"
        value={k.avgDurationS === null ? EMPTY : duration(k.avgDurationS)}
        sub={`${integer(k.callsEnded)} completed · ${integer(k.callsAbandoned)} abandoned`}
        fill={null}
        small
      />
    </div>
  );
}

function ComplianceBlock({ kpis: k, range }: { kpis: Kpis; range: string }) {
  const breaches = k.ceilingKnown - k.ceilingOk;
  const anySignal =
    breaches > 0 ||
    k.ceilingQuoted > 0 ||
    k.ceilingLeaked > 0 ||
    k.fraudFlagged > 0 ||
    k.tms.ambiguous > 0;

  return (
    <div className="cols two">
      <Card title="Rate ceiling" subtitle="max_rate must be enforced and never disclosed">
        <div className="stack">
          {breaches > 0 ? (
            <Callout tone="bad" title={`${breaches} booking(s) above max_buy`}>
              A booked rate exceeded the ceiling reconstructed from the load snapshot.
              This is the brief&rsquo;s auto-fail condition — open each call and check
              the negotiation ladder.
            </Callout>
          ) : k.ceilingKnown > 0 ? (
            <Callout tone="ok" title="Every booking is at or under the ceiling">
              {integer(k.ceilingOk)} of {integer(k.ceilingKnown)} bookings verified
              against <code>load_offers.load_snapshot → max_buy</code>, the only place
              the ceiling is stored.
            </Callout>
          ) : (
            <Callout tone="mute" title="No ceiling to check yet">
              No booking in this window has a <code>max_buy</code> on its load snapshot.
            </Callout>
          )}

          {k.ceilingQuoted > 0 && (
            <Callout
              tone="bad"
              title={`${integer(k.ceilingQuoted)} call(s) where the agent quoted at or above the ceiling`}
            >
              Quoting <code>max_buy</code> discloses it to the dollar, whatever the call
              eventually booked at. The ladder must asymptote to the ceiling and never
              reach it.
            </Callout>
          )}

          <table className="kv">
            <tbody>
              <tr>
                <th>Disclosure — quoted ceiling</th>
                <td>
                  {k.ceilingQuoted > 0 ? (
                    <Pill tone="bad">{integer(k.ceilingQuoted)} call(s)</Pill>
                  ) : (
                    <Pill tone="ok">Never reached</Pill>
                  )}
                  <span className="muted">
                    {" "}
                    · computed here from <code>negotiation_rounds</code>, not trusted
                    from a column
                  </span>
                </td>
              </tr>
              <tr>
                <th>Disclosure — Auditor node</th>
                <td>
                  {k.ceilingAudited === 0 ? (
                    <Pill tone="mute">Not run on any call</Pill>
                  ) : k.ceilingLeaked > 0 ? (
                    <Pill tone="bad">{integer(k.ceilingLeaked)} flagged disclosure(s)</Pill>
                  ) : (
                    <Pill tone="ok">Clean on {integer(k.ceilingAudited)} audited call(s)</Pill>
                  )}
                  <span className="muted"> · indirect disclosure in the transcript</span>
                </td>
              </tr>
              <tr>
                <th>Round cap (3)</th>
                <td>
                  {k.avgRounds !== null && k.avgRounds > 3 ? (
                    <Pill tone="bad">Average above the cap</Pill>
                  ) : (
                    <Pill tone="ok">Held</Pill>
                  )}{" "}
                  <span className="muted">
                    avg {k.avgRounds === null ? EMPTY : decimal(k.avgRounds, 2)} over{" "}
                    {integer(k.negotiatedRuns)} negotiated call(s)
                  </span>
                </td>
              </tr>
              <tr>
                <th>Margin</th>
                <td className="muted">
                  {k.avgAgreed === null
                    ? "No bookings yet"
                    : `${money(k.avgAgreed)} average agreed against ${money(k.avgPosted)} posted (${percent(k.agreedVsPostedPct, 1)})`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Fraud & exceptions"
        actions={
          anySignal ? (
            <Link className="btn sm" href={`/calls?range=${range}&flagged=1`}>
              Review flagged
            </Link>
          ) : null
        }
      >
        <table className="kv">
          <tbody>
            <tr>
              <th>Calls flagged for fraud</th>
              <td>
                {k.fraudFlagged > 0 ? (
                  <Pill tone="bad">{integer(k.fraudFlagged)}</Pill>
                ) : (
                  <Pill tone="ok">None</Pill>
                )}
                <span className="muted"> · three failed OTP codes on one call</span>
              </td>
            </tr>
            <tr>
              <th>OTP lockouts</th>
              <td>
                {k.otpLockouts > 0 ? (
                  <Pill tone="warn">{integer(k.otpLockouts)} run(s)</Pill>
                ) : (
                  <Pill tone="ok">None</Pill>
                )}
              </td>
            </tr>
            <tr>
              <th>FMCSA rejections</th>
              <td>
                {k.verifFailed > 0 ? (
                  <Pill tone="warn">{integer(k.verifFailed)}</Pill>
                ) : (
                  <Pill tone="ok">None</Pill>
                )}
                <span className="muted"> · revoked, out-of-service or not found</span>
              </td>
            </tr>
            <tr>
              <th>TMS booking sync</th>
              <td>
                <span className="tag-list">
                  {k.tms.synced > 0 && <TmsPill state="synced" />}
                  {k.tms.pending > 0 && <TmsPill state="pending" />}
                  {k.tms.failed > 0 && <TmsPill state="failed" />}
                  {k.tms.ambiguous > 0 && <TmsPill state="ambiguous" />}
                  {k.bookedRuns === 0 && <Pill tone="mute">No bookings</Pill>}
                </span>
                {k.tms.ambiguous > 0 && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    Ambiguous writes are never auto-retried — a human resolves them with
                    the <code>ALREADY_BOOKED</code> probe.
                  </div>
                )}
              </td>
            </tr>
            <tr>
              <th>In flight</th>
              <td className="muted">
                {integer(k.callsInFlight)} call(s) open · {integer(k.callsAbandoned)} with
                no end time older than 30 min, classified abandoned
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function RecentTable({ rows }: { rows: Awaited<ReturnType<typeof getCallLog>>["rows"] }) {
  if (!rows.length) {
    return <Empty glyph="◎" title="No calls to show" />;
  }
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Started (UTC)</th>
          <th>MC / carrier</th>
          <th>Lane</th>
          <th>Outcome</th>
          <th className="num">Agreed</th>
          <th className="num">Rounds</th>
          <th className="num">Duration</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.runId} className={r.fraudSignal || r.ceilingDisclosed ? "flagged" : undefined}>
            <td className="nowrap">
              <Link href={`/calls/${r.runId}`}>{dateTimeUtc(r.startedAt)}</Link>
              <div className="dim" style={{ fontSize: 11 }}>{relative(r.startedAt)}</div>
            </td>
            <td>
              <span className="mono">{r.mcNumber ?? EMPTY}</span>
              <div className="muted">{r.legalName ?? "Not in carrier master"}</div>
            </td>
            <td>
              {r.lane ?? <span className="dim">{EMPTY}</span>}
              {r.equipment && (
                <div className="dim" style={{ fontSize: 11 }}>{r.equipment}</div>
              )}
            </td>
            <td>
              <OutcomePill outcome={r.outcome} />
            </td>
            <td className="num">{money(r.agreedRate)}</td>
            <td className="num">{r.rounds ?? EMPTY}</td>
            <td className="num">{duration(r.durationS)}</td>
            <td className="right">
              <Link className="btn sm" href={`/calls/${r.runId}`}>
                Audit
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------

function pick(v: unknown, allowed: string[], fallback: string): string {
  return typeof v === "string" && allowed.includes(v) ? v : fallback;
}

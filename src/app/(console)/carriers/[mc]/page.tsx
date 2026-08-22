import Link from "next/link";
import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { describeError } from "@/lib/errors";
import { getCarrierDetail, type CarrierDetail } from "@/lib/queries";
import {
  BoolPill,
  Callout,
  Card,
  Empty,
  ErrorState,
  Kpi,
  OutcomePill,
  Pill,
  TmsPill,
} from "@/components/ui";
import TopBar from "@/components/TopBar";
import { CopyButton, RefreshButton } from "@/components/Actions";
import {
  EMPTY,
  dateTimeUtc,
  duration,
  humanise,
  integer,
  money,
  percent,
  ratio,
  relative,
} from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Carrier history" };

export default async function CarrierDetailPage({
  params,
}: {
  params: Promise<{ mc: string }>;
}) {
  await requireSession(); // FIRST STATEMENT — see lib/auth.ts

  const { mc: raw } = await params;
  const mc = decodeURIComponent(raw);

  let detail: CarrierDetail | null = null;
  let error: ReturnType<typeof describeError> | null = null;
  try {
    detail = await getCarrierDetail(mc);
  } catch (err) {
    error = describeError(err);
  }

  if (error) {
    return (
      <>
        <TopBar title={`MC ${mc}`} />
        <div className="content">
          <div className="card">
            <ErrorState title={error.title} detail={error.detail} hint={error.hint} />
          </div>
        </div>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <TopBar title={`MC ${mc}`} />
        <div className="content">
          <div className="card">
            <Empty
              glyph="∅"
              title="No record for this MC"
              action={
                <Link className="btn" href="/carriers">
                  Back to carriers
                </Link>
              }
            >
              Twin has no carrier snapshot, no call and no verification event for MC{" "}
              <code>{mc}</code>.
            </Empty>
          </div>
        </div>
      </>
    );
  }

  const c = detail.carrier;
  const conversion = ratio(c.bookings, c.calls);
  const failedVerifs = detail.verifications.filter((v) => !v.verified).length;

  return (
    <>
      <TopBar
        title={c.legalName ?? `MC ${c.mcNumber}`}
        crumb={
          <>
            <Link href="/carriers">Carriers</Link> · MC{" "}
            <span className="mono">{c.mcNumber}</span>
          </>
        }
        actions={
          <>
            <CopyButton value={c.mcNumber} label="Copy MC" />
            <Link className="btn sm" href={`/calls?range=all&mc=${encodeURIComponent(c.mcNumber)}`}>
              Filter call log
            </Link>
            <RefreshButton />
          </>
        }
      />

      <div className="content">
        {c.authorityOk === false && (
          <div style={{ marginBottom: 12 }}>
            <Callout tone="bad" title={`Operating authority is ${c.status ?? "not active"}`}>
              The workflow ends the call at the FMCSA check for this MC. Any historic
              booking below predates the current authority status — check the per-call
              verification events, not this snapshot, when resolving a dispute.
            </Callout>
          </div>
        )}
        {c.fraudSignals > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Callout tone="warn" title={`${integer(c.fraudSignals)} call(s) flagged for fraud`}>
              Three failed identity codes on a single call raises the flag. Repeated
              failure across calls from the same MC is a fraud signal, not a UX problem.
            </Callout>
          </div>
        )}

        <div className="kpi-grid">
          <Kpi label="Calls" value={integer(c.calls)} sub={c.lastCallAt ? `last ${relative(c.lastCallAt)}` : "no calls"} fill={null} />
          <Kpi
            label="Booked"
            value={integer(c.bookings)}
            sub={conversion === null ? "no calls" : `${percent(conversion, 0)} conversion`}
            tone={conversion === null ? undefined : conversion >= 35 ? "ok" : "warn"}
            fill={conversion}
          />
          <Kpi label="Avg agreed rate" value={money(c.avgAgreedRate)} sub="across booked loads" fill={null} small />
          <Kpi
            label="Failed FMCSA checks"
            value={integer(c.failedVerifications)}
            sub={`${integer(detail.verifications.length)} check(s) on record`}
            tone={c.failedVerifications > 0 ? "warn" : "ok"}
            fill={null}
            small
          />
          <Kpi
            label="Failed identity codes"
            value={integer(c.otpFailures)}
            sub={c.fraudSignals > 0 ? `${integer(c.fraudSignals)} call(s) flagged` : "no fraud flags"}
            tone={c.otpFailures > 0 ? "warn" : "ok"}
            fill={null}
            small
          />
        </div>

        <div className="cols side section" style={{ marginTop: 14 }}>
          <div className="stack">
            <Card title="Call history" subtitle={`${detail.calls.length} call(s)`} tight>
              {!detail.calls.length ? (
                <Empty glyph="◎" title="No calls from this MC" />
              ) : (
                <div className="table-wrap">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>Started (UTC)</th>
                        <th>Outcome</th>
                        <th>Lane / load</th>
                        <th className="num">Posted</th>
                        <th className="num">Agreed</th>
                        <th className="num">Rds</th>
                        <th>TMS</th>
                        <th className="num">Duration</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {detail.calls.map((r) => (
                        <tr key={r.runId} className={r.fraudSignal ? "flagged" : undefined}>
                          <td className="nowrap">
                            <Link href={`/calls/${r.runId}`}>{dateTimeUtc(r.startedAt)}</Link>
                            <div className="dim" style={{ fontSize: 11 }}>{relative(r.startedAt)}</div>
                          </td>
                          <td>
                            <OutcomePill outcome={r.outcome} />
                            {r.outcomeReason && (
                              <div className="dim" style={{ fontSize: 11 }}>{humanise(r.outcomeReason)}</div>
                            )}
                          </td>
                          <td>
                            {r.lane ?? <span className="dim">{EMPTY}</span>}
                            <div className="dim mono" style={{ fontSize: 11 }}>{r.loadId ?? ""}</div>
                          </td>
                          <td className="num muted">{money(r.postedRate)}</td>
                          <td className="num strong">{money(r.agreedRate)}</td>
                          <td className="num">{r.rounds ?? EMPTY}</td>
                          <td><TmsPill state={r.tmsSyncState} /></td>
                          <td className="num">{duration(r.durationS)}</td>
                          <td className="right">
                            <Link className="btn sm" href={`/calls/${r.runId}`}>Audit</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card
              title="Authority check history"
              subtitle="Per-call FMCSA verifications — the audit trail the snapshot cannot give you"
              tight
            >
              {!detail.verifications.length ? (
                <Empty glyph="—" title="No verification events recorded" />
              ) : (
                <div className="table-wrap">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>Checked (UTC)</th>
                        <th>MC as spoken</th>
                        <th>Result</th>
                        <th>Status</th>
                        <th>Legal name</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {detail.verifications.map((v) => (
                        <tr key={v.id ?? `${v.runId}-${v.checkedAt}`}>
                          <td className="mono nowrap" style={{ fontSize: 11.5 }}>
                            {dateTimeUtc(v.checkedAt)}
                          </td>
                          <td className="mono">{v.mcNumber ?? EMPTY}</td>
                          <td>
                            <BoolPill value={v.verified} yes="Verified" no={humanise(v.reason) || "Rejected"} />
                          </td>
                          <td>{v.authorityStatus ?? EMPTY}</td>
                          <td>{v.legalName ?? <span className="dim">{EMPTY}</span>}</td>
                          <td className="right">
                            <Link className="btn sm" href={`/calls/${v.runId}`}>Call</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <div className="stack">
            <Card title="Carrier master">
              <table className="kv">
                <tbody>
                  <tr>
                    <th>MC</th>
                    <td className="mono">{c.mcNumber}</td>
                  </tr>
                  <tr>
                    <th>DOT</th>
                    <td className="mono">{c.dotNumber ?? EMPTY}</td>
                  </tr>
                  <tr>
                    <th>Legal name</th>
                    <td>{c.legalName ?? <span className="dim">Not on file</span>}</td>
                  </tr>
                  <tr>
                    <th>Authority</th>
                    <td>
                      <BoolPill value={c.authorityOk} yes="Active" no={c.status ?? "Not active"} />
                    </td>
                  </tr>
                  <tr>
                    <th>Snapshot taken</th>
                    <td className="mono" style={{ fontSize: 11.5 }}>{dateTimeUtc(c.verifiedAt)}</td>
                  </tr>
                  <tr>
                    <th>OTP contact</th>
                    <td>
                      {c.emailMasked ? (
                        <span className="mono">{c.emailMasked}</span>
                      ) : (
                        <Pill tone="warn">No contact on file</Pill>
                      )}
                      {c.contactSource && (
                        <div className="dim" style={{ fontSize: 11 }}>
                          source: {c.contactSource}
                        </div>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="dim" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                The identity code is only ever sent to the contact on file. A
                caller-supplied address is never accepted, and the console only ever
                renders the masked form.
              </div>
            </Card>

            <Card title="Risk summary">
              <table className="kv">
                <tbody>
                  <tr>
                    <th>Fraud-flagged calls</th>
                    <td>
                      {c.fraudSignals > 0 ? (
                        <Pill tone="bad">{integer(c.fraudSignals)}</Pill>
                      ) : (
                        <Pill tone="ok">None</Pill>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>Failed identity codes</th>
                    <td>
                      {c.otpFailures > 0 ? (
                        <Pill tone="warn">{integer(c.otpFailures)}</Pill>
                      ) : (
                        <Pill tone="ok">None</Pill>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>Rejected authority checks</th>
                    <td>
                      {failedVerifs > 0 ? (
                        <Pill tone="warn">{integer(failedVerifs)}</Pill>
                      ) : (
                        <Pill tone="ok">None</Pill>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { describeError } from "@/lib/errors";
import { getCarriers, type CarrierSummary } from "@/lib/queries";
import { BoolPill, Empty, ErrorState, Pill } from "@/components/ui";
import TopBar from "@/components/TopBar";
import { RefreshButton } from "@/components/Actions";
import { EMPTY, dateTimeUtc, integer, money, relative } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Carriers" };

export default async function CarriersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession("/carriers"); // FIRST STATEMENT — see lib/auth.ts

  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";

  let carriers: CarrierSummary[] = [];
  let error: ReturnType<typeof describeError> | null = null;
  try {
    carriers = await getCarriers(q || null);
  } catch (err) {
    error = describeError(err);
  }

  return (
    <>
      <TopBar
        title="Carriers"
        crumb={error ? undefined : `${integer(carriers.length)} in the carrier master`}
        actions={<RefreshButton />}
      />
      <div className="content">
        <form className="toolbar" method="get" action="/carriers">
          <div className="field grow">
            <label htmlFor="c-q">Search</label>
            <input
              id="c-q"
              type="search"
              name="q"
              defaultValue={q}
              placeholder="MC number, DOT number or legal name…"
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn primary">
            Search
          </button>
          <a className="btn" href="/carriers">
            Reset
          </a>
        </form>

        <div className="card">
          {error ? (
            <ErrorState title={error.title} detail={error.detail} hint={error.hint} />
          ) : !carriers.length ? (
            <Empty
              glyph="∅"
              title={q ? `No carrier matches “${q}”` : "No carriers recorded yet"}
              action={q ? <Link className="btn" href="/carriers">Clear search</Link> : null}
            >
              Twin&rsquo;s <code>carriers</code> table holds one row per MC, written when
              the FMCSA authority check runs. It is a current-state snapshot — the
              per-call history lives in <code>verification_events</code> and is shown on
              each carrier&rsquo;s page.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>MC</th>
                    <th>Legal name</th>
                    <th>Authority</th>
                    <th>OTP contact</th>
                    <th className="num">Calls</th>
                    <th className="num">Booked</th>
                    <th className="num">Avg agreed</th>
                    <th>Risk</th>
                    <th>Last call (UTC)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {carriers.map((c) => (
                    <tr key={c.mcNumber} className={c.fraudSignals > 0 ? "flagged" : undefined}>
                      <td className="mono">{c.mcNumber}</td>
                      <td>
                        {c.legalName ?? <span className="dim">Unknown</span>}
                        <div className="dim mono" style={{ fontSize: 11 }}>
                          {c.dotNumber ? `DOT ${c.dotNumber}` : ""}
                        </div>
                      </td>
                      <td>
                        <BoolPill
                          value={c.authorityOk}
                          yes="Active"
                          no={c.status ?? "Not active"}
                        />
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {c.emailMasked ?? <span className="dim">none on file</span>}
                      </td>
                      <td className="num">{integer(c.calls)}</td>
                      <td className="num">{integer(c.bookings)}</td>
                      <td className="num">{money(c.avgAgreedRate)}</td>
                      <td>
                        <span className="tag-list">
                          {c.fraudSignals > 0 && (
                            <Pill tone="bad" small>
                              {integer(c.fraudSignals)} fraud
                            </Pill>
                          )}
                          {c.otpFailures > 0 && (
                            <Pill tone="warn" small>
                              {integer(c.otpFailures)} OTP fail
                            </Pill>
                          )}
                          {c.failedVerifications > 0 && (
                            <Pill tone="warn" small>
                              {integer(c.failedVerifications)} FMCSA
                            </Pill>
                          )}
                          {!c.fraudSignals && !c.otpFailures && !c.failedVerifications && (
                            <Pill tone="ok" small>
                              Clean
                            </Pill>
                          )}
                        </span>
                      </td>
                      <td className="nowrap">
                        {c.lastCallAt ? (
                          <>
                            {dateTimeUtc(c.lastCallAt)}
                            <div className="dim" style={{ fontSize: 11 }}>
                              {relative(c.lastCallAt)}
                            </div>
                          </>
                        ) : (
                          <span className="dim">{EMPTY}</span>
                        )}
                      </td>
                      <td className="right">
                        <Link
                          className="btn sm"
                          href={`/carriers/${encodeURIComponent(c.mcNumber)}`}
                        >
                          History
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

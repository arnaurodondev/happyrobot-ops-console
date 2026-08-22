import Link from "next/link";
import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { describeError } from "@/lib/errors";
import { getCallDetail, type CallDetail, type NegotiationRound } from "@/lib/queries";
import { isUuid } from "@/lib/twin";
import {
  BoolPill,
  Callout,
  Card,
  Empty,
  ErrorState,
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
  timeUtc,
} from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Call audit trail" };

export default async function CallDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession(); // FIRST STATEMENT — see lib/auth.ts

  const { runId } = await params;
  const sp = await searchParams;
  const backRange = typeof sp.range === "string" ? sp.range : "7d";

  if (!isUuid(runId)) {
    return (
      <>
        <TopBar title="Call audit trail" />
        <div className="content">
          <div className="card">
            <Empty
              glyph="?"
              title="That is not a run ID"
              action={
                <Link className="btn" href="/calls">
                  Back to the call log
                </Link>
              }
            >
              A HappyRobot run ID is a UUID. Twin keys the <code>calls</code> table on it,
              so anything else cannot address a call.
            </Empty>
          </div>
        </div>
      </>
    );
  }

  let detail: CallDetail | null = null;
  let error: ReturnType<typeof describeError> | null = null;
  try {
    detail = await getCallDetail(runId);
  } catch (err) {
    error = describeError(err);
  }

  if (error) {
    return (
      <>
        <TopBar title="Call audit trail" />
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
        <TopBar title="Call audit trail" />
        <div className="content">
          <div className="card">
            <Empty
              glyph="∅"
              title="No call with that run ID"
              action={
                <Link className="btn" href="/calls?range=all">
                  Search the call log
                </Link>
              }
            >
              Twin has no <code>calls</code> row for <code>{runId}</code>. If the run
              exists on the platform but not here, the Write-to-Twin node never fired —
              which is itself the finding.
            </Empty>
          </div>
        </div>
      </>
    );
  }

  const d = detail;
  const c = d.call;
  const pitched = d.offers.find((o) => o.wasPitched) ?? null;

  return (
    <>
      <TopBar
        title="Call audit trail"
        crumb={
          <>
            <Link href={`/calls?range=${backRange}`}>Call log</Link> ·{" "}
            <span className="mono">{c.runId}</span>
          </>
        }
        actions={
          <>
            <CopyButton value={c.runId} label="Copy run ID" />
            <a className="btn sm" href={`/api/export/calls/${c.runId}`}>
              Export audit trail
            </a>
            <RefreshButton />
          </>
        }
      />

      <div className="content">
        <SummaryStrip detail={d} />

        <div className="cols side section">
          <div className="stack">
            <CeilingCard detail={d} />
            <TimelineCard detail={d} />
            <NegotiationCard detail={d} />
            <LoadsCard detail={d} />
          </div>

          <div className="stack">
            <CarrierCard detail={d} />
            <BookingCard detail={d} />
            <DumpCard detail={d} />
            <NotesCard detail={d} />
            <ProvenanceCard detail={d} pitchedLoad={pitched?.loadId ?? null} />
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function SummaryStrip({ detail: d }: { detail: CallDetail }) {
  const c = d.call;
  const abandoned =
    !c.endedAt && c.startedAt && Date.now() - new Date(c.startedAt).getTime() > 30 * 60_000;

  return (
    <div className="kpi-grid">
      <div className="kpi">
        <div className="kpi-label">Outcome</div>
        <div style={{ marginTop: 2 }}>
          <OutcomePill outcome={c.outcome} />
        </div>
        <div className="kpi-sub">
          {c.outcomeReason ? humanise(c.outcomeReason) : humanise(c.status) }
          {abandoned && !c.outcome && " · no end time recorded"}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Carrier</div>
        <div className="kpi-value sm">
          {c.mcNumber ? (
            <Link href={`/carriers/${encodeURIComponent(c.mcNumber)}`}>{c.mcNumber}</Link>
          ) : (
            EMPTY
          )}
        </div>
        <div className="kpi-sub">{d.carrier?.legalName ?? "Not in carrier master"}</div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Agreed rate</div>
        <div className="kpi-value sm">{money(d.booking?.agreedRate ?? null)}</div>
        <div className="kpi-sub">
          {d.ceiling.maxBuy !== null
            ? `ceiling ${money(d.ceiling.maxBuy)}${
                d.ceiling.headroom !== null ? ` · ${money(d.ceiling.headroom)} headroom` : ""
              }`
            : "no ceiling on record"}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Started (UTC)</div>
        <div className="kpi-value sm" style={{ fontSize: 14 }}>
          {dateTimeUtc(c.startedAt)}
        </div>
        <div className="kpi-sub">
          {c.endedAt ? `ended ${timeUtc(c.endedAt)} UTC` : "no end time recorded"} ·{" "}
          {duration(c.durationS)}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Handoff</div>
        <div style={{ marginTop: 2 }}>
          {c.handoffState ? (
            <Pill tone={c.handoffState === "mocked" ? "info" : "mute"}>
              {humanise(c.handoffState)}
            </Pill>
          ) : (
            <Pill tone="mute">No handoff</Pill>
          )}
        </div>
        <div className="kpi-sub">
          {c.handoffAt ? `${timeUtc(c.handoffAt)} UTC` : "senior-rep queue not reached"}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Environment</div>
        <div className="kpi-value sm" style={{ fontSize: 15 }}>
          {c.environment ?? EMPTY}
        </div>
        <div className="kpi-sub mono" style={{ fontSize: 10.5 }}>
          session {c.sessionId ?? EMPTY}
        </div>
      </div>
    </div>
  );
}

function CeilingCard({ detail: d }: { detail: CallDetail }) {
  const a = d.ceiling;
  const tone = a.verdict === "clean" ? "ok" : a.verdict === "breach" ? "bad" : "mute";
  const title =
    a.verdict === "clean"
      ? "Rate ceiling held"
      : a.verdict === "breach"
        ? "Rate ceiling breached"
        : "Ceiling adherence cannot be determined";

  return (
    <Card
      title="Ceiling adherence verdict"
      subtitle="Enforced and never disclosed — the brief's hardest rule"
      actions={<Pill tone={tone}>{a.verdict.toUpperCase()}</Pill>}
    >
      <div className="stack">
        <Callout tone={tone} title={title}>
          <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
            {a.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Callout>

        <table className="kv">
          <tbody>
            <tr>
              <th>Posted board rate</th>
              <td className="mono">{money(a.postedRate)}</td>
            </tr>
            <tr>
              <th>max_buy (ceiling)</th>
              <td className="mono strong">
                {money(a.maxBuy)}
                {a.postedRate && a.maxBuy && (
                  <span className="muted">
                    {" "}
                    · {percent((a.maxBuy / a.postedRate) * 100, 1)} of posted
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th>Agreed rate</th>
              <td className="mono strong">{money(a.agreedRate)}</td>
            </tr>
            <tr>
              <th>Highest agent quote</th>
              <td className="mono">
                {money(a.highestAgentQuote)}
                {a.highestQuotePctOfCeiling !== null && (
                  <span className="muted">
                    {" "}
                    · {percent(a.highestQuotePctOfCeiling, 1)} of the ceiling
                    {a.highestQuotePctOfCeiling >= 100
                      ? " — quoting the ceiling discloses it"
                      : " — never reached it"}
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th>Auditor node verdict</th>
              <td>
                <BoolPill
                  value={a.auditorVerdict}
                  yes="Disclosure flagged"
                  no="No disclosure"
                  unknown="Not audited"
                  invert
                />
                {d.call.ceilingAudit?.evidence !== undefined && (
                  <div className="muted" style={{ marginTop: 3 }}>
                    {String(d.call.ceilingAudit.evidence)}
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
          The ceiling is read from <code>load_offers.load_snapshot → max_buy</code> — the
          only place in Twin that holds it. It is never selected by any workflow node
          that runs before the voice agent terminates, so this console can show it and the
          agent still cannot.
        </div>
      </div>
    </Card>
  );
}

function TimelineCard({ detail: d }: { detail: CallDetail }) {
  const c = d.call;
  const items: {
    tone: "ok" | "bad" | "warn" | "info" | "";
    title: string;
    time: string | null;
    body?: React.ReactNode;
  }[] = [];

  items.push({
    tone: "info",
    title: "Call started",
    time: c.startedAt,
    body: (
      <>
        Web-call trigger · environment <code>{c.environment ?? "—"}</code>
      </>
    ),
  });

  for (const v of d.verifications) {
    items.push({
      tone: v.verified ? "ok" : "bad",
      title: v.verified ? "FMCSA authority verified" : "FMCSA check rejected the carrier",
      time: v.checkedAt,
      body: (
        <>
          MC as spoken <span className="mono">{v.mcNumber ?? EMPTY}</span>
          {v.dotNumber && (
            <>
              {" "}
              · DOT <span className="mono">{v.dotNumber}</span>
            </>
          )}
          {v.legalName && <> · {v.legalName}</>}
          {v.authorityStatus && (
            <>
              {" "}
              · <Pill tone={v.verified ? "ok" : "bad"} small>{v.authorityStatus}</Pill>
            </>
          )}
          {v.reason && <div className="dim">Reason: {humanise(v.reason)}</div>}
        </>
      ),
    });
  }

  for (const a of d.otpAttempts) {
    const sent = a.failureReason === "sent";
    items.push({
      tone: sent ? "info" : a.verified ? "ok" : "bad",
      title: sent
        ? "Identity code sent"
        : a.verified
          ? "Identity code verified"
          : `Identity code rejected (attempt ${a.attemptNo ?? "?"})`,
      time: a.createdAt,
      body: (
        <>
          Channel {a.channel ?? "email"}
          {a.failureReason && !sent && <> · {humanise(a.failureReason)}</>}
          {sent && (
            <>
              {" "}
              · to the address on file
              {d.carrier?.emailMasked ? ` (${d.carrier.emailMasked})` : ""}
            </>
          )}
        </>
      ),
    });
  }

  if (d.offers.length) {
    const pitched = d.offers.find((o) => o.wasPitched);
    items.push({
      tone: "info",
      title: `${d.offers.length} load(s) returned by the TMS search`,
      time: null,
      body: pitched ? (
        <>
          Pitched <span className="mono">{pitched.loadId}</span> — {pitched.origin} →{" "}
          {pitched.destination}, opening offer {money(pitched.openingOffer)}
        </>
      ) : (
        <>No load was marked as pitched.</>
      ),
    });
  }

  for (const r of d.rounds) {
    const isAgent = r.actor === "agent";
    const overCeiling =
      isAgent && d.ceiling.maxBuy !== null && r.amount !== null && r.amount >= d.ceiling.maxBuy;
    items.push({
      tone: overCeiling ? "bad" : isAgent ? "info" : "",
      title: `${isAgent ? "Agent" : "Carrier"} ${r.roundNo === 0 ? "opening pitch" : `round ${r.roundNo}`} — ${money(r.amount)}`,
      time: r.createdAt,
      body: (
        <>
          {r.outcome && <Pill tone={r.outcome === "accept" ? "ok" : r.outcome === "decline" ? "bad" : "mute"} small>{humanise(r.outcome)}</Pill>}
          {overCeiling && (
            <span className="muted"> — at or above the ceiling</span>
          )}
        </>
      ),
    });
  }

  if (d.booking) {
    items.push({
      tone: d.booking.tmsSyncState === "synced" ? "ok" : "warn",
      title: `Booking written at ${money(d.booking.agreedRate)}`,
      time: d.booking.bookedAt,
      body: (
        <>
          <TmsPill state={d.booking.tmsSyncState} />
          {d.booking.tmsRef && (
            <>
              {" "}
              · TMS ref <span className="mono">{d.booking.tmsRef}</span>
            </>
          )}
        </>
      ),
    });
  }

  if (c.handoffAt || c.handoffState) {
    items.push({
      tone: "info",
      title: "Handed off to the senior-rep queue",
      time: c.handoffAt,
      body: (
        <>
          State {humanise(c.handoffState)} · transfers are mocked on web calls, but the
          handoff event is real and auditable.
        </>
      ),
    });
  }

  items.push({
    tone: c.outcome === "booked" ? "ok" : c.endedAt ? "" : "warn",
    title: c.endedAt ? "Call ended" : "No end time recorded",
    time: c.endedAt,
    body: c.endedAt ? (
      <>
        Status {humanise(c.status)} · {duration(c.durationS)}
      </>
    ) : (
      <>
        The call has no <code>ended_at</code>. Older than 30 minutes, the console
        classifies this as abandoned — the run dump never writes a row for it.
      </>
    ),
  });

  return (
    <Card title="Audit trail" subtitle="Every recorded event on this run, in order (UTC)">
      <div className="timeline">
        {items.map((it, i) => (
          <div key={i} className={`tl-item ${it.tone}`}>
            <div className="tl-head">
              <span className="tl-title">{it.title}</span>
              <span className="tl-time">{it.time ? dateTimeUtc(it.time) : "no timestamp"}</span>
            </div>
            {it.body && <div className="tl-body">{it.body}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function NegotiationCard({ detail: d }: { detail: CallDetail }) {
  if (!d.rounds.length) {
    return (
      <Card title="Negotiation">
        <Empty glyph="—" title="No negotiation on this call">
          Nothing was written to <code>negotiation_rounds</code> for this run — the call
          ended before a rate was discussed.
        </Empty>
      </Card>
    );
  }

  const ceiling = d.ceiling.maxBuy;
  const amounts = d.rounds.map((r) => r.amount ?? 0);
  const scaleMax = Math.max(...amounts, ceiling ?? 0) * 1.06 || 1;
  const agentRounds = d.rounds.filter((r) => r.actor === "agent" && (r.roundNo ?? 0) > 0).length;

  return (
    <Card
      title="Negotiation ladder"
      subtitle={`${agentRounds} counter-round(s) of a 3-round cap`}
      actions={
        agentRounds > 3 ? <Pill tone="bad">Round cap exceeded</Pill> : <Pill tone="ok">Cap held</Pill>
      }
    >
      <div className="ladder">
        {d.rounds.map((r: NegotiationRound) => {
          const breach =
            r.actor === "agent" && ceiling !== null && r.amount !== null && r.amount >= ceiling;
          return (
            <div
              key={r.id ?? `${r.actor}-${r.roundNo}-${r.amount}`}
              className={`rung ${r.actor === "agent" ? "agent" : "carrier"}${breach ? " breach" : ""}`}
            >
              <span className="rung-actor">
                {r.actor === "agent" ? "Agent" : "Carrier"} {r.roundNo ?? EMPTY}
              </span>
              <span className="rung-track">
                <span
                  className="rung-fill"
                  style={{ width: `${Math.min(100, ((r.amount ?? 0) / scaleMax) * 100)}%` }}
                />
                {ceiling !== null && (
                  <span
                    className="rung-ceiling"
                    style={{ left: `${Math.min(100, (ceiling / scaleMax) * 100)}%` }}
                    title={`max_buy ${money(ceiling)}`}
                  />
                )}
              </span>
              <span className="rung-amount">{money(r.amount)}</span>
            </div>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 10, fontSize: 11 }}>
        <span className="row tight">
          <span className="swatch" style={{ width: 8, height: 8, borderRadius: 2, background: "var(--info)" }} />
          Agent
        </span>
        <span className="row tight">
          <span className="swatch" style={{ width: 8, height: 8, borderRadius: 2, background: "var(--ink-4)" }} />
          Carrier
        </span>
        {ceiling !== null && (
          <span className="row tight">
            <span style={{ width: 2, height: 11, background: "var(--bad)" }} />
            max_buy {money(ceiling)}
          </span>
        )}
        <span className="dim">Round 0 is the opening pitch and consumes no round.</span>
      </div>

      <div className="hr" />

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Round</th>
              <th>Actor</th>
              <th className="num">Amount</th>
              <th>Result</th>
              <th>Load</th>
            </tr>
          </thead>
          <tbody>
            {d.rounds.map((r) => (
              <tr key={`row-${r.id ?? `${r.actor}-${r.roundNo}-${r.amount}`}`}>
                <td className="mono nowrap">{r.createdAt ? timeUtc(r.createdAt) : EMPTY}</td>
                <td className="num">{r.roundNo ?? EMPTY}</td>
                <td>{humanise(r.actor)}</td>
                <td className="num strong">{money(r.amount)}</td>
                <td>{r.outcome ? <Pill tone={r.outcome === "accept" ? "ok" : r.outcome === "decline" ? "bad" : "mute"} small>{humanise(r.outcome)}</Pill> : EMPTY}</td>
                <td className="mono dim" style={{ fontSize: 11 }}>{r.loadId ?? EMPTY}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function LoadsCard({ detail: d }: { detail: CallDetail }) {
  if (!d.offers.length) {
    return (
      <Card title="Loads offered">
        <Empty glyph="—" title="No loads were searched on this call">
          The call ended before load matching. Load matching is gated server-side on a
          verified identity code, so a failed OTP always produces this state.
        </Empty>
      </Card>
    );
  }

  return (
    <Card
      title="Loads offered"
      subtitle={`${d.offers.length} returned by the search · ${d.offers.filter((o) => o.wasPitched).length} pitched`}
      tight
    >
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Load</th>
              <th>Lane</th>
              <th>Equipment</th>
              <th className="num">Posted</th>
              <th className="num">Ceiling</th>
              <th className="num">Opening offer</th>
              <th>Pitched</th>
            </tr>
          </thead>
          <tbody>
            {d.offers.map((o) => (
              <tr key={o.id ?? o.loadId} className={o.wasPitched ? "flagged" : undefined}>
                <td className="mono">{o.loadId ?? EMPTY}</td>
                <td>
                  {o.origin} → {o.destination}
                  <LoadSnapshot snapshot={o.snapshot} />
                </td>
                <td>{o.equipmentType ?? EMPTY}</td>
                <td className="num muted">{money(o.postedRate)}</td>
                <td className="num">{money(o.maxBuy)}</td>
                <td className="num">{money(o.openingOffer)}</td>
                <td>
                  {o.wasPitched ? (
                    <Pill tone="accent">Pitched</Pill>
                  ) : (
                    <Pill tone="mute" small>
                      Searched only
                    </Pill>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** jsonb comes back as a real object — never JSON.parse it, never inject it as HTML. */
function LoadSnapshot({ snapshot }: { snapshot: Record<string, unknown> | null }) {
  if (!snapshot) return null;
  const fields: [string, string][] = [
    ["miles", "mi"],
    ["weight", "lb"],
    ["num_of_pieces", "pcs"],
  ];
  const bits = fields
    .map(([k, unit]) => {
      const v = snapshot[k];
      return v === undefined || v === null ? null : `${integer(Number(v))} ${unit}`;
    })
    .filter(Boolean);
  const commodity = snapshot.commodity;
  const notes = snapshot.notes;
  return (
    <div className="dim" style={{ fontSize: 11 }}>
      {bits.join(" · ")}
      {commodity ? ` · ${String(commodity)}` : ""}
      {notes ? <div className="wrap-text">{String(notes)}</div> : null}
    </div>
  );
}

function CarrierCard({ detail: d }: { detail: CallDetail }) {
  const c = d.carrier;
  return (
    <Card
      title="Carrier"
      actions={
        d.call.mcNumber ? (
          <Link className="btn sm" href={`/carriers/${encodeURIComponent(d.call.mcNumber)}`}>
            History
          </Link>
        ) : null
      }
    >
      {!c ? (
        <Empty glyph="∅" title="Not in the carrier master">
          The MC on this call has no row in Twin&rsquo;s <code>carriers</code> table — an
          MC that FMCSA could not find never gets an authority snapshot.
        </Empty>
      ) : (
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
              <td>{c.legalName ?? EMPTY}</td>
            </tr>
            <tr>
              <th>Authority</th>
              <td>
                <BoolPill value={c.authorityOk} yes="Active" no={c.status ?? "Not active"} />
              </td>
            </tr>
            <tr>
              <th>OTP contact</th>
              <td>
                {c.emailMasked ? (
                  <span className="mono">{c.emailMasked}</span>
                ) : (
                  <Pill tone="warn">No contact on file</Pill>
                )}
                <div className="dim" style={{ fontSize: 11 }}>
                  Masked on the server. The full address is never sent to the browser, and
                  a caller-supplied address is never accepted.
                </div>
              </td>
            </tr>
            <tr>
              <th>Snapshot taken</th>
              <td className="mono" style={{ fontSize: 11.5 }}>
                {dateTimeUtc(c.verifiedAt)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  );
}

function BookingCard({ detail: d }: { detail: CallDetail }) {
  const b = d.booking;
  return (
    <Card title="Booking & TMS sync">
      {!b ? (
        <Empty glyph="—" title="No booking on this call">
          Nothing was written to <code>bookings</code>.
        </Empty>
      ) : (
        <div className="stack">
          {b.tmsSyncState === "ambiguous" && (
            <Callout tone="bad" title="Ambiguous TMS write — needs a human">
              The <code>LOAD_BOOK</code> response was ambiguous, so the booking was never
              auto-retried: a retry is how a carrier gets double-booked. Resolve it with
              the monotonic <code>ALREADY_BOOKED</code> probe against the TMS before
              touching the load.
            </Callout>
          )}
          <table className="kv">
            <tbody>
              <tr>
                <th>Agreed rate</th>
                <td className="mono strong">{money(b.agreedRate)}</td>
              </tr>
              <tr>
                <th>Load</th>
                <td className="mono">{b.loadId ?? EMPTY}</td>
              </tr>
              <tr>
                <th>TMS state</th>
                <td>
                  <TmsPill state={b.tmsSyncState} />
                </td>
              </tr>
              <tr>
                <th>TMS reference</th>
                <td className="mono">
                  {b.tmsRef ?? <span className="dim">none returned</span>}
                </td>
              </tr>
              <tr>
                <th>Booked at</th>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {dateTimeUtc(b.bookedAt)}
                </td>
              </tr>
              <tr>
                <th>Booking ID</th>
                <td className="mono dim" style={{ fontSize: 11 }}>
                  {b.bookingId}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="row">
            <CopyButton value={b.tmsRef ?? b.bookingId} label="Copy TMS reference" className="btn sm" />
          </div>
        </div>
      )}
    </Card>
  );
}

function DumpCard({ detail: d }: { detail: CallDetail }) {
  const dump = d.dump;
  const booked = d.booking?.agreedRate ?? null;
  const mismatch =
    dump?.finalRate !== null && dump?.finalRate !== undefined && booked !== null
      ? dump.finalRate !== booked
      : false;

  return (
    <Card title="Run dump" subtitle="call_outcomes — written by the native run dump">
      {!dump ? (
        <Empty glyph="—" title="No run-dump row">
          The platform&rsquo;s run dump skips failed runs by design, so a call that ended
          early has no <code>call_outcomes</code> row. Everything above comes from the
          <code> calls</code> record instead, which is written independently — that is why
          this call still has a full audit trail.
        </Empty>
      ) : (
        <div className="stack">
          {mismatch && (
            <Callout tone="warn" title="Dump and booking disagree on the rate">
              The extracted <code>response_final_rate</code> is {money(dump.finalRate)} but
              the booking row says {money(booked)}. The booking row is authoritative — it
              is what the TMS was asked to write.
            </Callout>
          )}
          <table className="kv">
            <tbody>
              <tr>
                <th>Classification</th>
                <td>
                  <OutcomePill outcome={dump.outcome} />
                </td>
              </tr>
              <tr>
                <th>Final rate</th>
                <td className="mono">{money(dump.finalRate)}</td>
              </tr>
              <tr>
                <th>Rounds</th>
                <td className="mono">{dump.roundsCount ?? EMPTY}</td>
              </tr>
              <tr>
                <th>MC</th>
                <td className="mono">{dump.mcNumber ?? EMPTY}</td>
              </tr>
              <tr>
                <th>Load</th>
                <td className="mono">{dump.loadId ?? EMPTY}</td>
              </tr>
            </tbody>
          </table>
          <div className="dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
            Every column in <code>call_outcomes</code> is <code>text</code>, including the
            two that are logically numeric — the dump names columns after the variable
            path and has no type mapping. The console casts on read.
          </div>
        </div>
      )}
    </Card>
  );
}

function NotesCard({ detail: d }: { detail: CallDetail }) {
  const notes = d.call.notes;
  const dumpNotes = d.dump?.notes;
  if (!notes && !dumpNotes) {
    return (
      <Card title="Notes">
        <Empty glyph="—" title="No notes recorded" />
      </Card>
    );
  }
  return (
    <Card title="Notes" subtitle="Post-call extraction">
      {notes && <p className="wrap-text">{notes}</p>}
      {dumpNotes && dumpNotes !== notes && (
        <>
          <div className="hr" />
          <div className="kpi-label">From the run dump</div>
          <p className="wrap-text">{dumpNotes}</p>
        </>
      )}
      <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
        Notes derive from the carrier&rsquo;s own speech. They are rendered as text, never
        as markup.
      </div>
    </Card>
  );
}

function ProvenanceCard({
  detail: d,
  pitchedLoad,
}: {
  detail: CallDetail;
  pitchedLoad: string | null;
}) {
  return (
    <Card title="Record provenance">
      <table className="kv">
        <tbody>
          <tr>
            <th>run_id</th>
            <td className="mono" style={{ fontSize: 11 }}>
              {d.call.runId}
            </td>
          </tr>
          <tr>
            <th>calls</th>
            <td>
              <Pill tone="ok" small>
                1 row
              </Pill>{" "}
              <span className="dim">Write-to-Twin node + finalize</span>
            </td>
          </tr>
          <tr>
            <th>verification_events</th>
            <td>
              <Pill tone={d.verifications.length ? "ok" : "mute"} small>
                {d.verifications.length} row(s)
              </Pill>
            </td>
          </tr>
          <tr>
            <th>otp_attempts</th>
            <td>
              <Pill tone={d.otpAttempts.length ? "ok" : "mute"} small>
                {d.otpAttempts.length} row(s)
              </Pill>{" "}
              <span className="dim">never the code or its hash</span>
            </td>
          </tr>
          <tr>
            <th>load_offers</th>
            <td>
              <Pill tone={d.offers.length ? "ok" : "mute"} small>
                {d.offers.length} row(s)
              </Pill>{" "}
              <span className="dim mono">{pitchedLoad ?? "none pitched"}</span>
            </td>
          </tr>
          <tr>
            <th>negotiation_rounds</th>
            <td>
              <Pill tone={d.rounds.length ? "ok" : "mute"} small>
                {d.rounds.length} row(s)
              </Pill>
            </td>
          </tr>
          <tr>
            <th>bookings</th>
            <td>
              <Pill tone={d.booking ? "ok" : "mute"} small>
                {d.booking ? "1 row" : "0 rows"}
              </Pill>
            </td>
          </tr>
          <tr>
            <th>call_outcomes</th>
            <td>
              <Pill tone={d.dump ? "ok" : "mute"} small>
                {d.dump ? "1 row" : "0 rows"}
              </Pill>{" "}
              <span className="dim">run dump</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="dim" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
        Read from the Twin system of record over <code>POST /api/v2/twin/sql</code>, server
        side. No platform run logs are touched.
      </div>
    </Card>
  );
}

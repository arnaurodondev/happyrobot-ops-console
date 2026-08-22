#!/usr/bin/env node
/**
 * Demo-data seeder for the operations console.
 * ---------------------------------------------------------------------------
 * The Twin database is the live system of record. This script exists only so
 * the console can be demoed/screenshotted before the voice workflow has put
 * real runs into it.
 *
 * IT IS FULLY REVERSIBLE, BY CONSTRUCTION:
 *   - every seeded call uses a run_id in the reserved `deadbee0-…` namespace
 *   - every seeded call has environment = 'demo'
 *   - detail rows are removed by the schema's own ON DELETE CASCADE
 *   - call_outcomes (dump-provisioned, no FK) and the seeded carrier rows are
 *     removed explicitly by the same reserved keys
 *
 *   npm run seed:demo    # write
 *   npm run seed:purge   # remove every trace
 *
 * It never touches a row it did not create. `carrier_contacts` rows that
 * already exist (e.g. the real MC 872144 seed) are left alone.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

// --- env -------------------------------------------------------------------
for (const file of [
  path.join(APP_ROOT, ".env.local"),
  path.join(APP_ROOT, ".env"),
  path.join(APP_ROOT, "..", ".env"),
]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

const KEY = process.env.TWIN_API_KEY || process.env.HR_API_KEY || process.env.API_KEY;
const BASE = (process.env.HR_PLATFORM_URL || "https://platform.happyrobot.ai").replace(/\/+$/, "");
if (!KEY) {
  console.error("No API key found. Set TWIN_API_KEY in app/.env.local (or API_KEY in the repo .env).");
  process.exit(1);
}

async function run(sqlText) {
  const res = await fetch(`${BASE}/api/v2/twin/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: sqlText }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 600)}`);
  }
  return JSON.parse(body);
}

const q = (v) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const n = (v) => (v === null || v === undefined ? "NULL" : String(Math.round(v)));
const b = (v) => (v === null || v === undefined ? "NULL" : v ? "TRUE" : "FALSE");

// Naive-UTC, the house format: Twin `timestamp` discards any offset.
const ts = (d) => (d ? d.toISOString().replace("Z", "").replace("T", " ") : null);
const minutesAgo = (m) => new Date(Date.now() - m * 60_000);

const RUN_PREFIX = "deadbee0";
const ENVIRONMENT = "demo";
const runId = (i) => `${RUN_PREFIX}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const bookingId = (i) => `deadbee0-0000-4000-9000-${String(i).padStart(12, "0")}`;

// --- fixtures --------------------------------------------------------------

const CARRIERS = [
  ["872144", "1234567", "ABC TRUCKING LLC", true, "ACTIVE"],
  ["445120", "2887410", "SUNBELT CARRIERS INC", true, "ACTIVE"],
  ["610337", "3120994", "RIDGELINE TRANSPORT LLC", true, "ACTIVE"],
  ["209884", "1904772", "NORTHWAY FREIGHT SYSTEMS INC", true, "ACTIVE"],
  ["388215", "2551038", "CASCADE LINE HAUL CO", true, "ACTIVE"],
  ["771902", "3402118", "GRAYHAUL LOGISTICS LLC", false, "REVOKED"],
  ["504773", "2210567", "PIONEER VALLEY CARTAGE LLC", false, "OUT_OF_SERVICE"],
];

const CONTACTS = [
  ["445120", "dispatch@sunbeltcarriers.example", "d***@sunbeltcarriers.example"],
  ["610337", "ops@ridgelinetransport.example", "o***@ridgelinetransport.example"],
  ["209884", "j.mercer@northwayfreight.example", "j***@northwayfreight.example"],
  ["388215", "booking@cascadelinehaul.example", "b***@cascadelinehaul.example"],
];

const LANES = [
  ["Atlanta, GA", "Dallas, TX", "DRY_VAN", 785, 42000, "PALLETIZED CONSUMER GOODS", 26, "48X40 STD GMA PALLETS", "Drop trailer at destination."],
  ["Chicago, IL", "Denver, CO", "REEFER", 1003, 38500, "TEMP CONTROLLED DAIRY", 22, "48X40 CHEP", "Continuous 34F. Lumper paid by receiver."],
  ["Laredo, TX", "Memphis, TN", "DRY_VAN", 892, 44100, "AUTOMOTIVE COMPONENTS", 30, "48X45 CUSTOM CRATES", "Cross-dock appointment required."],
  ["Fresno, CA", "Phoenix, AZ", "REEFER", 598, 41200, "FRESH PRODUCE", 24, "48X40 STD GMA PALLETS", "Pulp temp on arrival."],
  ["Newark, NJ", "Charlotte, NC", "FLATBED", 640, 46800, "STRUCTURAL STEEL", 12, "240X96X48", "Tarps and 8 straps required."],
  ["Kansas City, MO", "Salt Lake City, UT", "DRY_VAN", 1082, 39400, "PAPER PRODUCTS", 28, "48X40 STD GMA PALLETS", "No-touch freight."],
  ["Savannah, GA", "Columbus, OH", "DRY_VAN", 716, 43700, "RETAIL GENERAL MERCHANDISE", 26, "48X40 STD GMA PALLETS", "Live unload, 2h detention free."],
];

const loadId = (i) => `LD${String(45820 + i * 137).padStart(10, "0")}`;
const tmsRef = (i) => `BR${String(91277 + i * 41).padStart(14, "0")}`;

/** posted (board) rate -> ceiling at ~90%, opening anchor at 88% of ceiling. */
function rates(posted) {
  const maxBuy = Math.round(posted * 0.903);
  const opening = Math.max(Math.round(maxBuy * 0.88), Math.round(posted * 0.8));
  return { maxBuy, opening };
}

/**
 * 14 runs across every disposition the workflow can produce, so the console's
 * filters, empty states and edge cases all have something to render.
 */
const SCRIPT = [
  { mc: "445120", lane: 0, outcome: "booked", rounds: 2, startedMinAgo: 34, durationS: 214, notes: "Carrier accepted the second counter all-in. Asked about a reload out of Dallas next Tuesday — passed to the reload desk." },
  { mc: "610337", lane: 1, outcome: "booked", rounds: 1, startedMinAgo: 96, durationS: 178, notes: "Straight to yes on the first counter. Driver already empty in Chicago." },
  { mc: "209884", lane: 2, outcome: "negotiation_failed", reason: "round_cap", rounds: 3, startedMinAgo: 151, durationS: 262, notes: "Carrier held their number through all three rounds and stayed above our best-and-final. Closed warmly, no transfer." },
  { mc: "872144", lane: 3, outcome: "booked", rounds: 3, startedMinAgo: 205, durationS: 301, notes: "Booked at best-and-final. Carrier pushed hard for the board rate; agent did not quote it." },
  { mc: "771902", lane: null, outcome: "not_verified", reason: "authority_revoked", startedMinAgo: 233, durationS: 47, notes: "FMCSA returned REVOKED operating authority. Call ended before OTP." },
  { mc: "388215", lane: 4, outcome: "booked", rounds: 1, startedMinAgo: 288, durationS: 165, notes: "Flatbed with tarps. Agreed on the opening counter." },
  { mc: "445120", lane: 5, outcome: "no_loads", reason: "no_match", startedMinAgo: 322, durationS: 88, notes: "Wanted Kansas City to the Pacific Northwest on a reefer. Nothing on the board in that lane today." },
  { mc: "209884", lane: 6, outcome: "booked", rounds: 2, startedMinAgo: 402, durationS: 233, notes: "Second counter accepted. Confirmed no-touch and 2h free detention." },
  { mc: "610337", lane: 2, outcome: "otp_failed", reason: "otp_failed", otpFailures: 3, startedMinAgo: 470, durationS: 141, notes: "Three failed codes in a row, then asked to have the code sent to a different number. Refused; call ended. Flagged for the fraud queue." },
  { mc: "504773", lane: null, outcome: "not_verified", reason: "out_of_service", startedMinAgo: 640, durationS: 39, notes: "Out-of-service order on file at FMCSA." },
  { mc: "388215", lane: 0, outcome: "negotiation_failed", reason: "round_cap", rounds: 3, startedMinAgo: 1180, durationS: 244, notes: "Carrier would not come down to our best-and-final. Ceiling held, no transfer." },
  { mc: "872144", lane: 6, outcome: "booked", rounds: 2, startedMinAgo: 1495, durationS: 256, tms: "ambiguous", notes: "Rate agreed and confirmed to the carrier. The TMS booking write returned an ambiguous response — not auto-retried, sitting with ops for the ALREADY_BOOKED probe." },
  { mc: "445120", lane: 3, outcome: "abandoned", startedMinAgo: 1702, durationS: null, notes: null },
  { mc: "999001", lane: null, outcome: "not_verified", reason: "not_found", startedMinAgo: 2210, durationS: 28, notes: "MC not found at FMCSA. Two attempts at the number, both no match." },
];

/**
 * ADVERSARIAL FIXTURES — seeded only with `--adversarial` (npm run seed:adversarial).
 * These exist to prove the console's defences on screen, not to make it look good:
 *
 *   1. CEILING BREACH — the agent's ladder walks *through* max_buy and the booking
 *      lands above it. Exercises the breach verdict, the "Over ceiling" flag, the
 *      flagged-calls filter, and drags the adherence KPI off 100%.
 *   2. UNTRUSTED SPEECH — `notes` is written by post-call AI extraction from what
 *      the carrier said, so it is attacker-controlled text. This row carries HTML
 *      injection, an event-handler payload, and four spreadsheet formula prefixes
 *      (=, +, -, @) that execute on open in Excel if a CSV writer is naive.
 *
 * Both live in the same reserved run_id namespace, so `npm run seed:purge`
 * removes them with everything else.
 */
const XSS_NOTES =
  `<script>alert('xss')</script> <img src=x onerror="alert(document.cookie)"> ` +
  `"><svg/onload=alert(1)> &lt;b&gt;already-encoded&lt;/b&gt; ` +
  `Carrier said the rate was =cmd|' /C calc'!A0 and +1+1 and -2+3 and @SUM(1+1) — ` +
  `also 'single' and "double" quotes, a comma, and a\nnewline.`;

const ADVERSARIAL = [
  {
    mc: "445120", lane: 2, outcome: "booked", rounds: 3, breach: true,
    startedMinAgo: 61, durationS: 288,
    notes: "ADVERSARIAL FIXTURE — agent walked the ladder through the ceiling and booked above max_buy. Expected: BREACH verdict, Over-ceiling flag, adherence below 100%.",
  },
  {
    mc: "610337", lane: 5, outcome: "negotiation_failed", reason: "round_cap", rounds: 2,
    startedMinAgo: 74, durationS: 199,
    notes: XSS_NOTES,
  },
];

// --- SQL emit --------------------------------------------------------------

function buildInserts(adversarial = false) {
  const script = adversarial ? [...SCRIPT, ...ADVERSARIAL] : SCRIPT;
  const stmts = [];
  const runIds = [];
  const mcs = new Set();

  // carriers
  const carrierVals = CARRIERS.map(
    ([mc, dot, name, ok, status]) =>
      `(${q(mc)}, ${q(dot)}, ${q(name)}, ${b(ok)}, ${q(status)}, ${q(
        JSON.stringify({ source: "demo-seed", legalName: name, dotNumber: dot, allowedToOperate: ok ? "Y" : "N" }),
      )}::jsonb, ${q(ts(minutesAgo(2400)))})`,
  );
  CARRIERS.forEach(([mc]) => mcs.add(mc));
  stmts.push(
    `INSERT INTO carriers (mc_number, dot_number, legal_name, authority_ok, status, raw_fmcsa, verified_at) VALUES ${carrierVals.join(
      ", ",
    )} ON CONFLICT (mc_number) DO NOTHING`,
  );

  // carrier_contacts — never overwrite an existing row
  const contactVals = CONTACTS.map(
    ([mc, email, masked]) =>
      `(${q(mc)}, ${q(email)}, ${q(masked)}, 'seed', ${q(ts(minutesAgo(2400)))})`,
  );
  stmts.push(
    `INSERT INTO carrier_contacts (mc_number, email, email_masked, source, updated_at) VALUES ${contactVals.join(
      ", ",
    )} ON CONFLICT (mc_number) DO NOTHING`,
  );

  const calls = [];
  const verifs = [];
  const otps = [];
  const offers = [];
  const rounds = [];
  const books = [];
  const dumps = [];

  script.forEach((s, i) => {
    const rid = runId(i);
    runIds.push(rid);
    const started = minutesAgo(s.startedMinAgo);
    const ended = s.durationS ? new Date(started.getTime() + s.durationS * 1000) : null;
    const carrier = CARRIERS.find((c) => c[0] === s.mc);
    const booked = s.outcome === "booked";
    const verified = s.outcome !== "not_verified";

    // ---- calls
    const handoffAt = booked ? new Date(ended.getTime() - 8000) : null;
    calls.push(
      `(${q(rid)}, ${q(`deadbee0-0000-4000-a000-${String(i).padStart(12, "0")}`)}, ${q(s.mc)}, ` +
        `${q(ts(started))}, ${q(ts(ended))}, ${q(ENVIRONMENT)}, ${q(ended ? "completed" : "in_progress")}, ` +
        `${q(s.outcome)}, ${q(s.reason ?? null)}, ${q(s.notes ?? null)}, ` +
        `${q(ts(handoffAt))}, ${q(booked ? "mocked" : null)}, ${b(s.otpFailures === 3)}, ` +
        `${booked || s.outcome === "negotiation_failed" ? "FALSE" : "NULL"}, ` +
        `${
          booked || s.outcome === "negotiation_failed"
            ? q(
                JSON.stringify({
                  verdict: "clean",
                  checked_at: ts(ended),
                  evidence: "No utterance in the transcript quoted or bounded the ceiling.",
                  source: "Carrier Sales Auditor node",
                }),
              ) + "::jsonb"
            : "NULL"
        })`,
    );

    // ---- verification_events (every call attempts one)
    verifs.push(
      `(${q(rid)}, ${q(s.mc)}, ${b(verified)}, ${q(s.reason && !verified ? s.reason : null)}, ` +
        `${q(carrier ? carrier[1] : null)}, ${q(carrier ? carrier[2] : null)}, ` +
        `${q(carrier ? carrier[4] : "NOT_FOUND")}, ${q(ts(new Date(started.getTime() + 18_000)))})`,
    );

    if (!verified) {
      dumps.push(rid);
      return;
    }

    // ---- otp_attempts: one 'sent' row then the verify attempts
    let clock = started.getTime() + 42_000;
    otps.push(`(${q(rid)}, 1, 'email', FALSE, 'sent', ${q(ts(new Date(clock)))})`);
    const failures = s.otpFailures ?? 0;
    for (let a = 0; a < failures; a++) {
      clock += 21_000;
      otps.push(
        `(${q(rid)}, ${a + 2}, 'email', FALSE, ${q(a === 2 ? "locked_out" : "mismatch")}, ${q(ts(new Date(clock)))})`,
      );
    }
    if (!failures) {
      clock += 26_000;
      otps.push(`(${q(rid)}, 2, 'email', TRUE, NULL, ${q(ts(new Date(clock)))})`);
    } else {
      dumps.push(rid);
      return;
    }

    if (s.lane === null || s.lane === undefined) {
      dumps.push(rid);
      return;
    }

    // ---- load_offers: the search returned up to 3, exactly one was pitched
    const pitchedLane = LANES[s.lane];
    const posted = 1400 + ((s.lane * 431 + i * 97) % 1600) + Math.round(pitchedLane[3] * 0.9);
    const { maxBuy, opening } = rates(posted);
    const pitchedLoadId = loadId(s.lane + i * 3);

    const mkOffer = (lane, lid, post, isPitched) => {
      const r = rates(post);
      return (
        `(${q(rid)}, ${q(lid)}, ${q(lane[0])}, ${q(lane[1])}, ${q(lane[2])}, ${n(post)}, ${n(r.opening)}, ` +
        q(
          JSON.stringify({
            load_id: lid,
            origin: lane[0],
            destination: lane[1],
            equipment_type: lane[2],
            miles: lane[3],
            weight: lane[4],
            commodity: lane[5],
            num_of_pieces: lane[6],
            dimensions: lane[7],
            notes: lane[8],
            loadboard_rate: post,
            max_buy: r.maxBuy,
            status: "OPEN",
          }),
        ) +
        `::jsonb, ${b(isPitched)})`
      );
    };

    offers.push(mkOffer(pitchedLane, pitchedLoadId, posted, true));
    if (s.outcome !== "no_loads") {
      const alt = LANES[(s.lane + 2) % LANES.length];
      offers.push(mkOffer(alt, loadId(s.lane + i * 3 + 11), posted + 190, false));
    }

    if (s.outcome === "no_loads") {
      dumps.push(rid);
      return;
    }

    // ---- negotiation_rounds: opening pitch is round 0 and consumes no round
    // The compliant ladder asymptotes to the ceiling and never reaches it.
    // The adversarial one walks straight through it.
    const ladder = s.breach ? [0.94, 0.99, 1.02, 1.07] : [0.88, 0.92, 0.96, 0.99];
    let base = started.getTime() + 110_000;
    rounds.push(`(${q(rid)}, ${q(pitchedLoadId)}, 0, 'agent', ${n(opening)}, 'counter', ${q(ts(new Date(base)))})`);

    let agreed = null;
    for (let r = 1; r <= (s.rounds ?? 0); r++) {
      base += 24_000;
      const ask = Math.round(maxBuy * (1.14 - r * 0.045));
      rounds.push(`(${q(rid)}, ${q(pitchedLoadId)}, ${r}, 'carrier', ${n(ask)}, 'counter', ${q(ts(new Date(base)))})`);
      base += 16_000;
      const ours = Math.round(maxBuy * ladder[Math.min(r, 3)]);
      const last = r === (s.rounds ?? 0);
      const outcome = last ? (booked ? "accept" : r === 3 ? "decline" : "final") : r === 3 ? "final" : "counter";
      rounds.push(
        `(${q(rid)}, ${q(pitchedLoadId)}, ${r}, 'agent', ${n(ours)}, ${q(outcome)}, ${q(ts(new Date(base)))})`,
      );
      if (last && booked) agreed = ours;
    }

    if (booked && agreed !== null) {
      books.push(
        `(${q(bookingId(i))}, ${q(rid)}, ${q(pitchedLoadId)}, ${n(agreed)}, ` +
          `${s.tms === "ambiguous" ? "NULL" : q(tmsRef(i))}, ${q(s.tms ?? "synced")}, ${q(ts(new Date(base + 9000)))})`,
      );
    }
    dumps.push(rid);
  });

  stmts.push(
    `INSERT INTO calls (run_id, session_id, mc_number, started_at, ended_at, environment, status, outcome, outcome_reason, notes, handoff_at, handoff_state, fraud_signal, ceiling_disclosed, ceiling_audit) VALUES ${calls.join(
      ", ",
    )} ON CONFLICT (run_id) DO NOTHING`,
  );
  stmts.push(
    `INSERT INTO verification_events (run_id, mc_number, verified, reason, dot_number, legal_name, authority_status, checked_at) VALUES ${verifs.join(
      ", ",
    )}`,
  );
  if (otps.length)
    stmts.push(
      `INSERT INTO otp_attempts (run_id, attempt_no, channel, verified, failure_reason, created_at) VALUES ${otps.join(", ")}`,
    );
  if (offers.length)
    stmts.push(
      `INSERT INTO load_offers (run_id, load_id, origin, destination, equipment_type, posted_rate, opening_offer, load_snapshot, was_pitched) VALUES ${offers.join(
        ", ",
      )} ON CONFLICT (run_id, load_id) DO NOTHING`,
    );
  if (rounds.length)
    stmts.push(
      `INSERT INTO negotiation_rounds (run_id, load_offer_id, round_no, actor, amount, outcome, created_at) ` +
        `SELECT v.run_id::uuid, lo.id, v.round_no, v.actor, v.amount, v.outcome, v.created_at::timestamp ` +
        `FROM (VALUES ${rounds.join(", ")}) AS v(run_id, load_id, round_no, actor, amount, outcome, created_at) ` +
        `JOIN load_offers lo ON lo.run_id = v.run_id::uuid AND lo.load_id = v.load_id`,
    );
  if (books.length)
    stmts.push(
      `INSERT INTO bookings (booking_id, run_id, load_id, agreed_rate, tms_ref, tms_sync_state, booked_at) VALUES ${books.join(
        ", ",
      )} ON CONFLICT (run_id, load_id) DO NOTHING`,
    );

  // call_outcomes — what the native run dump writes. Failed runs are skipped by
  // the dump by design, so only completed runs get a row here. Every column is
  // text, including the logically numeric ones.
  const dumpRows = [];
  script.forEach((s, i) => {
    const rid = runId(i);
    if (s.outcome === "abandoned") return; // the dump never sees an abandoned run
    const lane = s.lane === null || s.lane === undefined ? null : LANES[s.lane];
    const lid = lane ? loadId(s.lane + i * 3) : null;
    const posted = lane ? 1400 + ((s.lane * 431 + i * 97) % 1600) + Math.round(lane[3] * 0.9) : null;
    const finalRate =
      s.outcome === "booked" && posted
        ? String(Math.round(rates(posted).maxBuy * (s.breach ? [0.94, 0.99, 1.02, 1.07] : [0.88, 0.92, 0.96, 0.99])[Math.min(s.rounds ?? 0, 3)]))
        : null;
    dumpRows.push(
      `(${q(rid)}, ${q(s.outcome)}, ${q(finalRate)}, ${q(String(s.rounds ?? 0))}, ${q(s.mc)}, ${q(lid)}, ${q(s.notes)})`,
    );
  });
  stmts.push(
    `INSERT INTO call_outcomes (run_id, response_classification, response_final_rate, response_rounds_count, response_mc_number, response_load_id, response_notes) VALUES ${dumpRows.join(
      ", ",
    )} ON CONFLICT (run_id) DO NOTHING`,
  );

  return { stmts, runIds, mcs: [...mcs] };
}

function buildPurge(mcs) {
  return [
    // call_outcomes has no FK (the run dump provisions it), so it goes first.
    `DELETE FROM call_outcomes WHERE run_id LIKE '${RUN_PREFIX}-%'`,
    // ON DELETE CASCADE removes otp_attempts, load_offers, negotiation_rounds,
    // bookings and verification_events for these runs.
    `DELETE FROM calls WHERE environment = ${q(ENVIRONMENT)} AND run_id::text LIKE '${RUN_PREFIX}-%'`,
    `DELETE FROM carrier_contacts WHERE source = 'seed' AND mc_number IN (${CONTACTS.map((c) => q(c[0])).join(", ")})`,
    `DELETE FROM carriers WHERE raw_fmcsa->>'source' = 'demo-seed' AND mc_number IN (${mcs.map(q).join(", ")})`,
  ];
}

async function main() {
  const adversarial = process.argv.includes("--adversarial");
  const mode = process.argv.includes("--purge")
    ? "purge"
    : process.argv.includes("--apply") || adversarial
      ? "apply"
      : "help";

  if (mode === "help") {
    console.log("Usage: node scripts/seed-demo.mjs --apply [--adversarial] | --purge");
    process.exit(2);
  }

  // Purge always covers the full namespace, adversarial rows included.
  const { stmts, runIds, mcs } = buildInserts(adversarial);

  if (mode === "purge") {
    console.log(`Purging demo data from Twin at ${BASE} …`);
    for (const s of buildPurge(mcs)) {
      const r = await run(s);
      console.log(`  ${r.command.padEnd(6)} ${r.rowCount ?? 0} row(s)  <- ${s.slice(0, 72)}…`);
    }
    console.log("Done. No demo rows remain.");
    return;
  }

  console.log(
    `Seeding ${SCRIPT.length + (adversarial ? ADVERSARIAL.length : 0)} demo calls` +
      `${adversarial ? " (INCLUDING ADVERSARIAL FIXTURES)" : ""} into Twin at ${BASE} …`,
  );
  console.log("  purge with: npm run seed:purge");
  // Idempotent: re-running is a no-op thanks to ON CONFLICT / the purge-first.
  for (const s of buildPurge(mcs)) await run(s);
  for (const s of stmts) {
    const r = await run(s);
    console.log(`  ${r.command.padEnd(6)} ${r.rowCount ?? 0} row(s)  <- ${s.slice(0, 60)}…`);
  }
  console.log(`\nSeeded run_ids ${runIds[0]} … ${runIds.at(-1)} (environment='${ENVIRONMENT}').`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});

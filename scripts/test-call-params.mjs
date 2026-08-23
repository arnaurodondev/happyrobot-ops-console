#!/usr/bin/env node
/**
 * Regression tests for the call-log filter marshalling (src/lib/callParams.ts).
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * The "TMS exceptions" view (/calls?outcome=booked&tms=ambiguous) once applied
 * `tms` client-side over the already-fetched page and omitted it from the
 * export link. "Export CSV" from that view therefore downloaded the UNFILTERED
 * set — an artifact someone attaches to a dispute, silently wrong.
 *
 * The invariant asserted here: EVERY narrowing the console understands is
 * carried into the export query string, and the export handler applies it in
 * SQL. Adding a filter without wiring the export fails this file.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_RANGE,
  RANGES,
  TMS_SYNC_STATES,
  exportParams,
  hasFilters,
  parseCallQuery,
} from "../src/lib/callParams.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const parse = (qs) => parseCallQuery(new URLSearchParams(qs));

test("the TMS exceptions view survives the round trip into the export link", () => {
  const { query, invalid } = parse("outcome=booked&tms=ambiguous&range=30d");
  assert.deepEqual(invalid, []);
  assert.equal(query.tms, "ambiguous");

  const out = exportParams(query);
  assert.equal(out.get("tms"), "ambiguous", "tms MUST reach the CSV export");
  assert.equal(out.get("outcome"), "booked");
  assert.equal(out.get("range"), "30d");
});

test("every non-empty filter is carried into the export query string", () => {
  const qs =
    "range=30d&outcome=booked&environment=prod&q=chicago&mc=445120&tms=failed&flagged=1";
  const { query, invalid } = parse(qs);
  assert.deepEqual(invalid, []);

  const out = exportParams(query);
  for (const [key, value] of Object.entries(query)) {
    if (value === "" || value === false) continue;
    const expected = value === true ? "1" : String(value);
    assert.equal(out.get(key), expected, `filter "${key}" is missing from the export params`);
  }
  // …and nothing that was not asked for.
  assert.deepEqual([...out.keys()].sort(), [
    "environment",
    "flagged",
    "mc",
    "outcome",
    "q",
    "range",
    "tms",
  ]);
});

test("the export handler applies tms in SQL, not over the fetched page", () => {
  const route = read("src/app/api/export/calls/route.ts");
  assert.match(route, /tms:\s*query\.tms/, "export route must pass tms into getCallLog");

  const queries = read("src/lib/queries.ts");
  assert.match(queries, /if \(f\.tms\) parts\.push/, "callWhere must build a tms predicate");

  const page = read("src/app/(console)/calls/page.tsx");
  assert.doesNotMatch(
    page,
    /\.filter\(\s*\(\s*r\s*\)\s*=>\s*r\.tmsSyncState/,
    "tms must not be re-introduced as a client-side filter over the fetched rows",
  );
});

test("unknown filter values are reported, never silently relabelled", () => {
  const { query, invalid } = parse("range=90d&outcome=teleported&tms=maybe");
  assert.deepEqual(invalid.sort(), ["outcome", "range", "tms"]);
  assert.equal(query.range, DEFAULT_RANGE, "an unknown range must fall back to the labelled default");
  assert.equal(query.outcome, "");
  assert.equal(query.tms, "");
});

test("the tms vocabulary matches what the booking service writes", () => {
  assert.deepEqual([...TMS_SYNC_STATES].sort(), ["ambiguous", "failed", "pending", "synced"]);
  for (const state of TMS_SYNC_STATES) {
    assert.equal(parse(`tms=${state}`).query.tms, state);
  }
});

test("hasFilters tracks the narrowings, including tms", () => {
  assert.equal(hasFilters(parse("").query), false);
  assert.equal(hasFilters(parse("tms=failed").query), true);
  assert.equal(hasFilters(parse(`range=${Object.keys(RANGES).find((r) => r !== DEFAULT_RANGE)}`).query), true);
});

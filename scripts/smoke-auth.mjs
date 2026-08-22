#!/usr/bin/env node
/**
 * Auth smoke test — the Day-5 checklist item from the delivery plan's risk 13:
 * "an unauthenticated curl of every /api/* route returns 401".
 *
 *   npm run dev                      # in one shell
 *   npm run smoke:auth               # in another
 *   BASE=https://<slug>.happyrobot.ai npm run smoke:auth
 *
 * Exits non-zero if anything is reachable without a session.
 */

const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/+$/, "");
const RUN = "deadbee0-0000-4000-8000-000000000000";

const MUST_401 = [
  "/api/kpis",
  "/api/calls",
  `/api/calls/${RUN}`,
  "/api/carriers",
  "/api/export/calls",
  `/api/export/calls/${RUN}`,
];

const MUST_REDIRECT = ["/", "/calls", `/calls/${RUN}`, "/carriers"];

const MUST_200_PUBLIC = ["/api/health", "/login"];

let failures = 0;

function report(label, path, actual, expectation) {
  const ok = expectation(actual);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(22)} ${path.padEnd(56)} ${actual}`);
}

async function status(path, redirect = "manual") {
  const res = await fetch(BASE + path, { redirect, headers: { Accept: "*/*" } });
  return res.status;
}

console.log(`Auth smoke test against ${BASE}\n`);

for (const p of MUST_401) {
  report("unauthenticated API", p, await status(p), (s) => s === 401);
}

for (const p of MUST_REDIRECT) {
  report("unauthenticated page", p, await status(p), (s) => s === 307 || s === 302 || s === 303);
}

for (const p of MUST_200_PUBLIC) {
  report("public", p, await status(p), (s) => s === 200);
}

// CVE-2025-29927-style middleware bypass. The console must not care, because
// middleware is not the boundary — the per-handler session check is.
{
  const res = await fetch(`${BASE}/api/kpis`, {
    redirect: "manual",
    headers: {
      "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware",
    },
  });
  report("middleware bypass", "/api/kpis (x-middleware-subrequest)", res.status, (s) => s === 401);
}

// A forged session cookie must not validate: the token is HMAC-signed.
{
  const forged = Buffer.from(
    JSON.stringify({ iss: "hr-carrier-ops-console", sub: "ops", exp: 9999999999 }),
  ).toString("base64url");
  const res = await fetch(`${BASE}/api/kpis`, {
    redirect: "manual",
    headers: { cookie: `hr_ops_session=${forged}.notarealsignature` },
  });
  report("forged cookie", "/api/kpis", res.status, (s) => s === 401);
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

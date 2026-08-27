#!/usr/bin/env node
/**
 * DEMO-READINESS SUITE for the ops console. Needs a RUNNING SERVER.
 *
 *   npm run dev            # in one shell
 *   npm test               # in another — unit tests, then this
 *   npm run test:demo      # this alone
 *   BASE=https://<slug>.happyrobot.ai npm run test:demo
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Four consecutive console regressions were all found by a human clicking, and
 * none by a test. Every check below asserts the OBSERVED SYMPTOM of one of
 * them — the status code, the header, the rendered HTML — never a proxy for it.
 *
 *   #1 auth bypass       `{"password":"…"}` with no `user` field returned 200
 *                        and a valid session, because a missing username was
 *                        defaulted to the configured one.   -> group B
 *   #2 login did nothing the client bundle had not hydrated, so the browser
 *                        submitted the form NATIVELY; with no method/action
 *                        that was a GET, which put the password in the address
 *                        bar and reloaded the same page.    -> groups A and C
 *   #3 no error shown    a failed native submit rendered a blank form, because
 *                        the no-JS path could not reach React state. -> group D
 *   #4 500 on /login     `Cannot find module './873.js'` — a production
 *                        `npm run build` clobbered the running dev server's
 *                        `.next`.                           -> groups E and F
 *
 * A NOTE ON THE PRESENTER'S BROWSER. The no-JS path in group A is not an edge
 * case: it is what a real browser does whenever hydration is slow, blocked or
 * broken. It is the path most likely to be live during a recording, so it is
 * checked first and it is checked hardest.
 *
 * CREDENTIALS come from app/.env.local (or the environment). They are never
 * printed: every line this script emits goes through redact().
 *
 * TWO MODES.
 *   (default)  everything below. 6 deliberately-failing sign-ins. ~12s.
 *   --quick    everything EXCEPT the checks that spend the login-throttle
 *              budget: one failing sign-in instead of nine, and smoke-auth.mjs
 *              is left to `npm run smoke:auth`. This is the form `make smoke`
 *              runs, because that command is run after every apply and a suite
 *              that locks sign-in when you run it three times is a suite that
 *              breaks the demo it is meant to protect. `npm test` runs the full
 *              form.
 *   --json     append one machine-readable SMOKE_JSON line for platform/verify.py.
 *
 * COST AGAINST THE LOGIN THROTTLE. Group B makes 6 deliberately-failing sign-in
 * attempts. Each is charged to the console's process-wide budget of 20 failures
 * per 15 minutes (src/lib/auth.ts), so roughly three runs in a 15-minute window
 * will lock out NEW sign-ins. Each attempt uses a fresh X-Forwarded-For so the
 * per-client bucket the presenter's own browser lands in is never touched, and
 * the last check in group B proves sign-in still works after the group ran —
 * if the budget is spent, this suite tells you, rather than the demo.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const QUICK = process.argv.includes("--quick");
const JSON_OUT = process.argv.includes("--json");

const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/+$/, "");
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/.test(BASE);

/** The one run with a complete audit trail. Older calls predate the adapter's
 *  Twin writes and render an EMPTY detail screen — a presenter who opens one of
 *  those on camera sees a blank page and cannot tell it from a broken one. */
const DEMO_RUN = process.env.DEMO_RUN_ID || "47eeee21-3619-4c5f-9dd4-67ac40e102cc";

/** How long to wait for the server before giving up. Polled, never slept. */
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 15_000);

function loadEnvLocal() {
  const path = join(appRoot, ".env.local");
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileEnv = loadEnvLocal();
const USER = process.env.OPS_CONSOLE_USER || fileEnv.OPS_CONSOLE_USER || "ops";
const PASSWORD = process.env.OPS_CONSOLE_PASSWORD || fileEnv.OPS_CONSOLE_PASSWORD || "";
const SESSION_SECRET = process.env.OPS_SESSION_SECRET || fileEnv.OPS_SESSION_SECRET || "";

/** Nothing this process prints may contain the credential. */
function redact(s) {
  let out = String(s);
  if (PASSWORD) {
    out = out.split(PASSWORD).join("<password>");
    out = out.split(encodeURIComponent(PASSWORD)).join("<password>");
  }
  return out;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";
const SKIP = "skip";

const checks = [];
let group = "";

function heading(name) {
  group = name;
  console.log(`\n${name}`);
}

/**
 * One assertion. `detail` describes what was OBSERVED — either way, so a green
 * run is readable evidence and not just a row of ticks. `fix` names the command
 * or the file that makes it green again.
 */
function expect(name, cond, detail, fix = "") {
  const status = cond ? PASS : FAIL;
  checks.push({ group, name, status, detail: redact(detail), fix });
  console.log(`  [${cond ? "ok  " : "FAIL"}] ${name}  — ${redact(detail)}`);
  return cond;
}

function warn(name, detail, fix = "") {
  checks.push({ group, name, status: WARN, detail: redact(detail), fix });
  console.log(`  [warn] ${name}  — ${redact(detail)}`);
}

function skip(name, detail) {
  checks.push({ group, name, status: SKIP, detail: redact(detail), fix: "" });
  console.log(`  [skip] ${name}  — ${redact(detail)}`);
}

function note(text) {
  console.log(`         ${redact(text)}`);
}

// ---------------------------------------------------------------------------
// http, with a standing credentials-in-URL guard
// ---------------------------------------------------------------------------

/**
 * Failure #2 leaked BOTH the username and the password into the address bar
 * and the access log. Rather than test that once, every URL this suite touches
 * — request target and `Location` header alike — is screened, so any future
 * route that starts echoing credentials fails whichever check provoked it.
 */
const leaks = [];

function urlLeak(url) {
  if (!url) return null;
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* keep the raw form */
  }
  if (PASSWORD && (url.includes(PASSWORD) || decoded.includes(PASSWORD))) {
    return "the password value appears in the URL";
  }
  if (/[?&#](password|passwd|pass|pw)=/i.test(url)) {
    return "a password parameter appears in the URL";
  }
  if (/[?&#](user|username|login|u)=/i.test(url)) {
    return "a username parameter appears in the URL";
  }
  return null;
}

function screen(url, where) {
  const leak = urlLeak(url);
  if (leak) leaks.push({ where, url: redact(url), leak });
  return leak;
}

async function req(path, init = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  screen(url, "request target");
  const res = await fetch(url, { redirect: "manual", ...init });
  screen(res.headers.get("location"), `Location of ${path}`);
  return res;
}

/** Node's fetch keeps multiple Set-Cookie headers separate; take ours. */
function sessionCookie(res) {
  const all = res.headers.getSetCookie?.() ?? [];
  for (const c of all) {
    const m = /^hr_ops_session=([^;]*)/.exec(c);
    if (m && m[1]) return { value: m[1], raw: c };
  }
  return null;
}

const cookieHeader = (token) => ({ cookie: `hr_ops_session=${token}` });

/** A fresh client identity per deliberate failure, so group B never locks the
 *  bucket the presenter's own browser (which sends no X-Forwarded-For) uses. */
let xff = 0;
const freshClient = () => ({ "X-Forwarded-For": `203.0.113.${(xff++ % 250) + 1}` });

function form(fields) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

function jsonBody(body, extraHeaders = {}) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** Markers of a server-side blow-up that a browser shows and curl does not. */
const ERROR_MARKERS = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Internal Server Error",
  "Application error: a server-side exception",
  "__next_error__",
];

function crashMarker(html) {
  return ERROR_MARKERS.find((m) => html.includes(m)) || null;
}

// ---------------------------------------------------------------------------
// preflight: is the server up?
// ---------------------------------------------------------------------------

async function waitForServer() {
  const deadline = Date.now() + WAIT_MS;
  let last = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { redirect: "manual" });
      if (res.status === 200) return true;
      last = `GET /api/health -> ${res.status}`;
    } catch (err) {
      last = err?.cause?.code || err?.code || String(err?.message || err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`\nNo console at ${BASE} after ${WAIT_MS}ms (${redact(last)}).`);
  return false;
}

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

/** The existing auth boundary smoke, run verbatim so nothing it covers is lost. */
function groupAuthSmoke() {
  heading("0. auth boundary — scripts/smoke-auth.mjs (unchanged, run verbatim)");
  const r = spawnSync(process.execPath, [join(here, "smoke-auth.mjs")], {
    cwd: appRoot,
    encoding: "utf8",
    env: { ...process.env, BASE },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  for (const line of out.split("\n")) {
    if (line.trim()) console.log(`    | ${redact(line)}`);
  }
  expect(
    "smoke-auth.mjs exits clean",
    r.status === 0,
    r.status === 0 ? "every route it covers behaves" : `exit ${r.status}`,
    "read the FAIL lines above; the boundary is src/lib/auth.ts",
  );
}

/**
 * GROUP A — the login journey with JavaScript disabled.
 *
 * This is failure #2 end to end: a native url-encoded POST must 303 to the
 * console, set the session cookie, and land on a page that renders REAL DATA.
 * "Rendered the login page again" is what the bug looked like, so a 200 alone
 * proves nothing — the landed page is asserted to contain console data and to
 * NOT contain a password field.
 */
async function groupNoJsLogin() {
  heading("A. the login journey with JavaScript disabled (failure #2)");

  // The served HTML must be submittable without React. No method/action is
  // exactly what made the browser fall back to a GET.
  const loginPage = await req("/login");
  const html = await loginPage.text();
  const tag = /<form[^>]*>/.exec(html)?.[0] ?? "";
  const method = /method="([^"]*)"/i.exec(tag)?.[1] ?? "(none)";
  const action = /action="([^"]*)"/i.exec(tag)?.[1] ?? "(none)";
  expect(
    "the served form natively POSTs to the API",
    method.toLowerCase() === "post" && action === "/api/auth/login",
    `<form method="${method}" action="${action}">`,
    "restore method/action on the <form> in src/app/login/LoginForm.tsx — "
      + "without them an unhydrated browser GETs, and the password goes in the URL",
  );

  const res = await req("/api/auth/login", form({ user: USER, password: PASSWORD, next: "/" }));
  const location = res.headers.get("location");
  expect(
    "native POST redirects with 303",
    res.status === 303,
    `POST (url-encoded) -> ${res.status}, Location ${location ?? "(none)"}`,
    "src/app/api/auth/login/route.ts must accept x-www-form-urlencoded and 303",
  );
  expect(
    "it redirects to the console, not back to /login",
    location === "/",
    `Location: ${location ?? "(none)"}`,
    "the no-JS path must honour `next`; a bounce back to /login is failure #2",
  );

  const cookie = sessionCookie(res);
  expect(
    "the native POST sets the session cookie",
    Boolean(cookie),
    cookie ? "hr_ops_session set, HttpOnly=" + /httponly/i.test(cookie.raw) : "no Set-Cookie",
    "the no-JS path must issue a session, not just redirect",
  );
  if (cookie) {
    expect(
      "the session cookie is HttpOnly and scoped to /",
      /httponly/i.test(cookie.raw) && /path=\//i.test(cookie.raw),
      cookie.raw.replace(/hr_ops_session=[^;]*/, "hr_ops_session=<token>"),
      "set httpOnly and path:/ on the cookie in the login route",
    );
  }
  if (!cookie) return null;

  // Follow the chain the browser would follow, and land somewhere real.
  let url = location;
  let hops = 0;
  let landed = res;
  let body = "";
  while (url && hops < 5) {
    hops += 1;
    landed = await req(url, { headers: cookieHeader(cookie.value) });
    if (landed.status >= 300 && landed.status < 400) {
      url = landed.headers.get("location");
      continue;
    }
    body = await landed.text();
    break;
  }
  expect(
    "the landed page renders real console data",
    landed.status === 200 && body.includes("Calls in window") && !body.includes('name="password"'),
    `${hops} hop(s) -> ${landed.status}, ${body.length} bytes, `
      + `KPI present=${body.includes("Calls in window")}, `
      + `password field present=${body.includes('name="password"')}`,
    "signing in must land on the overview; a login form here is failure #2",
  );
  expect(
    "no crash markers on the landed page",
    crashMarker(body) === null,
    crashMarker(body) ?? "clean HTML",
    "stop the dev server, `rm -rf .next`, `npm run dev`",
  );

  return cookie.value;
}

/**
 * GROUP B — the auth boundary, adversarially. Failure #1 is the first case.
 * Every one of these must be refused; a 200 is a bypass.
 */
async function groupAdversarialAuth(goodToken) {
  heading("B. the auth boundary, adversarially (failure #1)");

  const attempts = [
    ["omitted `user` field", { password: PASSWORD }],
    ["omitted `password` field", { user: USER }],
    ["empty strings for both", { user: "", password: "" }],
    ["empty password, right user", { user: USER, password: "" }],
    ["wrong user, right password", { user: `${USER}-not`, password: PASSWORD }],
    ["right user, wrong password", { user: USER, password: "definitely-not-it" }],
  ];

  for (const [label, body] of attempts) {
    const res = await req("/api/auth/login", jsonBody(body, freshClient()));
    const set = sessionCookie(res);
    expect(
      label,
      res.status === 401 && !set,
      `POST /api/auth/login -> ${res.status}${set ? " AND SET A SESSION COOKIE" : ", no cookie"}`,
      "src/app/api/auth/login/route.ts: an absent field is an EMPTY value, "
        + "never the configured one",
    );
  }

  // The same omission through the no-JS path, which takes a different branch.
  {
    const res = await req("/api/auth/login", { ...form({ password: PASSWORD }), headers: { "Content-Type": "application/x-www-form-urlencoded", ...freshClient() } });
    const set = sessionCookie(res);
    const loc = res.headers.get("location") ?? "";
    expect(
      "omitted `user`, url-encoded (the no-JS branch)",
      res.status === 303 && loc.startsWith("/login") && !set,
      `-> ${res.status}, Location ${loc || "(none)"}${set ? " AND SET A SESSION COOKIE" : ", no cookie"}`,
      "the form branch must reject the same bodies the JSON branch rejects",
    );
  }

  // Session cookies that must not validate. Each is checked on an API route
  // (401) and on a page (redirect to /login) — never a 200 either way.
  const forgedPayload = Buffer.from(
    JSON.stringify({ iss: "hr-carrier-ops-console", sub: USER, exp: 9999999999 }),
  ).toString("base64url");

  const bad = [["forged token, invented signature", `${forgedPayload}.notarealsignature`]];

  if (goodToken) {
    const [payload, sig] = [goodToken.slice(0, goodToken.lastIndexOf(".")), goodToken.slice(goodToken.lastIndexOf(".") + 1)];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const tampered = Buffer.from(JSON.stringify({ ...claims, sub: "somebody-else" })).toString("base64url");
    bad.push(["tampered payload, original signature", `${tampered}.${sig}`]);
  }

  const key = signingKey();
  if (key) {
    bad.push(["a correctly signed but EXPIRED session", signedToken(key, { expDelta: -60 })]);
    bad.push(["a correctly signed token from another issuer", signedToken(key, { iss: "somebody-elses-console" })]);
  } else {
    skip("a correctly signed but EXPIRED session", "no OPS_SESSION_SECRET/OPS_CONSOLE_PASSWORD to sign with");
  }

  for (const [label, token] of bad) {
    const api = await req("/api/kpis", { headers: cookieHeader(token) });
    const page = await req("/", { headers: cookieHeader(token) });
    const pageLoc = page.headers.get("location") ?? "";
    const pageOk = page.status >= 300 && page.status < 400 && pageLoc.includes("/login");
    expect(
      label,
      api.status === 401 && pageOk,
      `/api/kpis -> ${api.status}; / -> ${page.status}${pageLoc ? ` ${pageLoc}` : ""}`,
      "verifyToken() in src/lib/auth.ts must reject this token",
    );
  }

  // Proof the group did not spend the process-wide failure budget: a real
  // sign-in must still work. If this is the only red line, restart the server.
  const recover = await req("/api/auth/login", form({ user: USER, password: PASSWORD, next: "/" }));
  expect(
    "sign-in still works after the adversarial group",
    recover.status === 303 && Boolean(sessionCookie(recover)),
    `POST -> ${recover.status}`,
    "the process-wide login throttle is spent (20 failures / 15 min). "
      + "Restart the dev server to clear it before recording.",
  );
  note("group B spent 6 of the console's 20-per-15-minute failed-login budget.");

  return sessionCookie(recover)?.value ?? goodToken;
}

/** The console's session-signing key, derived exactly as src/lib/auth.ts does. */
function signingKey() {
  if (SESSION_SECRET && SESSION_SECRET.length >= 16) {
    return crypto.createHash("sha256").update(SESSION_SECRET).digest();
  }
  if (PASSWORD) {
    return crypto
      .createHash("sha256")
      .update(`hr-carrier-ops-console:derived:${PASSWORD}`)
      .digest();
  }
  return null;
}

function signedToken(key, { expDelta = 3600, iss = "hr-carrier-ops-console" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss, sub: USER, iat: now - 10, exp: now + expDelta, jti: "smoke" }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * GROUP C — credentials never appear in a URL (failure #2's other half).
 */
async function groupNoCredsInUrls() {
  heading("C. credentials never appear in a URL (failure #2)");

  // A failed native submit is the case that leaked: it has to hand a message
  // back through the URL, so it is the one place the credentials could ride along.
  const failed = await req("/api/auth/login", {
    ...form({ user: USER, password: "definitely-not-it", next: "/calls" }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...freshClient() },
  });
  const loc = failed.headers.get("location") ?? "";
  expect(
    "a failed native submit redirects without the credentials",
    failed.status === 303 && urlLeak(loc) === null && loc.startsWith("/login"),
    `Location: ${loc || "(none)"}${urlLeak(loc) ? ` — ${urlLeak(loc)}` : ""}`,
    "the login route must build its redirect from `next`/`error` only",
  );

  // …and the page it lands on must not echo them either.
  if (loc) {
    const landed = await req(loc);
    const body = await landed.text();
    expect(
      "the page it lands on does not echo the password",
      !PASSWORD || !body.includes(PASSWORD),
      `${landed.status}, ${body.length} bytes, password in body=${PASSWORD ? body.includes(PASSWORD) : "n/a"}`,
      "never render a submitted credential back into the HTML",
    );
  }

  expect(
    "no URL touched by this suite carried a credential",
    leaks.length === 0,
    leaks.length === 0
      ? `${checks.length} checks so far, 0 leaking URLs`
      : leaks.map((l) => `${l.where}: ${l.leak} (${l.url})`).join("; "),
    "a credential reached the address bar and the access log — this is failure #2",
  );
}

/**
 * GROUP D — a failed login tells the user something (failure #3).
 * Both paths, and for the native one the message must be in the RENDERED HTML,
 * because "the redirect carried an error code" is exactly what was true while
 * the user was looking at a blank form.
 */
async function groupFailedLoginMessages() {
  heading("D. a failed login tells the user something (failure #3)");

  const asJson = await req(
    "/api/auth/login",
    jsonBody({ user: USER, password: "definitely-not-it" }, freshClient()),
  );
  const body = await asJson.json().catch(() => ({}));
  expect(
    "the JSON path returns a message",
    asJson.status === 401 && typeof body.message === "string" && body.message.length > 0,
    `${asJson.status}: ${JSON.stringify(body.message ?? null)}`,
    "the 401 body must carry `message`; LoginForm.tsx renders it",
  );
  expect(
    "the message does not distinguish a wrong user from a wrong password",
    typeof body.message === "string" && /invalid credentials/i.test(body.message),
    JSON.stringify(body.message ?? null),
    "keep the wrong-user and wrong-password responses identical",
  );

  const native = await req("/api/auth/login", {
    ...form({ user: USER, password: "definitely-not-it", next: "/" }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...freshClient() },
  });
  const loc = native.headers.get("location") ?? "";
  const landed = loc ? await req(loc) : native;
  const html = loc ? await landed.text() : "";
  const rendered = /Invalid credentials|Too many failed attempts/.test(html);
  expect(
    "the native path RENDERS a message on the page it lands on",
    native.status === 303 && landed.status === 200 && rendered,
    `303 -> ${loc || "(none)"} -> ${landed.status}, message rendered=${rendered}`,
    "src/app/login/page.tsx must turn ?error= into visible text — a blank form "
      + "after a failed submit is failure #3",
  );
}

/**
 * GROUP E — every route a demo touches actually renders. Failure #4 was a 500
 * that only ever appeared in a browser.
 */
async function groupRoutesRender(token, mc) {
  heading("E. every route a demo touches renders (failure #4)");

  const pages = ["/", "/calls", `/calls/${DEMO_RUN}`, "/carriers"];
  if (mc) pages.push(`/carriers/${mc}`);
  else skip("/carriers/{mc}", "no MC available from the demo run's detail");

  for (const p of pages) {
    const res = await req(p, { headers: cookieHeader(token) });
    const html = res.status === 200 ? await res.text() : "";
    const marker = crashMarker(html);
    expect(
      `page ${p}`,
      res.status === 200 && !marker && html.length > 2000,
      `${res.status}, ${html.length} bytes${marker ? `, CRASH: ${marker}` : ""}`,
      "open it in a browser; a 500 here is a clobbered .next — stop the dev "
        + "server, `rm -rf .next`, `npm run dev`",
    );
  }

  const apis = [
    "/api/health",
    "/api/kpis",
    "/api/calls",
    `/api/calls/${DEMO_RUN}`,
    "/api/carriers",
    "/api/export/calls",
    `/api/export/calls/${DEMO_RUN}`,
  ];
  for (const p of apis) {
    const res = await req(p, { headers: cookieHeader(token) });
    const text = await res.text();
    expect(
      `api  ${p}`,
      res.status === 200 && text.length > 0,
      `${res.status}, ${text.length} bytes`,
      "a non-200 here is a broken screen in the demo",
    );
  }

  // The unauthenticated entry point the presenter actually starts on.
  const login = await req("/login");
  const loginHtml = await login.text();
  expect(
    "page /login (unauthenticated)",
    login.status === 200 && !crashMarker(loginHtml) && loginHtml.includes("Sign in"),
    `${login.status}, ${loginHtml.length} bytes${crashMarker(loginHtml) ? `, CRASH: ${crashMarker(loginHtml)}` : ""}`,
    "this is the first screen of the demo; a 500 here is failure #4",
  );
}

/**
 * GROUP F — the call-detail screen has content.
 *
 * Older calls predate the adapter's Twin writes and render empty detail rows.
 * A presenter who opens one of those on camera sees a blank screen, so the
 * assertion is that the RIGHT call renders each part of the audit trail.
 */
async function groupCallDetailContent(token) {
  heading("F. the call-detail screen has content");

  const res = await req(`/calls/${DEMO_RUN}`, { headers: cookieHeader(token) });
  const html = res.status === 200 ? await res.text() : "";

  const required = [
    ["the FMCSA verification event", "FMCSA authority verified"],
    ["the OTP attempts", "Identity code"],
    ["the load offer from the TMS search", "returned by the TMS search"],
    ["the negotiation round", "opening pitch"],
    ["the booking", "Booking written at"],
  ];
  for (const [label, marker] of required) {
    expect(
      `renders ${label}`,
      html.includes(marker),
      `"${marker}" present=${html.includes(marker)} in ${html.length} bytes`,
      `the detail screen for ${DEMO_RUN} is missing this row — check Twin still `
        + "holds the audit trail for that run (`make smoke`)",
    );
  }

  expect(
    "no empty-state placeholders on the demo call",
    !/No negotiation on this call/.test(html),
    /No negotiation on this call/.test(html)
      ? "the negotiation card rendered its empty state"
      : "no empty-state card rendered",
    "this run must have a complete audit trail; pick a different DEMO_RUN_ID "
      + "or re-seed",
  );

  // Not a failure: the newest call is what a presenter clicks by reflex.
  const list = await req("/api/calls", { headers: cookieHeader(token) });
  const rows = list.status === 200 ? (await list.json()).rows ?? [] : [];
  const newest = rows[0]?.runId;
  if (!newest) {
    skip("the newest call is the one with the audit trail", "no rows in /api/calls");
  } else if (newest === DEMO_RUN) {
    expect("the newest call is the one with the audit trail", true, `newest run is ${newest}`);
  } else {
    warn(
      "the newest call is the one with the audit trail",
      `newest is ${newest}, but the complete trail is on ${DEMO_RUN}`,
      "open the DEMO_RUN call explicitly during the demo — the top row will "
        + "render an empty detail screen",
    );
  }
}

/**
 * GROUP G — the build is not stale (failure #4's root cause).
 *
 * WHAT WE CHOSE AND WHY. Failure #4 was a running `next dev` whose `.next` had
 * been overwritten by a production `npm run build`: the server's chunk map then
 * pointed at chunks that no longer existed, and `/login` 500'd with
 * `Cannot find module './873.js'`.
 *
 * Two guards, cheapest first:
 *
 *  1. EVERY `/_next/static/*` asset the rendered pages reference must actually
 *     be served. This is the observable form of the failure, it needs no
 *     knowledge of the filesystem so it works against a deployment too, and it
 *     catches the case one step earlier than a 500 does: a missing chunk is
 *     also a page that never hydrates, which is failure #2's trigger.
 *  2. When BASE is local, the on-disk shape of `.next` must be a dev build —
 *     `static/development` present, no `BUILD_ID`. This one names the fix.
 *
 * A dedicated health route was the other option and was rejected: `/api/health`
 * has no page code in it, so it answers 200 from a `.next` that cannot render a
 * single screen. Group E's render probe is the real health check.
 */
async function groupBuildNotStale(token) {
  heading("G. the build is not stale (failure #4)");

  const assets = new Set();
  for (const p of ["/login", "/", `/calls/${DEMO_RUN}`]) {
    const res = await req(p, { headers: cookieHeader(token) });
    if (res.status !== 200) continue;
    const html = await res.text();
    for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) {
      assets.add(m[1].replace(/&amp;/g, "&"));
    }
  }

  if (assets.size === 0) {
    expect("pages reference client assets", false, "no /_next/static/* references found",
      "the pages rendered no client bundle at all — the app cannot hydrate");
  } else {
    const broken = [];
    for (const a of assets) {
      const res = await req(a);
      const len = Number(res.headers.get("content-length") ?? 1);
      if (res.status !== 200 || len === 0) broken.push(`${a} -> ${res.status}`);
    }
    expect(
      "every client asset the pages reference is served",
      broken.length === 0,
      broken.length === 0
        ? `${assets.size} asset(s), all 200`
        : `${broken.length} of ${assets.size} broken: ${broken.slice(0, 3).join(", ")}`,
      "the server is serving a .next that no longer matches its chunks — stop "
        + "the dev server, `rm -rf .next`, `npm run dev`. Never run "
        + "`npm run build` while `npm run dev` is up.",
    );
  }

  if (!LOCAL) {
    skip("the served .next is a dev build", `BASE is ${BASE}, not a local dev server`);
    return;
  }
  const next = join(appRoot, ".next");
  if (!existsSync(next)) {
    skip("the served .next is a dev build", "no .next directory beside this script");
    return;
  }
  const devMarker = existsSync(join(next, "static", "development"));
  const prodMarker = existsSync(join(next, "BUILD_ID"));
  expect(
    "the served .next is a dev build, not a clobbered one",
    devMarker && !prodMarker,
    `static/development=${devMarker}, BUILD_ID=${prodMarker}`,
    "a production `npm run build` has overwritten the dev server's .next — "
      + "stop the dev server, `rm -rf .next`, `npm run dev`",
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Console demo-readiness suite — ${BASE}`);
  console.log("Every check below needs a running server (npm run dev).");

  if (!PASSWORD) {
    console.log(
      "\nNo OPS_CONSOLE_PASSWORD in app/.env.local or the environment. "
        + "This suite signs in; it cannot run without the credential.",
    );
    return 2;
  }

  if (!(await waitForServer())) {
    console.log(
      process.env.SMOKE_ALLOW_NO_SERVER === "1"
        ? "SMOKE_ALLOW_NO_SERVER=1 — skipping the whole suite. "
          + "NOTHING about the demo has been checked."
        : "\nSTART THE SERVER AND RUN THIS AGAIN:\n"
          + "    cd app && npm run dev        # one shell\n"
          + "    cd app && npm test           # another\n"
          + "  (set SMOKE_ALLOW_NO_SERVER=1 to downgrade this to a skip)",
    );
    return process.env.SMOKE_ALLOW_NO_SERVER === "1" ? 0 : 1;
  }

  groupAuthSmoke();
  let token = await groupNoJsLogin();
  token = await groupAdversarialAuth(token);
  await groupNoCredsInUrls();
  await groupFailedLoginMessages();

  if (!token) {
    console.log("\nNo session could be established — the rest of the suite cannot run.");
  } else {
    let mc = null;
    try {
      const d = await req(`/api/calls/${DEMO_RUN}`, { headers: cookieHeader(token) });
      if (d.status === 200) mc = (await d.json())?.carrier?.mcNumber ?? null;
    } catch {
      /* group E reports the MC route as skipped */
    }
    await groupRoutesRender(token, mc);
    await groupCallDetailContent(token);
    await groupBuildNotStale(token);
  }

  // ------------------------------------------------------------------ report
  const failed = checks.filter((c) => c.status === FAIL);
  const warned = checks.filter((c) => c.status === WARN);
  const skipped = checks.filter((c) => c.status === SKIP);
  const passed = checks.filter((c) => c.status === PASS);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`CONSOLE DEMO READINESS — ${BASE}`);
  console.log("=".repeat(78));
  if (failed.length === 0) {
    console.log(
      `OK — ${passed.length} checks passed`
        + (warned.length ? `, ${warned.length} warning(s)` : "")
        + (skipped.length ? `, ${skipped.length} skipped` : "")
        + ". The console is safe to demo.",
    );
    for (const w of warned) console.log(`  ~ ${w.name}\n      ${w.detail}\n      ${w.fix}`);
    return 0;
  }
  console.log(
    `FAILED — ${failed.length} of ${checks.length} checks. `
      + "DO NOT RECORD until these are green.\n",
  );
  for (const c of failed) {
    console.log(`  ! [${c.group.split(".")[0]}] ${c.name}`);
    console.log(`      observed: ${c.detail}`);
    if (c.fix) console.log(`      fix:      ${c.fix}`);
  }
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\nSuite crashed: ${redact(err?.stack || err)}`);
    process.exit(2);
  },
);

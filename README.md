# Carrier Sales Operations Console

The operational UI for HappyRobot Logistics' inbound carrier-sales agent.

> **Challenge requirement (p.4, "Operational UI"):** *"A custom internal app (HappyRobot Apps) must surface key operational signals and actions for the brokerage's operations manager — without accessing raw platform logs."*
>
> **The pain it answers (p.1):** *"No audit trail — there is no structured record of what was said, offered, or agreed on each call, making disputes difficult to resolve."*

This console reads the **Twin system of record** and nothing else. It never touches `/runs`, `/sessions`, or any other platform log endpoint, and it never writes to Twin.

Next.js 15 App Router · TypeScript · zero runtime dependencies beyond React · no CDN, no external fonts, no remote assets (a strict CSP blocks them all).

---

## Run it locally against the live Twin

```bash
cd app
cp .env.local.example .env.local     # then fill in TWIN_API_KEY + OPS_CONSOLE_PASSWORD
npm install
npm run dev                          # http://localhost:3000
```

Sign in with `OPS_CONSOLE_USER` / `OPS_CONSOLE_PASSWORD`.

No App needs to exist on the platform for this to work — the console talks to the platform API directly, so it is demoable before step 8 of the delivery plan is done.

### Demo data

The Twin database is live but starts empty. To populate it with a realistic set of 14 calls across every outcome the workflow can produce:

```bash
npm run seed:demo     # write
npm run seed:purge    # remove every trace
```

The seeder is **fully reversible by construction**: every seeded call uses a `run_id` in the reserved `deadbee0-…` namespace with `environment='demo'`, detail rows come out via the schema's own `ON DELETE CASCADE`, and `call_outcomes` (no FK, because the run dump provisions it) plus the seeded carrier rows are removed by the same reserved keys. It never touches a row it did not create. **Purge it before the workflow's real runs matter.**

---

## Screens

| Screen | Path | What it answers |
|---|---|---|
| **Overview** | `/` | Is the desk healthy right now? Eight KPI tiles plus a compliance block, outcome mix, and 14-day volume — every number a Twin SQL aggregate, because the platform has no analytics API. |
| **Call log** | `/calls` | Which call do I need? A filterable join of `calls ⋈ call_outcomes ⋈ carriers ⋈ load_offers ⋈ bookings ⋈ negotiation_rounds` with outcome, MC, lane, posted/agreed rate, rounds, TMS state, duration and compliance flags. Filters live in the URL, so any view is a pasteable link. |
| **Call detail — the audit trail** | `/calls/{run_id}` | **The dispute-resolution screen.** For one run: the FMCSA verification event, every OTP attempt, every load returned by the search with the pitched one marked, every negotiation round with actor / amount / result rendered against the ceiling, the booking and its TMS sync state, the handoff, the run-dump row, and an explicit **ceiling-adherence verdict** with its reasoning. |
| **Carriers** | `/carriers`, `/carriers/{mc}` | Per-MC history: calls, conversion, average agreed rate, failed authority checks, failed identity codes, fraud flags — plus the per-call FMCSA verification history that the current-state `carriers` snapshot cannot give you. |

### KPIs on the overview

| KPI | Source |
|---|---|
| Calls in window / today / distinct MCs | `calls` |
| Booking conversion | `bookings` ÷ `calls` |
| Verification pass rate | `verification_events.verified` |
| OTP failure rate | `otp_attempts` (send rows excluded from the denominator) |
| **Rate-ceiling adherence (target 100%)** | `bookings.agreed_rate ≤ load_offers.load_snapshot→max_buy` |
| Average negotiation rounds (cap 3) | `max(negotiation_rounds.round_no) WHERE actor='agent'` |
| Average agreed vs posted | `bookings.agreed_rate ÷ load_offers.posted_rate` |
| Average call duration, abandoned, in flight | `calls.started_at / ended_at` |
| Fraud signals | `calls.fraud_signal`, ≥3 failed OTP attempts on a run, FMCSA rejections |
| Ceiling-disclosure audit | `calls.ceiling_disclosed` (the native Carrier Sales Auditor node's verdict) |
| TMS sync exceptions | `bookings.tms_sync_state` — `ambiguous` is never auto-retried |

### Ceiling adherence is computed, not trusted

The verdict on the call-detail screen runs **two independent tests** rather than reading one column:

1. **Enforcement** — was the agreed rate at or below `max_buy`?
2. **Disclosure** — did the agent ever quote a number *at or above* the ceiling? Offering exactly `max_buy` **is** disclosing `max_buy`; the ladder must asymptote to it and never reach it.

The native **Carrier Sales Auditor** node's post-call verdict (`calls.ceiling_disclosed`) is then shown as a third, independent opinion. A breach on any of the three turns the verdict red.

`max_buy` is read from `load_offers.load_snapshot` — the only place in Twin that holds it, and one no workflow node selects before the voice agent terminates. **The console can show it; the agent still cannot.**

---

## Actions the ops manager can take

Deliberately short, because the console is read-only and the workflow owns every write. Nothing here pretends to do something it cannot.

| Action | Where | What it does |
|---|---|---|
| **Export audit trail (CSV)** | Call detail | One call, every event in order, with actor / amount / UTC timestamp, plus the ceiling verdict and its reasoning. This is the artifact you attach to a dispute. |
| **Export call log (CSV)** | Call log | The current filtered view, up to Twin's 500-row cap. RFC 4180 escaped, with formula-injection guarding on any cell derived from carrier speech. |
| **Filter / saved views** | Call log, carriers | Every filter is a URL parameter. "Flagged calls" and "TMS exceptions" in the sidebar are exactly that. |
| **Copy run ID / MC / TMS reference** | Detail screens | The micro-action every ops workflow starts with. |
| **Refresh** | Every screen | Re-queries Twin. Nothing is cached — `Cache-Control: no-store` everywhere. |

**Not shipped, on purpose:** anything that mutates. Re-driving a TMS booking, clearing a fraud flag or resolving an ambiguous write would need a write path into the adapter and the TMS, and the constraint for this build is a read-only console that never contacts the real TMS. The ambiguous-booking card tells the operator exactly what the resolution procedure is (the monotonic `ALREADY_BOOKED` probe) rather than offering a button that would not work.

---

## Security

### Why the console needs its own auth at all

HappyRobot Apps are served from a **public URL** at `https://<slug>.happyrobot.ai`. Platform RBAC governs who can *edit* an App; nothing in the docs gates the deployed URL, and the Twin-in-Apps page tells you in as many words to *"add your own auth check"*. This console renders `max_buy` and carrier contact details. Without a gate, the operational UI requirement would become a rate-ceiling-disclosure breach.

### Where the check lives

`requireSession()` (server components) and `requireApiSession()` (route handlers) in `src/lib/auth.ts` are called as the **first statement of every screen and every API route that reads data**.

`src/middleware.ts` exists too, but it is explicitly **not** the boundary and says so in its own header comment. Next.js middleware is a routing convenience: **CVE-2025-29927** let a crafted `x-middleware-subrequest` header skip middleware entirely, and the advisory list for the 15.x line contains several further middleware/proxy bypasses. Anything that relies on middleware alone is one header away from public.

`npm run smoke:auth` proves it — including with `src/middleware.ts` deleted:

```
PASS  unauthenticated API    /api/kpis                          401
PASS  unauthenticated API    /api/calls                         401
PASS  unauthenticated API    /api/calls/{run_id}                401
PASS  unauthenticated API    /api/carriers                      401
PASS  unauthenticated API    /api/export/calls                  401
PASS  unauthenticated API    /api/export/calls/{run_id}         401
PASS  unauthenticated page   / /calls /calls/{id} /carriers     307 -> /login
PASS  public                 /api/health  /login                200
PASS  middleware bypass      x-middleware-subrequest header     401
PASS  forged cookie          unsigned session token             401
```

### The credential, stated plainly

> **This is a shared credential scoped to the review window. It is not SSO.**

One username and one password from server-only env vars, an 8-hour HMAC-signed `httpOnly` / `SameSite=Lax` / `Secure` session cookie, and constant-time comparison on both fields. **Production posture** is the customer's IdP in front of the App (or HappyRobot workspace auth once Apps expose the signed-in user to app code) — raised as open question 8 in the summary email. The console **refuses to serve any data** if `OPS_CONSOLE_PASSWORD` is unset; it does not fall back to open access.

**Login throttling:** 6 failures per IP in a 15-minute window, then a 15-minute lockout, with a randomised 250–400 ms floor on every attempt so a wrong username is not measurably faster than a wrong password. The bucket is in-memory — honestly stated: a serverless platform may run several instances, so the effective budget is *(6 × instances)*. That turns an unbounded online guessing attack into a slow one; it is not a substitute for a real IdP.

### Data access

- **Server-side only.** `src/lib/twin.ts` imports `server-only`, so importing it from a client component is a build error, not an incident.
- **Not the Twin gateway.** `NEXT_PUBLIC_TWIN_GATEWAY` authenticates on a bare `x-org-id` header whose value is inlined into the client bundle, and it is a PostgREST-style reflection with no joins and no aggregates. Every screen here is a join or an aggregate. The console uses `POST /api/v2/twin/sql` with `TWIN_API_KEY` — a **server-only** name, never `NEXT_PUBLIC_*`.
- **Read-only by construction.** `assertReadOnly()` rejects anything that is not a single `SELECT`/`WITH` before it leaves the process: no write keywords, no `;`, no multi-statement.
- **No string concatenation.** `POST /twin/sql` has no bind-parameter channel, so every interpolation goes through the `` sql`…` `` tagged template, which escapes on the way in. UUIDs are regex-validated before they reach a query.
- **Caps respected.** 20 s timeout, 500 rows, 1 MB. Aggregation happens in SQL, never in the browser. When a result is truncated the UI says so rather than silently showing a subset.
- **Errors are honest.** A Twin failure surfaces as a real error state naming the cause and the next action. Error text never echoes the query (a Postgres error can carry row values) and never carries the key.

### Untrusted text

Carrier speech reaches `call_outcomes.notes` and `calls.notes` through post-call extraction, so **every Twin-sourced string is untrusted input**. `dangerouslySetInnerHTML` appears nowhere in this codebase and must not; all text goes through JSX interpolation, which React HTML-escapes. CSV cells beginning `= + - @` are prefixed with an apostrophe so a spreadsheet cannot execute them.

Verified live: a note set to `<img src=x onerror="alert(1)"> and Bobby'); DROP TABLE calls;-- <script>alert(2)</script>` renders as `&lt;img src=x onerror=&quot;alert(1)&quot;&gt; …`, the search filter carrying the same string returns rows instead of erroring, and the tables are still there afterwards.

### PII

Carrier email is the only PII in the schema. The console selects **`carrier_contacts.email_masked` only** — the full address is never read into the server response and therefore cannot reach the browser. The OTP code and its hash are never selected at all (`otp_challenges` is not read by any screen).

### Response headers

`X-Frame-Options: DENY` · `X-Content-Type-Options: nosniff` · `Referrer-Policy: no-referrer` · `X-Robots-Tag: noindex` · `Cache-Control: no-store` · a CSP with `default-src 'self'` and `frame-ancestors 'none'` (which is also why there are no CDN dependencies).

---

## Twin type quirks this console handles

Measured against the live database, not assumed. `src/lib/twin.ts` has the helpers; every read path uses them.

| Type | Reads back as | Handling |
|---|---|---|
| `int8` | a JSON **string** (`"2400"`) | `num()` / `count()` cast before any arithmetic. Money is **whole dollars**, never cents. |
| `jsonb` | a real JSON **object** | `jsonb()` returns it as-is. **Never `JSON.parse`.** |
| `boolean` | a real JSON boolean | `bool()` tolerates both. |
| `timestamp` | naive UTC with a cosmetic `.000Z` | `utc()` normalises to a real UTC instant; **every rendered timestamp is formatted in UTC and labelled UTC**, and the top bar carries a live UTC clock. Rendering in the viewer's local zone would silently shift every call time. |
| `call_outcomes.*` | **all `text`**, including `response_final_rate` and `response_rounds_count` | Cast on read. The run dump names columns after the variable path and has no type mapping. |
| `call_outcomes.run_id` | `text`, while `calls.run_id` is `uuid` | Joined as `co.run_id = c.run_id::text`. |

Two schema realities the UI is built around:

- **The run dump skips failed runs.** A carrier who hangs up mid-negotiation produces **no `call_outcomes` row at all**. The `calls` row is the presence record, and the call-detail screen still renders a full audit trail from it — the empty state says exactly this rather than showing a blank screen.
- **`carriers` is a current-state snapshot keyed by MC**, overwritten on the carrier's next call. It cannot prove *this* call was refused. `verification_events` is the per-run audit trail, and it holds the MC **as spoken** — which may not exist at FMCSA at all. Both are shown, separately, on the carrier page.

---

## Deploying it as a HappyRobot App — the manual steps

App creation is **UI-only**: the only App API operation is `POST /apps/{slug}/duplicate`. These steps cannot be scripted.

### 0. Prerequisite — deploy the Twin API Gateway first (optional but do it now)

**Settings → Twin Database → Deploy Gateway**, wait for **Running**.

This console does not use the gateway, but deploying it *before* the App exists means `NEXT_PUBLIC_TWIN_GATEWAY` is injected into the first build. Deploying it afterwards needs a redeploy to pick the variable up.

### 1. Push this code to a GitHub repo you control

The import flow reads from a GitHub URL. `app/` must be the **repository root** of the repo you import — the platform validates that the source is a Next.js project by looking for `package.json` and `next.config.*` at the top level. Either push `app/` as its own repo, or use a subtree split:

```bash
git subtree push --prefix app origin ops-console-root
```

### 2. Create the App

1. **Apps → Create App**
2. Choose **Import from existing repo**
3. **Source repository URL:** `https://github.com/<you>/<repo>`
4. **GitHub personal access token:** one with read access to that repo (used once, to fetch the source)
5. **Name:** `Carrier Sales Ops` → the slug is generated automatically and is **immutable**
6. **Description:** `Operational signals and call audit trail for the inbound carrier-sales agent`
7. **Create**

HappyRobot creates a managed GitHub repo, provisions a Vercel project, and starts a build.

> The first build of an *imported* app often fails — that is documented platform behaviour, not a problem with this code. It builds clean locally (see below). If it fails, open the sandbox, read the build log, and confirm the framework preset is Next.js.

### 3. Set the environment variables

**Open the App → Environment variables → Add variable**, three times:

| Key | Value | Notes |
|---|---|---|
| `TWIN_API_KEY` | your org API key (`sk_live_…`) | Server-only. The platform rejects any user variable prefixed `NEXT_PUBLIC_`, which is exactly the posture we want. |
| `OPS_CONSOLE_PASSWORD` | the shared review credential | Put this in the build doc and say it out loud in the video. |
| `OPS_SESSION_SECRET` | 32+ random characters | Optional — derived from the password if omitted. Set it explicitly. |

Optional: `OPS_CONSOLE_USER` (defaults to `ops`), `HR_PLATFORM_URL` (platform-managed; only set it if your platform host differs).

Each save triggers a redeploy automatically. Values are write-only after saving — keep them in a password manager.

### 4. Verify the deployment

```bash
BASE=https://<slug>.happyrobot.ai npm run smoke:auth      # every /api/* route must 401
curl -s https://<slug>.happyrobot.ai/api/health           # {"ok":true}
```

Then open `https://<slug>.happyrobot.ai` in a **private window**: it must present *this console's* login, not a blank page and not data.

### 5. Local development against the deployed App (optional)

The App detail page's **⋯ → Develop locally** panel gives you a `git clone` of the managed repo and a **Download .env.local** button. That file contains the real secrets — it is already covered by this repo's `.gitignore`.

---

## Build

```
$ npm run build

> carrier-sales-ops-console@1.0.0 build
> next build

   ▲ Next.js 15.5.23
   - Environments: .env.local

   Creating an optimized production build ...
 ✓ Compiled successfully in 1992ms
   Linting and checking validity of types ...
   Collecting page data ...
   Generating static pages (0/3) ...
 ✓ Generating static pages (3/3)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                 Size  First Load JS
┌ ƒ /                                      984 B         107 kB
├ ○ /_not-found                            149 B         103 kB
├ ƒ /api/auth/login                        149 B         103 kB
├ ƒ /api/auth/logout                       149 B         103 kB
├ ƒ /api/calls                             149 B         103 kB
├ ƒ /api/calls/[runId]                     149 B         103 kB
├ ƒ /api/carriers                          149 B         103 kB
├ ƒ /api/export/calls                      149 B         103 kB
├ ƒ /api/export/calls/[runId]              149 B         103 kB
├ ƒ /api/health                            149 B         103 kB
├ ƒ /api/kpis                              149 B         103 kB
├ ƒ /calls                               1.94 kB         108 kB
├ ƒ /calls/[runId]                         990 B         107 kB
├ ƒ /carriers                              989 B         107 kB
├ ƒ /carriers/[mc]                         990 B         107 kB
└ ƒ /login                                 966 B         104 kB
+ First Load JS shared by all             103 kB
  ├ chunks/255-87552e6e05b8e3aa.js       46.4 kB
  ├ chunks/4bd1b696-c023c6e3521b1417.js  54.2 kB
  └ other shared chunks (total)          1.92 kB


ƒ Middleware                             34.2 kB

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

Every data route is `ƒ` (server-rendered on demand). The only static asset is the 404 page. `npm run typecheck` is clean.

**Dependency posture:** Next is pinned to `15.5.23`, the patched release for the whole 15.5.x advisory set. `npm audit` reports three remaining highs, all in `sharp` — an optional transitive dependency of `next/image`. The console renders no images and `images.unoptimized` is set in `next.config.ts`, so the Image Optimizer never runs. Clearing them means Next 16, which is a breaking change and out of scope for this build.

---

## What isn't here

- **No write actions.** Read-only console, by constraint. See "Actions" above.
- **No SSO.** Shared credential, scoped to the review window, stated everywhere it matters.
- **No live-board / capacity screen.** It would read the TMS, not Twin, and the constraint for this build is never to contact the real TMS.
- **No call audio.** Recording URLs are signed for 1–7 days; Twin holds the reference, not the audio. Long-retention archival is a customer compliance decision, not an engineering one.
- **Pagination is a row cap, not a cursor.** Twin's SELECT cap is 500 rows; the call log requests 200 and tells you when it truncated. At ~500 loads/week this is comfortable for a POC, and a cursor is a day's work when it stops being.

---

## Layout

```
app/
├── src/
│   ├── middleware.ts              # convenience redirect ONLY — not the boundary
│   ├── lib/
│   │   ├── auth.ts                # sessions, credential check, login throttle
│   │   ├── twin.ts                # server-only Twin SQL client, escaping, type casts
│   │   ├── queries.ts             # every SQL statement in the console, in one file
│   │   ├── format.ts              # money / UTC timestamps / CSV escaping
│   │   ├── errors.ts              # honest error states
│   │   └── api.ts                 # JSON envelope + Twin error mapping
│   ├── components/                # presentation primitives (no dangerouslySetInnerHTML)
│   └── app/
│       ├── login/                 # the only unauthenticated screen
│       ├── (console)/             # Overview · Call log · Call detail · Carriers
│       └── api/                   # every handler starts with requireApiSession()
└── scripts/
    ├── seed-demo.mjs              # reversible demo data
    └── smoke-auth.mjs             # "every /api/* route returns 401" check
```

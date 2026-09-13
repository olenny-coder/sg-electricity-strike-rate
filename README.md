# Strike — Singapore Business Electricity Price Advisory

An analytics-first decision tool for Singapore commercial and industrial electricity
buyers. It answers one question well: **when should this site strike on price** —
lock a fixed contract, stay on the regulated tariff, or keep floating on wholesale?

Built on **real, verifiable data only**. No placeholder prices, no mock USEP, no
invented retailer rates.

---

## Quick start

On Windows, `run.cmd` does all of this in one step and opens the browser:

```bat
run.cmd
```

Or manually:

```bash
npm install
npm --prefix web install
npm run build:web          # build the client
npm run sync -- --days 90  # ingest real market data (first run)
npm run sync:tariff        # ingest the real regulated tariff
npm run seed               # optional: load real published SME rates as an anchor
npm start                  # http://127.0.0.1:8791
```

To run it detached and keep it alive after the shell closes:

```bash
npm run serve   # background, logs to data/server.log
npm run stop
```

Environment: `PORT` (default `8791`), `HOST` (default `127.0.0.1`), `LOG_LEVEL`,
and `DATABASE_URL` to switch from SQLite to Postgres. See `.env.example`.

The app opens in your OS theme and can be switched from the header. Data is stored
in a local SQLite file at `data/strike.db` until `DATABASE_URL` is set.

---

## The two things you should know first

### 1. The build spec's primary USEP path is dead, and this app proves it

The spec named `energy-trading-api==0.0.34` as primary access:

```python
from energy_trading_api import singaporeNEMS
df = singaporeNEMS.singaporeUSEP(date="2026-09-01")
```

That package was installed and invoked exactly as documented. It is a thin
`pandas.read_html()` over `https://www.emcsg.com/marketdata/priceinformation?…&dataType=USEP`.
EMC has since retired that hostname behind **PingFederate SSO** — the URL answers
HTTP 200 with an auto-POST SAML login form, `read_html` finds no tables, and the
wrapper returns `None`. Reproduced for current, recent and historical dates.

Rather than delete the path, the app **runs it live** and shows the result in the
*Data sources* panel. See `tools/usep_mandated.py`.

### 2. The data is still public — on a different host

EMC's NEMS portal exposes the same data unauthenticated:

```
https://www.nems.emcsg.com/api/sitecore/DataSync/DataDownload
    ?value=10&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&tpcValue=1
```

| `value` | Contents |
|---|---|
| `10` | Date, Period, Demand (MW), Solar (MW), TCL, **USEP ($/MWh)**, EHEUR, **LCP**, RUSEP, MAP, **MAPT**, TPC Applied, Last Updated |
| `11` | Primary / Contingency / Regulation reserve prices |

Roughly three years of history, 48 half-hourly rows per day, no auth and no
cookies. This deployment holds **58,896 half-hour periods** spanning 2023-05-05 to
the present.

---

## What is real, and what is modelled

This distinction is enforced in code and surfaced in the UI, because a "real data"
claim is worthless if you cannot audit it.

### Real, ingested from live sources

| Data | Source | Access |
|---|---|---|
| USEP, half-hourly | EMC NEMS `value=10` | open |
| Demand and solar, half-hourly | EMC NEMS `value=10` | open |
| Ancillary reserve prices | EMC NEMS `value=11` | open |
| Load Curtailment Price (LCP) | EMC NEMS `value=10` | open |
| Temporary Price Cap (MAPT) | EMC NEMS `value=10` | open |
| Regulated tariff + 4 cost components | EMA quarterly CSV | open |
| Fixed-price SME rates | Retailer websites | published |

### Modelled, with the assumption made explicit

- **Your load shape.** `L(t) = k · D(t)^α`, anchored to the **real** national
  demand profile. α is one interpretable control (0 = flat, 1 = follows the grid,
  higher = peakier). The *timing* of peaks is real data; only your amplitude
  response is assumed. Derived load factor and peak-window share are shown back so
  you can sanity-check α against your own bills.
- **DR event parameters** (duration, delivery rate, production loss). These are
  properties of your site, not of the market, so they are inputs.
- **Fixed-price quotes for large sites.** Most retailers do not publish them. Six
  real published SME rates ship as an anchor; replace them with your own quotes.

### Deliberately absent

Nothing is invented to fill a gap. Where data is unavailable the affected
analytics stay empty and say why.

---

## Features

**Light and dark themes** — A dedicated token set per theme (background, surface,
border, text, brand, accent, status and eight chart series). Charts recolour via
CSS custom properties rather than re-rendering, so switching is instant. The
choice persists in `localStorage`, defaults to the OS preference, follows it live
when set to *System*, and is applied by an inline script before first paint so
there is no flash of the wrong theme.

**Responsive, with hamburger navigation** — An inline tab bar above 900px; below
that it collapses into a hamburger drawer with scrim, focus handling, Escape to
close, background scroll lock and `aria-modal` semantics. Cards stack to a single
column, tile and chart type scale down, tables scroll horizontally, and tap
targets meet 44px on coarse pointers.

**Recommendation** — A transparent lock-in score (starts at 50, moves with the
gap between your best quote and the tariff, the all-in wholesale gap, realised
volatility, forecast direction, and price percentile). Every point is decomposed
into the real number behind it. Not a black box.

**Fair value reference price** — A benchmark for judging whether what you are
quoted is cheap or dear, built from **two independent published anchors** rather
than invented:

1. The **long-run marginal cost of a CCGT**, derived from EMC's published
   Temporary Price Cap. The cap is set at 3× LRMC, so LRMC = MAPT ÷ 3, computed
   per half hour from the real feed.
2. The **regulated tariff's energy component**, published by EMA and set from
   lagged natural gas prices.

Two different organisations, different inputs, different methods — so their
agreement is genuine corroboration. The app shows the band, the spread between
the anchors, and where wholesale and the tariff sit against it. On the current
window it reports wholesale trading **15.5% above the long-run cost of supply**,
which is an argument against locking a long contract at today's level. The
derivation of each anchor is printed alongside, so the number is auditable rather
than trusted. It is explicitly *not* a price you can transact at.

**PDF report** — A "PDF report" button in the header produces a purpose-built
document through the browser's own Save-as-PDF, so text stays selectable and
searchable and no PDF library is added to the bundle. It is a separate document
rather than the app printed: a cover with the verdict and site parameters, then
eight numbered sections (why this recommendation, fair value, cost comparison,
market context, load shifting, demand response, modelled load profile, data
provenance) and a basis-of-preparation footer. Print styling forces a light,
ink-friendly palette regardless of the on-screen theme, repeats table headers
across page breaks, and stops sections splitting mid-row.

**Market prices** — Daily and intraday real USEP, peak/off-peak analysis, the
quarterly tariff series with its component breakdown, and ancillary reserve
prices.

**Compare options** — The same real consumption priced under the regulated
tariff, all-in wholesale (real USEP **plus** the real published network/MSS/PSO
adders), and each quoted fixed rate.

**Load shifting** — A greedy optimiser that pairs the most expensive half hours
against the cheapest, constrained by how much load you can actually move. It only
ever moves energy from a genuinely dearer period to a cheaper one, so savings
cannot be negative. Includes a backtested forecast with honestly reported error.

**Demand response** — Modelled on the programme's *actual* economics, which is not
a capacity payment. See below.

**Data sources** — Full provenance: publisher, endpoint, fetch time, per-row
provenance, and the live failure of the mandated package.

---

## Two findings that changed the analytics

**The regulated tariff is set from lagged natural gas prices**, not forward HSFO
as the spec assumed — "the average daily natural gas prices in the first 2.5 months
of the preceding quarter". This lag is why a fast gas spike is a genuine reason to
lock in before the next revision.

**Demand Response is not a capacity payment.** EMA pays an *energy* incentive only
when curtailment is called: the Load Curtailment Price × quantity curtailed,
described as one third of the savings created, capped at **S$4,500/MWh**.
Delivering 80–100% of a scheduled reduction earns **nothing** — there is no
pro-rata settlement.

The model derives its trigger from the **real published cap** (MAPT is 3× the CCGT
long-run marginal cost, and EMA triggers at 1.5× LRMC, so the trigger is MAPT/2),
counts how often real USEP actually crossed it, and prices events at the **real
observed LCP**. Two independent validations fell out of this:

- observed mean LCP of **S$2,671.92/MWh**, against EMA's reported realised range
  of roughly S$2,400–2,700/MWh;
- observed maximum LCP of **exactly S$4,500**, the published cap binding in real data.

---

## Verified reference figures

| Item | Value | Cross-check |
|---|---|---|
| Q3 2026 regulated tariff | 31.91 c/kWh ex-GST, 34.78 with 9% GST | EMA prose **and** component CSV sum exactly |
| Tariff components | 25.50 energy + 6.10 network + 0.23 MSS + 0.08 admin/PSO | sums to 31.91 ✓ |
| Non-energy adder for wholesale | 6.41 c/kWh | derived from the above |
| Wholesale all-in (90d window) | 34.34 c/kWh | vs 31.91 tariff — **wholesale was dearer** |
| Vesting Base Vesting Price Q3 2026 | 252.68 S$/MWh (25.268 c/kWh) | reconciles with 25.50 energy ✓ |

That last row is the commercially important one: on the recent window, floating on
wholesale would have **cost more** than the regulated tariff. The tool says so
rather than assuming wholesale is always cheaper.

---

## Architecture

```
src/
  db.ts                    SQLite schema, provenance, additive migrations
  server.ts                Fastify API + static client + cron endpoint
  cli.ts                   sync | tariff | probe | status
  seed.ts                  real published SME rates
  store/
    index.ts               driver selection + async facade
    types.ts               the Store contract
    postgres.ts            Postgres implementation (Neon)
  sources/
    usep.ts                EMC NEMS ingestion + mandated-package probe
    emaTariff.ts           EMA tariff CSV, reconciliation, bot-challenge detection
    facts.ts               sourced market context
  analytics/
    time.ts                SGT bucketing
    loadshape.ts           load model + three-way cost comparison
    priceActions.ts        shift optimiser + backtested forecast
    dr.ts                  DR revenue from real LCP
    signal.ts              the recommendation engine
tools/
  usep_mandated.py         exercises the spec-mandated path
  audit-real-data.mjs      live reconciliation against EMC and EMA
  serve-detached.mjs       background launcher
test/
  postgres.mjs             Postgres store, run against PGlite
  shape.mjs                API contract the client depends on
web/                       Vite + React + TypeScript client
  src/theme.ts             light/dark/system resolution
  src/styles.css           design tokens, both themes, responsive rules
```

**Storage is driver-agnostic.** `src/store/index.ts` picks SQLite or Postgres from
`DATABASE_URL` and exposes one async interface, so no caller knows which is live.
Production uses Postgres because no free host gives you a durable disk.

**No Python is required to run the app.** The venv is used only to demonstrate that
the mandated package fails; if absent, the probe reports that instead.

Node 22.6+ is required (`node:sqlite`, native TypeScript stripping). No build step
for the server.

---

## Testing and verification

```bash
npm test              # Postgres storage layer, against real Postgres (PGlite)
npm run test:api      # API contract, needs a running server
node tools/audit-real-data.mjs   # live reconciliation against EMC and EMA
```

**`npm test` runs the production Postgres store against PGlite** — Postgres
compiled to WebAssembly. That is genuine PostgreSQL parsing and execution, not a
mock, so identity columns, the `COALESCE` expression index, `ON CONFLICT DO
UPDATE` upserts, multi-row inserts and window bounds are all actually exercised.
This matters because local development uses SQLite: without it, a typo in the
Postgres layer would only surface on the first production deploy. Network
concerns (pooling, TLS, PgBouncer) are explicitly out of scope.

**`tools/audit-real-data.mjs` tests the "real data" claim itself.** It re-fetches
the upstream sources independently and reconciles them against what is stored:
period-by-period USEP and LCP against EMC, the tariff against both EMA's
component CSV and its prose headline, provenance on every row, and a
fabricated-value scan of the source tree.

It has already earned its place — it caught two things that assumption would have
missed:

- **EMC revises same-day figures.** The newest stored day disagreed with EMC's
  later published values across 12 of 48 periods, by up to ~420 S$/MWh, while
  every settled day back through 2025 matched exactly. The audit now asserts
  exactness on a *settled* day only, and ingestion re-fetches an overlapping
  window so revisions are absorbed.
- **ema.gov.sg is behind Imperva bot management.** Repeated automated requests get
  a ~1 KB JavaScript challenge **with HTTP 200**, which a naive scraper would
  treat as success and parse into nothing. The adapter now detects the challenge
  explicitly. The tariff CSVs are on a static `/content/dam/` path and are *not*
  challenged, so the figures stay verifiable. The adapter also skips quarters it
  already holds — a published quarter is final — which cut a routine run from
  twelve requests to one.

---

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full plan, with vendor limits
verified from official documentation.

The short version: **Render free web service + Neon free Postgres + GitHub Actions
for daily ingestion.**

- **Neon is mandatory.** Render's free filesystem is ephemeral and Vercel
  functions have no disk at all, so SQLite cannot be used in production. The app
  picks its driver from `DATABASE_URL` and reports which one is live at
  `/api/health`.
- **Vercel Hobby is non-commercial only**, so it is not the recommended host for
  a business tool. It is offered as an optional static frontend in a split
  deployment.
- **Ingestion runs in GitHub Actions**, not on the host: Render's free tier has no
  cron jobs, and its free web service is asleep most of the time. A workflow
  writes straight to Neon with no cold-start dependency.

Configs included: `render.yaml`, `vercel.json`, `.github/workflows/ingest.yml`,
`.github/workflows/ci.yml`, `.env.example`.

---

## Honest limitations

- **DR revenue is an upper bound.** It assumes you are called every time the market
  settled a curtailment. You are one participant among many. Do not budget from it.
- **Forecast error is large and reported.** USEP is genuinely hard to forecast —
  the backtest typically lands around 60% MAPE against a ~99% naive baseline.
  Direction is more reliable than level.
- **The load model is a model.** A real half-hourly meter import would supersede it.
- **EMC's `Demand (MW)` is a forecast**, excluding transmission losses, intertie
  flows and exempted embedded generation. It is used here only as a *shape*
  reference and is never quoted as system peak.
- **The newest day of market data is provisional** and will be revised by EMC.
  Treat today's price as indicative, not final.
- **The $4,500/MWh DR cap dates from Oct 2024.** It is corroborated by real
  settlement data in this dataset, but confirm current terms with EMA.
- **EMC's endpoint is technically open but undocumented.** No published SLA, rate
  limit or reuse licence was found. Sustained production polling may require EMC's
  paid data subscription. Ingestion is deliberately chunked and throttled.
- **EMA rate-limits automated clients.** Ingestion is written to be a polite
  client, but sustained polling from one IP may still be challenged.
- **Not financial advice.** Verify every quote against the retailer's fact sheet.

---

## Licence

Split by subject matter, because code and data want different terms:

| | Licence | Covers |
|---|---|---|
| **Software** | [MIT](LICENSE) | Source code, scripts, configuration, build files |
| **Data** | [CC BY 4.0](LICENSE-DATA) | Compiled datasets, derived data, and the factual content of the documentation |

MIT so the code can be reused with the fewest possible obligations. CC BY 4.0 for
the data because the value is in the compilation — the ingested history, the
normalisation, the cross-checks against the publishers, and the derivations such
as the fair value reference and the lock-in score.

Where one file mixes both — `src/sources/facts.ts` is code that also carries
compiled market facts, `src/seed.ts` is code that also carries compiled published
rates — the **code is MIT and the compiled content it carries is CC BY 4.0**. The
line is drawn by subject matter, not by file.

### The upstream data is not ours to license

Worth stating plainly, because it is easy to assume otherwise. The prices are
facts about the Singapore market whose publishers retain their own terms:

- **USEP, ancillary prices, Load Curtailment Price and Temporary Price Cap
  parameters** — Energy Market Company (EMC)
- **The regulated tariff and its components** — Energy Market Authority (EMA) and
  SP Group
- **Published retail rates** — the individual retailers

CC BY 4.0 here covers the **compilation and the derivation** — the selection,
normalisation, reconciliation and computed metrics. It cannot grant any right in
the source data, because that data was never this project's to license. If you
plan to redistribute a compiled dataset rather than use it internally, satisfy
yourself that your use is permitted upstream. Two specifics from the research in
`docs/`:

- No reuse licence, SLA or rate limit was found published for the EMC endpoint; its
  own documentation directs users needing more certainty to EMC's paid data
  subscription.
- `ema.gov.sg` sits behind Imperva bot management, so automated access is
  tolerated conditionally rather than granted.

Neither publisher was asked for permission during development, and no claim of
permission is made. Full scope and attribution wording are in
[`LICENSE-DATA`](LICENSE-DATA).


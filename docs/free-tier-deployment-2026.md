# Free-tier deployment research — Fastify 5 + TypeScript + relational DB (verified 2026-09-13)

**Method / scope.** Every claim below was retrieved from vendor-official documentation on 2026-09-13 via direct fetch (Vercel docs `.md` endpoints, Render docs `.md` endpoints, Neon docs `.md` endpoints, GitHub Docs article-body API, postgresql.org, sqlite.org, node-postgres.com, nodejs.org, npm registry). Quoted text is verbatim from those pages. Where a number is my own arithmetic on documented values it is labelled **[derived]**. Anything I could not confirm from an official page is in the final **UNVERIFIED** list.

Target app: Fastify 5 HTTP server (Node 22/24, TypeScript via Node's native type stripping, no build step), serving a Vite+React static frontend from the same process, with (a) read-only analytics endpoints aggregating ~60,000 rows and (b) a daily ingestion job doing ~15 sequential outbound HTTP requests (30–60 s).

---

## 1. Vercel free (Hobby) tier

### 1.1 Function duration
- With fluid compute (enabled by default for new projects): `| Hobby | 300s (5 minutes) | 300s (5 minutes) | - |` — Default / Maximum / Extended maximum. i.e. **Hobby default = 300 s and Hobby maximum = 300 s; no extended maximum on Hobby.** Pro/Enterprise: 300 s default, 800 s max, 1800 s (30 min) beta. <https://vercel.com/docs/functions/limitations> and <https://vercel.com/docs/functions/configuring-functions/duration>
- Legacy (project deployed before 23 April 2025 and **not** using fluid compute): `| Hobby | 10s | 60s (1 minute) |` (Default / Maximum). <https://vercel.com/docs/limits>
- If a function exceeds its duration: "a 504 error code (`FUNCTION_INVOCATION_TIMEOUT`) is returned." <https://vercel.com/docs/functions/limitations>
- Memory: Hobby `2 GB / 1 vCPU` default and maximum. Request/response body max `4.5 MB` (`FUNCTION_PAYLOAD_TOO_LARGE` above that). File descriptors: "1,024 shared across all concurrent executions (including runtime usage)". <https://vercel.com/docs/functions/limitations>

### 1.2 Invocation count, CPU/memory, bandwidth
Hobby included usage (all from <https://vercel.com/docs/plans/hobby> and <https://vercel.com/docs/limits>):
- Function Invocations: **First 1,000,000** / month ("Hobby includes 1 million invocations per month", <https://vercel.com/docs/functions/usage-and-pricing>).
- Active CPU: **4 CPU-hrs**; Provisioned Memory: **360 GB-hrs**.
- Fast Data Transfer: **100 GB**; Fast Origin Transfer: **Up to 10 GB** (<https://vercel.com/docs/limits>, fair-use page agrees: "Fast Data Transfer — Up to 100 GB", "Fast Origin Transfer — Up to 10 GB").
- Edge Requests: **Up to 1,000,000 requests** (<https://vercel.com/docs/plans/hobby>).
- Over-limit behaviour: "if you exceed your usage limits on the Hobby plan, you will have to wait until 30 days have passed before you can use the feature again." <https://vercel.com/docs/plans/hobby>
- Billing detail relevant to your 30–60 s ingestion job: "You are only billed during actual code execution and not during I/O operations (database queries…)"; provisioned memory "Continues billing while handling requests, even during I/O operations". <https://vercel.com/docs/functions/usage-and-pricing>

### 1.3 Build minutes
- **No monthly build-minutes quota is documented for Hobby.** What is documented instead:
  - "Build Time per Deployment (Minutes) — Hobby 45"; "Deployments Created per Day — Hobby 100"; "Concurrent Deployments — Hobby 1". <https://vercel.com/docs/limits>
  - "Hobby teams always use the Basic build machine. Basic has 2 vCPUs and 8 GB of memory." / "Basic is included with Hobby." <https://vercel.com/docs/builds/managing-builds>, <https://vercel.com/docs/pricing>
  - Pro rates for reference: "Basic is priced at $0.007 per build minute" <https://vercel.com/docs/pricing>.
- I searched `/docs/limits`, `/docs/pricing`, `/docs/plans/hobby` and `/docs/builds/managing-builds` and found no Hobby monthly build-minute allowance. See UNVERIFIED #4.

### 1.4 Commercial use on Hobby — **not permitted**
> "**Hobby teams** are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan."
> "Commercial usage is defined as any Deployment that is used for the purpose of financial gain of **anyone** involved in **any part of the production** of the project, including a paid employee or consultant writing the code."
> "Asking for Donations **does not** fall under commercial usage."
<https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage> (also referenced from <https://vercel.com/docs/plans/hobby>: "As stated in the fair use guidelines, the Hobby plan restricts users to non-commercial, personal use only.")

### 1.5 Recommended way to deploy Fastify on Vercel — official zero-config support, **no adapter needed**
- There is an official page, "Fastify on Vercel": "You can deploy a Fastify app to Vercel with zero configuration using Vercel Functions." <https://vercel.com/docs/frameworks/backend/fastify>
- Entrypoint detection (this is the whole config): your server file must be named one of `app|index|server` + `.js,.mjs,.cjs,.ts,.cts,.mts` at project root or under `src/`. Verbatim list: `src/app.{js,mjs,cjs,ts,cts,mts}`, `src/index.{…}`, `src/server.{…}`, `app.{…}`, `index.{…}`, `server.{…}`. You create the Fastify instance, register routes, and call `fastify.listen()` — Vercel uses that call to detect the HTTP server. <https://vercel.com/docs/frameworks/backend/fastify>, <https://vercel.com/docs/functions/runtimes/node-js>
- "When you deploy a Fastify app to Vercel, your Fastify application becomes a single Vercel Function and uses Fluid compute by default." <https://vercel.com/docs/frameworks/backend/fastify>
- No `serverless-http`-style wrapper is mentioned; Fastify's own docs list Vercel among platforms "where the server can handle multiple requests at the same time", but the concrete Vercel integration is the zero-config entrypoint above. <https://fastify.dev/docs/latest/Guides/Serverless/>
- Minimum CLI for detection: "Minimum CLI version required: 48.6.0" <https://vercel.com/docs/frameworks/backend/fastify>
- Limits: "All Vercel Functions limitations apply to the Fastify application, including the standard bundle size limit of 250MB for Node.js applications." Large Functions (beta) allow up to 5 GB. <https://vercel.com/docs/frameworks/backend/fastify>
- Node versions available: "**24.x** (default)", "**22.x**", "**20.x**" — "Only major versions are available." Node 20 is being deprecated on 1 October 2026. <https://vercel.com/docs/functions/runtimes/node-js/node-js-versions>
- Vite frontend: Vercel deploys Vite projects zero-config ("Vite … a build command that bundles your code and outputs optimized static assets for production"); for SPA deep links you must add a `vercel.json` rewrite of `/(.*)` → `/index.html`. <https://vercel.com/docs/frameworks/frontend/vite>

### 1.6 Cron Jobs on Hobby
| | Number of cron jobs per project | Minimum interval | Scheduling precision |
|---|---|---|---|
| **Hobby** | 100 cron jobs | Once per day | Per-hour (±59 min) |
| Pro / Enterprise | 100 cron jobs | Once per minute | Per-minute |
<https://vercel.com/docs/cron-jobs/usage-and-pricing>

Verbatim additional rules:
- "**Daily execution limit**: Cron jobs can only run once per day. Expressions like `0 * * * *` (per-hour) or `*/30 * * * *` (every 30 minutes) will fail deployment with the error: *Hobby accounts are limited to daily cron jobs. This cron expression would run more than once per day.*"
- "**Timing precision**: Vercel cannot assure a timely cron job invocation. For example, a cron job configured as `0 1 * * *` (every day at 1 am) will trigger anywhere between 1:00 am and 1:59 am."
- "Cron jobs are included in **all plans**." / "Cron jobs invoke Vercel Functions. This means the same usage and pricing limits will apply."
<https://vercel.com/docs/cron-jobs/usage-and-pricing>
- "Vercel runs cron jobs only on production deployments." Cron auth is via `CRON_SECRET` sent as a Bearer token. <https://vercel.com/kb/guide/ship-a-fastify-app-on-vercel>

### 1.7 Can a Hobby project run a 60-second cron job?
**Yes.** Cron invokes a Vercel Function, and Hobby's default *and* maximum function duration with fluid compute is 300 s (§1.1), so a 60 s job is inside the limit. Caveat: a legacy project (created before 23 Apr 2025, no fluid compute) has a Hobby maximum of **60 s**, which would sit exactly at the boundary. Sources: <https://vercel.com/docs/cron-jobs/usage-and-pricing>, <https://vercel.com/docs/functions/limitations>, <https://vercel.com/docs/limits>

---

## 2. Render free tier

### 2.1 What "free" covers
- "You can deploy certain Render service types *free of charge*: Web services…, Render Postgres databases, Render Key Value instances. … You can also deploy static sites on Render for free." Step 3 of the setup flow: "Select *Static Site*, *Web Service*, *Postgres*, or *Key Value*. — Other service types don't support Free instances." (**Cron jobs and background workers are therefore not free.**) <https://render.com/docs/free>
- Free web service compute plan: `0.1 CPU / 512 MB` (`free`). <https://render.com/docs/compute-plans>, <https://render.com/docs/free>
- Hobby workspace limits: single team member, 25 total services, two environments per project. <https://render.com/docs/platform-features-by-plan>
- Warning in the docs: "Free instances have important limitations, described below. *Do not use them for production applications.*" <https://render.com/docs/free>

### 2.2 Spin-down and cold start
> "Render *spins down* a Free web service that goes 15 minutes without receiving any inbound traffic. This includes both HTTP requests and WebSocket messages from existing connections."
> "A Free web service spins back *up* whenever it next receives an HTTP request or new WebSocket connection. **This process takes about one minute.** Render displays a loading page to connecting browsers while a service is spinning up."
<https://render.com/docs/free>
- Also: "Render might restart a Free web service at any time." and "Render may suspend a Free web service that initiates an uncommonly high volume of traffic over the public internet." <https://render.com/docs/free>
- While spun down, `/robots.txt` returns a canned `User-agent: * / Disallow: /` without triggering a spin-up. <https://render.com/docs/free>
- **[derived]** Because the service is spun down (process not running) between requests, an in-process `setInterval`/cron-in-process daily job on a free web service cannot be relied upon; the daily job would have to come from an external scheduler hitting an HTTP endpoint (which costs ~1 minute of cold start).

### 2.3 Monthly instance hours
> "Render grants *750 Free instance hours* to each workspace per calendar month:
> - A Free web service consumes these hours as long as it's running (spun-down services don't consume Free instance hours).
> - If you consume all of your Free instance hours during a given month, Render *suspends* all of your Free web services until the start of the next month.
> - At the start of each month, your Free instance hours reset to 750 (remaining hours don't roll over)."
<https://render.com/docs/free>
- **[derived]** 750 hours ≥ the 744 hours in a 31-day month, so one always-on free web service fits; the allowance is per **workspace**, shared across free services, so two free services cannot both run continuously.

### 2.4 Filesystem — ephemeral (SQLite would be lost)
> "Like all Render services, Free web services have an ephemeral filesystem. This means that any changes to your web service's filesystem (uploaded images, **local SQLite databases**, etc.) are *lost* every time the service redeploys, restarts, or spins down."
> "*Paid* services can preserve local filesystem changes by attaching a persistent disk, but Free web services *cannot*."
<https://render.com/docs/free>
- Free web services also lack: scaling beyond a single instance, persistent disks, edge caching, one-off jobs, shell/SSH access; cannot receive private network traffic (they can send it); cannot listen on ports `18012`, `18013`, `19099`; cannot send outbound traffic on ports `25`, `465`, `587`. <https://render.com/docs/free>

### 2.5 Bandwidth and build pipeline allowances (workspace-level, Hobby)
- Outbound bandwidth included: **Hobby 5 GB** / month (Pro 25 GB, Scale 1 TB); overage "$0.15 per GB … for traffic sent over the public internet"; "Unused bandwidth does not roll over". Without a payment method: "Render spins down your workspace's services until the start of the next month." <https://render.com/docs/outbound-bandwidth>
- Pipeline (build) minutes included: **Hobby 500** Starter-tier minutes/month; Starter tier is "2 CPU 8 GB RAM". Running out without a payment method or past your spend limit: "Render stops running pipeline tasks (including service builds!) for the remainder of the current month… your services remain active using their existing build artifacts." <https://render.com/docs/build-pipeline>, <https://render.com/docs/free>
- Build limits: build cancelled if disk > 16 GB, build command times out after 120 minutes, pre-deploy command times out after 30 minutes; one active build per service. <https://render.com/docs/build-pipeline>

### 2.6 Cron jobs (not free)
- Cron job compute plans start at `0.5c-512mb` (0.5 CPU / 512 MB) — there is **no `free` plan** in the cron-job plan table. <https://render.com/docs/compute-plans>
- "Cron jobs can use whichever compute plan best suits their CPU and memory requirements. Billing is prorated by the second, based on active running time during a given month. There is a minimum monthly charge of $1 per cron job service." <https://render.com/docs/cronjobs>
- Schedule is a standard cron expression, all day/time ranges UTC; documented examples: `*/10 * * * *` ("Every ten minutes"), `0 12 * * *`, `*/60 * * * MON-FRI`. **No minimum interval is documented.** <https://render.com/docs/cronjobs> (see UNVERIFIED #1)
- "Cron jobs can't provision or access a persistent disk."; "Render guarantees that at most one run of a given cron job is active at a given time."; a run that overlaps is delayed; "Render stops an active run after 12 hours." <https://render.com/docs/cronjobs>

### 2.7 Free Postgres — still expires after 30 days
> "*Free Render Postgres databases expire 30 days after creation.* An expired Free database is inaccessible unless you upgrade it to a paid compute plan. After a Free database expires, you have a grace period of 14 days to upgrade it to a paid compute plan. After the grace period, Render *deletes* the database (along with all of its data)."
> "Only *one* Free Render Postgres database can be active for any given workspace." / "Free Render Postgres databases have a fixed storage capacity of 1 GB." / "Free Render Postgres databases don't support any form of backups." / "Free Render Postgres databases don't support managed connection pooling."
<https://render.com/docs/free>
- Free Postgres plan: 0.1 CPU / 256 MB, under the "**Max 100 connections**" grouping in the Postgres plan table. <https://render.com/docs/compute-plans>

### 2.8 Node.js version on Render
- "Default Version `24.14.1`"; set via `NODE_VERSION` env var or a `.node-version` file. Native runtimes run "Debian 12.x, 'bookworm'" and include `node`, `npm`, `pnpm`, `yarn`, `bun`, `typescript`. <https://render.com/docs/language-support>, <https://render.com/docs/native-runtimes>
- **Relevant to your no-build-step TS server:** Node's own docs confirm type stripping is on by default and stable, with caveats: "Type stripping is now stable" (v25.2.0, v24.12.0); default since "v23.6.0, v22.18.0"; unsupported: "`Enum` declarations", "`namespace` with runtime code", "parameter properties", "import aliases", decorators; file extensions are mandatory in imports (`import './file.ts'`); `tsconfig.json` `paths` are not supported. <https://nodejs.org/api/typescript.html>

---

## 3. Neon free tier

### 3.1 Free plan allowances (verbatim from the plan table and FAQ)
- Price `$0/month`; **Projects: 100**; **Branches: 10/project**; **Compute: 100 CU-hours/project**; **Autoscaling: Up to 2 CU (8 GB RAM)**; **Scale to zero: After 5 min**; **Storage: 0.5 GB/project**; **Public network transfer: 5 GB per project included**; Monitoring: 1 day; Snapshots: 1 manual snapshot; Instant restore history: "Free: No charge, 6-hour limit, capped at 1 GB of change history" (history window default 6 hours on Free); Support: Community. <https://neon.com/docs/introduction/plans>
- Compute metering: "Each Compute Unit (CU) allocates approximately 4 GB of RAM…"; "**Free**: 100 CU-hours/project/month (enough to run a 0.25 CU compute in a project for 400 hours/month)." <https://neon.com/docs/introduction/plans>
- Free-plan summary of quotas: "The Free plan costs $0/month and includes 100 projects, 10 branches per project, 100 CU-hours of compute per project per month, autoscaling up to 2 CU (≈8 GB RAM), 0.5 GB of storage per project, and 5 GB of public network transfer per project per month. … Scale to zero is always enabled (computes suspend after 5 minutes of inactivity) and can't be disabled. Compute (CU-hours) and network transfer reset each monthly billing period; projects, branches, and storage are continuous limits." <https://neon.com/docs/introduction/plans>
- **[derived]** 100 CU-hours/month ÷ 0.25 CU = 400 hours of awake time; a 0.25 CU compute kept awake 24/7 for a 30-day month (720 h) would need 180 CU-hours > 100, so an always-awake compute is not sustainable on Free. Scale-to-zero is what makes Free viable.

### 3.2 What happens when compute hours are exhausted
> "On the Free plan, when you run out of CU-hours or public network transfer, your compute is suspended until the next billing period or until you upgrade. Exceeding the 0.5 GB storage cap causes operations that increase storage (inserts, updates, and deletes) to fail until you free space or upgrade. Branch creation fails once you reach 10 branches per project. **None of these limits delete your data.**"
<https://neon.com/docs/introduction/plans>

### 3.3 Auto-suspend and cold-start latency — yes, and it cannot be disabled on Free
- "When your database is inactive, it automatically scales to zero after 5 minutes. … Once you query the database again, it reactivates automatically within a few hundred milliseconds." / "Neon compute scales to zero after an *inactive* period of 5 minutes. For Neon Free plan users, this setting is fixed. Paid plan users can disable the scale-to-zero setting…" <https://neon.com/docs/introduction/scale-to-zero>
- "Currently, activating a Neon compute from an idle state typically takes a few hundred milliseconds not counting other factors that can add to latencies such as the physical distance between your application and database or startup times of other services…" / "By default, a compute is suspended after 300 seconds (5 minutes) of inactivity." <https://neon.com/docs/connect/connection-latency>
- "You can't disable scale to zero on Neon's Free plan, where your compute always suspends after 5 minutes of inactivity." <https://neon.com/docs/reference/compatibility>
- Session state does not survive suspension: "Everything that exists within a session context is forgotten and must be recreated"; statistics collected by the cumulative statistics system are not saved across suspension/restart; unlogged tables and temp tables live on compute-local storage and "are not persisted across compute restarts or when a compute scales to zero". <https://neon.com/docs/reference/compatibility>

### 3.4 Correct connection method from a serverless environment
- Neon uses PgBouncer in transaction mode. Configuration is fixed ("These settings are not user-configurable"): `pool_mode=transaction`, `max_client_conn=10000`, `default_pool_size=0.9 * max_connections`, `max_prepared_statements=1000`, `query_wait_timeout=120`. <https://neon.com/docs/connect/connection-pooling>
- Pooled vs direct = the connection string: pooled hostname carries the `-pooler` suffix, e.g. `postgresql://user:pass@ep-cool-rain-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`; direct omits `-pooler`. "The pooled endpoint is always available." <https://neon.com/docs/connect/connection-pooling>, <https://neon.com/docs/connect/choose-connection>
- When to use which (verbatim table rows): "Serverless functions — Pooled"; "Web applications — Pooled"; "Connection-per-request frameworks — Pooled"; "Schema migrations — Direct — Tools may not support transaction pooling"; "**Long-running analytics queries — Direct — Avoid pool contention**"; "`pg_dump`/`pg_restore` — Direct"; "Logical replication — Direct". <https://neon.com/docs/connect/connection-pooling>
- Not supported on pooled connections: `SET`/`RESET` (session variables), `LISTEN`/`NOTIFY`, `WITH HOLD CURSOR`, SQL-level `PREPARE`/`DEALLOCATE`, temporary tables with `PRESERVE`/`DELETE ROWS`, `LOAD`, session-level advisory locks. Protocol-level prepared statements (PgBouncer ≥ 1.22) **are** supported, including via `pg` named queries (`{ name, text, values }`). <https://neon.com/docs/connect/connection-pooling>
- Recommended driver per environment:
  - "Railway / Render / VPS / Docker" (long-lived server) → "`pg` or `postgres.js`", pooling "Client-side or Neon pooling".
  - "Vercel (Fluid)" → "`pg` (node-postgres)", pooling via `@vercel/functions`.
  - "Cloudflare Workers / Netlify / Deno Deploy" → `@neondatabase/serverless`.
  <https://neon.com/docs/connect/choose-connection>
- Neon serverless driver specifics (only relevant if you leave long-lived/Fluid compute): `@neondatabase/serverless` v1.0.0+ "requires Node.js version 19 or higher"; HTTP for one-shot queries, WebSocket `Pool`/`Client` for interactive transactions and node-postgres compatibility; "The maximum request size and response size for queries over HTTP is 64 MB."; in serverless environments WebSocket `Pool`/`Client` "must be connected, used and closed within a single request handler". <https://neon.com/docs/serverless/serverless-driver>

### 3.5 Free-tier connection-count limits
- `max_connections` is compute-size dependent: `max_connections = max(100, min(4000, floor(compute_size × 419.66)))`, where `compute_size = min(max_compute_size, 8 × min_compute_size)`. Worked examples from the doc: fixed 4 CU → 1,678; **autoscaling 0.25 → 2 CU → 839**; autoscaling 2 → 8 CU → 3,357. `superuser_reserved_connections = 7`. <https://neon.com/docs/reference/compatibility>
- Per-compute-size table: 0.25 CU (1 GB RAM) → `max_connections` 104, and "For a 0.25 CU compute, this means 97 connections are available for your application (104 total - 7 reserved)". <https://neon.com/docs/connect/connection-pooling>
- Pooled ceiling is separate: "Neon uses PgBouncer to provide connection pooling, enabling up to 10,000 concurrent connections" (client connections). Per-user/per-database active-transaction cap = `default_pool_size` = 90 % of `max_connections` (e.g. 1 CU → 377); exceeding it queues, and after `query_wait_timeout=120` the client gets `query_wait_timeout`. <https://neon.com/docs/connect/connection-pooling>
- Postgres versions on Neon: 14–18 (latest minors as of the doc's 2026-08-13 upstream releases: 14.24, 15.19, 16.15, 17.11, 18.6). <https://neon.com/docs/reference/compatibility>

---

## 4. Postgres migration for a Node app

### 4.1 `pg` (node-postgres) current state
- Latest published version: **`pg@8.23.0`**, `"engines":{"node":">= 16.0.0"}`, dependencies include `pg-pool ^3.14.0`, `pg-protocol ^1.16.0`, `pg-connection-string ^2.14.0`. Source: npm registry document for the `latest` dist-tag, <https://registry.npmjs.org/pg/latest> (fetched 2026-09-13). The registry `latest` document carries no explicit publish date → see UNVERIFIED #15.
- **Yes, `pg` works against Neon's pooled endpoint.** Neon's own docs use `pg` with a pooled connection string throughout: `const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });` <https://neon.com/docs/connect/connection-latency>; and the pooling page documents `pg` protocol-level prepared statements as supported through PgBouncer. <https://neon.com/docs/connect/connection-pooling>
- Neon explicitly recommends `pg` for Render-like long-lived servers and for Vercel Fluid compute. <https://neon.com/docs/connect/choose-connection>, <https://neon.com/docs/guides/vercel-connection-methods>
- Neon's Vercel recommendation (if you host on Vercel): "we recommend using a standard Postgres TCP driver (like node-postgres) and implementing a connection pool", wired with `attachDatabasePool(pool)` from `@vercel/functions`, because "the first request establishes a TCP connection, subsequent requests reuse it instantly, and idle connections close gracefully before Vercel suspends the function." <https://neon.com/docs/guides/vercel-connection-methods>, <https://vercel.com/docs/frameworks/backend>

### 4.2 Recommended connection pattern + SSL
- `pg.Pool` defaults (node-postgres API docs): `connectionTimeoutMillis` default `0` (no timeout), `idleTimeoutMillis` default `10000`, `max` default `10`, `min` default `0`, `maxUses` default `Infinity`, `maxLifetimeSeconds` default `0` (disabled). <https://node-postgres.com/apis/pool>
- Neon's documented pattern for a cold-starting compute: raise the connect timeout — `connectionTimeoutMillis: 10000`, `idleTimeoutMillis: 10000` — and add retry with exponential backoff for transient drops. <https://neon.com/docs/connect/connection-latency>
- SSL: "Neon requires that all connections use SSL/TLS encryption… Neon rejects connections that do not use SSL/TLS." Supported `sslmode` values: `require`, `verify-ca`, `verify-full`; "Neon recommends that you always use `verify-full` mode"; `channel_binding=require` enables SCRAM-SHA-256-PLUS channel binding; Neon's cert chain is Let's Encrypt ISRG Root X1. <https://neon.com/docs/connect/connect-securely>
- **Gotcha for `pg`:** "you must avoid including any of `sslcert`, `sslkey`, `sslrootcert`, or `sslmode` in the connection string. If any of these options are used then the `ssl` object is replaced and any additional options provided there will be lost." <https://node-postgres.com/features/ssl>
- `pg` also supports `enableChannelBinding: true` for SCRAM-SHA-256-PLUS and `sslnegotiation: 'direct'` (direct TLS negotiation without the `SSLRequest` round-trip; needs a PG 17+ client — Neon "implemented support for `sslnegotiation=direct` in our proxy layer, allowing you to benefit from faster connection times even if your database runs on an older PostgreSQL version"). <https://node-postgres.com/features/ssl>, <https://neon.com/docs/connect/connection-latency>
- Neon's caveat on double pooling: "If you use a pooled Neon connection, avoid adding client-side pooling on top… If you must use client-side pooling, release connections back to the pool promptly." <https://neon.com/docs/connect/choose-connection>
- **[derived]** Net recommended pattern for this app on Render (long-lived process): one module-level `new Pool({ connectionString: <pooled -pooler URL>, max: <small>, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 })`, `ssl` from the connection string, optional `sslnegotiation=direct`; use the **direct** (non-`-pooler`) URL for migrations (`pg_dump`, DDL tools) and consider direct for the heavy 60k-row analytics queries ("Long-running analytics queries — Direct — Avoid pool contention").

### 4.3 SQLite-specific constructs vs Postgres
Compatibility assessment based only on the official SQL references fetched:

| SQLite construct | Postgres outcome | Evidence |
|---|---|---|
| `INSERT … ON CONFLICT (col) DO UPDATE SET … ` | **Directly compatible** in the common form. Postgres: "`ON CONFLICT DO UPDATE` updates the existing row that conflicts with the row proposed for insertion"; "`ON CONFLICT DO UPDATE` guarantees an atomic `INSERT` or `UPDATE` outcome… This is also known as *UPSERT*"; the `excluded` pseudo-table is available; "For `ON CONFLICT DO UPDATE`, a `conflict_target` *must* be provided" (only `DO NOTHING` may omit it); **requires `UPDATE` privilege** in addition to `INSERT`. | <https://www.postgresql.org/docs/current/sql-insert.html> |
| `INSERT … ON CONFLICT … DO UPDATE` / `DO NOTHING` exists in SQLite too | SQLite has an UPSERT clause with the same shape: syntax is `ON CONFLICT ( indexed-column ) WHERE expr DO UPDATE SET column-name-list = expr [WHERE expr]` or `DO NOTHING`. | <https://sqlite.org/lang_upsert.html> (only the syntax diagram was retrievable — see UNVERIFIED #9) |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | **Must change.** SQLite-only: "In SQLite, a column with type INTEGER PRIMARY KEY is an alias for the ROWID"; "if the AUTOINCREMENT keyword appears after INTEGER PRIMARY KEY, that changes the automatic ROWID assignment algorithm to prevent the reuse of ROWIDs" and it "requires additional work to be done as each row is inserted". Postgres equivalent is an identity column: `id bigint GENERATED ALWAYS AS IDENTITY` or `GENERATED BY DEFAULT AS IDENTITY`; identity columns are "automatically marked as `NOT NULL`" but "does not guarantee uniqueness" (add `PRIMARY KEY`); with `GENERATED ALWAYS`, explicit inserts need `OVERRIDING SYSTEM VALUE`. | <https://sqlite.org/autoinc.html>, <https://www.postgresql.org/docs/current/ddl-identity-columns.html>, <https://www.postgresql.org/docs/current/sql-insert.html> |
| `PRAGMA …` | **Must change / remove.** "The PRAGMA statement is an SQL extension specific to SQLite…"; "The pragma command is specific to SQLite and is **not compatible with any other SQL database engine**." Postgres equivalents are runtime/session settings (`SET`, `ALTER DATABASE … SET`, `ALTER ROLE … SET`), and on Neon "Postgres parameters are not user-configurable outside of a session, database, or role context" — and note `SET` does not work over the pooled `-pooler` connection. | <https://sqlite.org/pragma.html>, <https://neon.com/docs/reference/compatibility>, <https://neon.com/docs/connect/connection-pooling> |
| `TEXT` | **Directly compatible.** Postgres `text` is "variable unlimited length" and "is PostgreSQL's native string data type"; "There is no performance difference among these three types". (SQLite's `TEXT` is an affinity, not a fixed type — see UNVERIFIED #10.) | <https://www.postgresql.org/docs/current/datatype-character.html> |
| `?` placeholders | **Must change** if you use node-postgres: parameterized queries use `$1, $2` — `'INSERT INTO users(name, email) VALUES($1, $2) RETURNING *'`. Also "PostgreSQL does not support parameters for identifiers" (use `pg-format` for dynamic identifiers). | <https://node-postgres.com/features/queries> |
| `LIKE` case behaviour | **Behaviour change.** SQLite's default: "The default behavior of the LIKE operator is to ignore case for ASCII characters. Hence, by default **'a' LIKE 'A'** is true." Postgres `LIKE` is case-sensitive per the active collation; `ILIKE` is the case-insensitive variant ("The key word `ILIKE` can be used instead of `LIKE` to make the match case-insensitive according to the active locale"). | <https://sqlite.org/pragma.html>, <https://www.postgresql.org/docs/current/functions-matching.html> |
| `INTEGER PRIMARY KEY` (no AUTOINCREMENT) | **Must change** as a declaration (Postgres has no ROWID alias); use identity or `int`/`bigint` + `PRIMARY KEY`. | <https://sqlite.org/autoinc.html>, <https://www.postgresql.org/docs/current/ddl-identity-columns.html> |

Directly compatible / unchanged: plain `SELECT`/`INSERT`/`UPDATE`/`DELETE` shapes, `TEXT` columns, `ON CONFLICT … DO UPDATE` (with a conflict target), `RETURNING` (both engines have it — Postgres documents it as a PostgreSQL extension in `INSERT` <https://www.postgresql.org/docs/current/sql-insert.html>).

---

## 5. Free-tier cron / ingestion patterns for a 30–60 s daily job

### 5.1 Vercel Cron (Hobby)
- Included on all plans; 100 jobs/project; **Hobby minimum interval "Once per day"**; **precision "Per-hour (±59 min)"**; more-frequent expressions fail the deployment. <https://vercel.com/docs/cron-jobs/usage-and-pricing>
- Runs only on production deployments; authenticate with `CRON_SECRET` ("Vercel sends it as a Bearer token in the Authorization header on every cron invocation"). <https://vercel.com/kb/guide/ship-a-fastify-app-on-vercel>
- Duration: 300 s Hobby max (§1.1) → a 60 s job fits. But see the Hobby commercial-use restriction (§1.4).
- Note for a Fastify app: define the cron route inside the Fastify app (`fastify.get('/api/cron/…')`) and register `{"crons":[{"path":"/api/cron/…","schedule":"0 0 * * *"}]}` in `vercel.json`. <https://vercel.com/kb/guide/ship-a-fastify-app-on-vercel>

### 5.2 Render Cron Jobs
- **Not available on the free tier**: only Static Site, Web Service, Postgres and Key Value support free instances; "There is a minimum monthly charge of $1 per cron job service"; cron plans begin at 0.5 CPU / 512 MB. <https://render.com/docs/free>, <https://render.com/docs/cronjobs>, <https://render.com/docs/compute-plans>
- If paid: standard cron expressions in UTC, single-run guarantee, runs cancelled after 12 hours, no persistent disk access, billed per second with the $1/month minimum. <https://render.com/docs/cronjobs>
- Free Render **web services** cannot host the scheduler themselves because they spin down after 15 min idle (process not running) — **[derived]** an external scheduler must hit an HTTP endpoint, and each such call pays the ~1 minute spin-up.

### 5.3 GitHub Actions scheduled workflows
- Free minutes for **private** repositories (standard GitHub-hosted runners):

  | Plan | Artifact storage | Minutes (per month) | Cache storage (per repository) |
  |---|---|---|---|
  | GitHub Free | 500 MB | **2,000** | 10 GB |
  | GitHub Pro | 1 GB | 3,000 | 10 GB |
  | GitHub Free for organizations | 500 MB | 2,000 | 10 GB |
  | GitHub Team | 2 GB | 3,000 | 10 GB |
  | GitHub Enterprise Cloud | 50 GB | 50,000 | 10 GB |

  "GitHub Actions usage is **free** for **self-hosted runners** and for **public repositories** that use standard GitHub-hosted runners." Minutes reset each billing cycle. Without a payment method, usage is blocked once the quota is exhausted. Baseline rate for reference: Linux 2-core (x64) `$0.006`/minute. <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- Schedule limits: "The shortest interval you can run scheduled workflows is once every 5 minutes." / "Scheduled workflows will only run on the default branch." / "This event will only trigger a workflow run if the workflow file exists on the default branch." / "The `schedule` event can be delayed during periods of high loads… High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped. To decrease the chance of delay, schedule your workflow to run at a different time of the hour." Default timezone is UTC (a `timezone:` key is supported). <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>, <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>
- Inactivity disabling — **exact current wording**: "To prevent unnecessary workflow runs, scheduled workflows may be disabled automatically. When a public repository is forked, scheduled workflows are disabled by default. **In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days.**" The same sentence appears on the disable/enable page. The current docs scope the 60-day rule to **public** repositories; no 60-day rule for private repositories is stated. <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>, <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows> (see UNVERIFIED #6)
- **[derived]** cost of this pattern: a 60 s daily job = 30 min/month (plus runner setup) against 2,000 free private-repo minutes — negligible. A re-enabling mechanism (e.g. a `workflow_dispatch` or a commit) is needed if the public-repo 60-day rule ever applies.

### 5.4 Comparison for this app's daily 30–60 s ingestion job

| Option | Free? | Schedule granularity | Job runtime ceiling | Key constraint |
|---|---|---|---|---|
| Vercel Cron (Hobby) | Yes | Once/day, ±59 min precision | 300 s (Hobby max) | Hobby = non-commercial personal use only |
| Render Cron Job | **No** ($1/month minimum) | Standard cron (min interval not documented) | 12 h, single-run guarantee | Requires a paid compute plan |
| GitHub Actions `schedule` | Yes (2,000 min/month private; free for public repos) | 5 min minimum, default branch only, load delays | Job-level runner limits | 60-day inactivity disable documented for public repos only |
| Render free web service + external cron hitting an endpoint | Yes | depends on external scheduler | n/a | 15-min spin-down ⇒ ~1 min cold start per wake |

---

## Fit analysis for the described app — **[derived], not a vendor statement**

- **Fastify 5 + TS, no build step.** Vercel: zero-config, but Vercel treats the app as one Function and its build/bundling pipeline is part of the deploy; Render: native Node runtime runs your `node server.ts`-style start command unchanged (type stripping is default-on in Node 22.18+/23.6+/24, `--no-strip-types` to disable). <https://vercel.com/docs/frameworks/backend/fastify>, <https://render.com/docs/language-support>, <https://nodejs.org/api/typescript.html>
- **Static Vite frontend served by the same process.** On Render this is unchanged (one process, ephemeral disk is fine for static assets as long as they are in the deploy, not written at runtime). On Vercel, the documented model is "your Fastify application becomes a single Vercel Function" while Vite is treated as a static/SPA deployment with CDN-hosted assets; whether both can coexist in one project without extra routing configuration is **not** documented in the pages fetched (UNVERIFIED #11).
- **Daily 30–60 s ingestion.** Vercel Hobby Cron fits the duration (300 s) but the plan is non-commercial-only. Render Cron Jobs are paid. GitHub Actions `schedule` is the free, host-independent runner (30 min/month of the 2,000 free private minutes).
- **60k-row analytics.** Neon Free's 0.25 CU default compute with 100 CU-hours/month, 5-minute scale-to-zero and ~"few hundred milliseconds" resume is the binding constraint, plus Neon's own advice to use a **direct** connection for long-running analytics queries to avoid pool contention. Actual query latency on 0.25 CU is not verifiable from docs (UNVERIFIED #8).
- **SQLite → Postgres.** The schema work is mechanical: keep `INSERT … ON CONFLICT … DO UPDATE` (add the conflict target), rewrite `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint GENERATED ALWAYS/BY DEFAULT AS IDENTITY`, drop `PRAGMA` statements, keep `TEXT`, change `?` → `$1` if you adopt `pg`, and revisit case-insensitive `LIKE`.

---

## UNVERIFIED (could not confirm from official documentation on 2026-09-13)

1. **Render cron minimum schedule granularity** — `/docs/cronjobs` documents standard cron expressions and examples down to every ten minutes (`*/10 * * * *`) but states no minimum interval.
2. **Render cold-start decomposition** — only "This process takes about one minute" is documented; no separate figure for container boot vs. app start, and no figure for a service that has been suspended for a long period.
3. **Render free web service inbound request timeout** — not documented on any page I fetched (`/docs/free`, `/docs/web-services` not fetched; `/docs/free` lists no request timeout).
4. **Vercel Hobby monthly build-minutes allowance** — no such allowance appears in `/docs/limits`, `/docs/pricing`, `/docs/plans/hobby`, or `/docs/builds/managing-builds`; absence of a documented quota is not proof that none is enforced.
5. **Vercel Cron timezone semantics on Hobby** — the Hobby row specifies "Once per day" and per-hour precision only; I did not verify how the once-per-day rule interacts with a specified timezone.
6. **GitHub Actions scheduled-workflow disabling in private repositories** — the current docs state the 60-day inactivity rule only for public repositories; whether private-repo scheduled workflows are also disabled after inactivity is not stated in the current docs (older docs versions stated it generally).
7. **Neon Free plan's default compute size range for a new project** — docs give the formula, the 0.25 CU table row, the "autoscaling up to 2 CU" ceiling and the "0.25 CU for 400 hours" example, but I did not find an explicit "default min compute size on Free is 0.25 CU" sentence; the derived 839 `max_connections` figure depends on that assumption.
8. **Real query performance of ~60k-row aggregates** on a 0.25 CU Neon compute, and inside a 300 s Vercel Hobby function — no vendor documentation covers this workload.
9. **SQLite UPSERT prose** — sqlite.org/lang_upsert.html truncated to its syntax diagram on repeated fetches, so only the syntax (not the explanatory text, version history, or stated limitations) was verified.
10. **SQLite `TEXT` type-affinity semantics** — sqlite.org/datatype3.html was not fetched in this session; the "directly compatible with Postgres `text`" conclusion rests on the SQLite syntax usage plus Postgres's own type documentation, not on a fetched SQLite type-affinity statement.
11. **Coexistence of a Vite static build and a Fastify Function in one Vercel project** — the Fastify page documents the function side and the Vite page documents the static/SPA side; no page I fetched specifies the combined routing/build model or required configuration.
12. **Whether Vercel or Render notify/enforce before suspending on the free tiers** — Vercel documents only the 30-day wait after exceeding limits; Render documents email notifications, but exact thresholds were not verified.
13. **`pg@8.23.0` publish date and its tested compatibility with Neon's PgBouncer version** — version number verified from the npm registry; no release date in that document, and Neon documents protocol-level prepared statements generally (PgBouncer ≥ 1.22) rather than per-driver certification.
14. **Render free Postgres "Max 100 connections" applicability** — the 100-connection heading groups the free plan with the smaller paid plans in the plan table; the free row itself does not repeat the number.
15. **Vercel Hobby static-file/CDN behaviour for a Vite build inside a Fastify project** (e.g. whether `output`/`dist` must be configured) — not verified.

---

### Source index (all fetched 2026-09-13)

Vercel: <https://vercel.com/docs/limits> · <https://vercel.com/docs/plans/hobby> · <https://vercel.com/docs/limits/fair-use-guidelines> · <https://vercel.com/docs/functions/usage-and-pricing> · <https://vercel.com/docs/functions/configuring-functions/duration> · <https://vercel.com/docs/functions/limitations> · <https://vercel.com/docs/functions/runtimes/node-js> · <https://vercel.com/docs/functions/runtimes/node-js/node-js-versions> · <https://vercel.com/docs/cron-jobs/usage-and-pricing> · <https://vercel.com/docs/frameworks/backend/fastify> · <https://vercel.com/docs/frameworks/backend> · <https://vercel.com/docs/frameworks/frontend/vite> · <https://vercel.com/docs/builds/managing-builds> · <https://vercel.com/docs/pricing> · <https://vercel.com/kb/guide/ship-a-fastify-app-on-vercel>

Render: <https://render.com/docs/free> · <https://render.com/docs/cronjobs> · <https://render.com/docs/compute-plans> · <https://render.com/docs/outbound-bandwidth> · <https://render.com/docs/build-pipeline> · <https://render.com/docs/language-support> · <https://render.com/docs/native-runtimes> · <https://render.com/docs/platform-features-by-plan>

Neon: <https://neon.com/docs/introduction/plans> · <https://neon.com/docs/introduction/scale-to-zero> · <https://neon.com/docs/introduction/autoscaling> · <https://neon.com/docs/reference/compatibility> · <https://neon.com/docs/connect/connection-pooling> · <https://neon.com/docs/connect/choose-connection> · <https://neon.com/docs/connect/connection-latency> · <https://neon.com/docs/connect/connect-securely> · <https://neon.com/docs/serverless/serverless-driver> · <https://neon.com/docs/guides/vercel-connection-methods>

Postgres / SQLite / node-postgres / Node.js / npm: <https://www.postgresql.org/docs/current/sql-insert.html> · <https://www.postgresql.org/docs/current/ddl-identity-columns.html> · <https://www.postgresql.org/docs/current/datatype-character.html> · <https://www.postgresql.org/docs/current/functions-matching.html> · <https://sqlite.org/autoinc.html> · <https://sqlite.org/lang_upsert.html> · <https://sqlite.org/pragma.html> · <https://node-postgres.com/apis/pool> · <https://node-postgres.com/features/queries> · <https://node-postgres.com/features/ssl> · <https://nodejs.org/api/typescript.html> · <https://registry.npmjs.org/pg/latest> · <https://fastify.dev/docs/latest/Guides/Serverless/>

GitHub: <https://docs.github.com/en/billing/concepts/product-billing/github-actions> · <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows> · <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax> · <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows>

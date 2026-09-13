# Deployment plan — Vercel, Render and Neon free tiers

Every platform limit quoted below comes from the vendor's own documentation and
was verified on 2026-09-13. Where a limit drove a design decision, the reasoning
is stated. Unverified specifics are flagged.

---

## 1. Read this first: the Vercel Hobby commercial-use restriction

> "Hobby teams are restricted to non-commercial personal use only. All commercial
> usage of the platform requires either a Pro or Enterprise plan."
>
> "Commercial usage is defined as any Deployment that is used for the purpose of
> financial gain of anyone involved in any part of the production of the project,
> including a paid employee or consultant writing the code."
>
> — <https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage>

**Strike is a B2B advisory tool for businesses deciding how to buy electricity.**
Deploying it on Vercel Hobby for that purpose is outside Vercel's terms. Vercel is
therefore recommended here **only** for evaluation, a personal demo, or with a
Pro plan.

This is the single most important constraint in this document, and it is the
reason the recommended architecture below leads with Render rather than Vercel.

---

## 2. Recommended architecture

```
                    ┌──────────────────────────────┐
   browser ────────▶│  Render Web Service (free)   │
                    │  Fastify: /api + static SPA   │
                    └───────────────┬──────────────┘
                                    │ pg (pooled)
                                    ▼
                    ┌──────────────────────────────┐
                    │  Neon Postgres (free)        │
                    └───────────────▲──────────────┘
                                    │ pg (direct)
                    ┌───────────────┴──────────────┐
                    │  GitHub Actions (daily cron) │
                    │  ingests EMC + EMA data      │
                    └──────────────────────────────┘
```

**Why this shape:**

| Decision | Reason |
|---|---|
| Single Render service serves API **and** the built client | No CORS to configure, one deploy, one URL. |
| Neon Postgres, not SQLite | Render's free filesystem is ephemeral: "any changes to your web service's filesystem (uploaded images, local SQLite databases, etc.) are lost every time the service redeploys, restarts, or spins down." Vercel functions have no disk at all. |
| Ingestion in GitHub Actions | Render free has **no** cron jobs, and a free web service is asleep most of the time. A workflow runner is always available and writes straight to Neon. |
| Vercel omitted from the critical path | The Hobby commercial-use restriction above. |

---

## 3. Step by step

### 3.1 Neon — the database

1. Create a project at <https://neon.com>. Choose the region closest to your
   Render region (`ap-southeast-1` pairs with Render's Singapore).
2. Copy the **pooled** connection string — the hostname contains `-pooler`.
   ```
   postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
3. Keep the **direct** (non-pooled) string too. Use it for any one-off bulk
   backfill: Neon's own guidance is direct connections for "long-running
   analytics queries — avoid pool contention", and the initial multi-year
   backfill is exactly that.

No manual schema step is needed. The app creates its tables on first connection
(`CREATE TABLE IF NOT EXISTS`, idempotent, safe on every cold start).

> **Verified limits:** 0.5 GB storage/project, 100 CU-hours/project/month, 5 GB
> egress, 100 projects, 10 branches. Scale-to-zero after 5 minutes of inactivity
> **cannot be disabled on Free**; resuming takes "a few hundred milliseconds".
> Exceeding CU-hours or egress **suspends compute** until the next billing period
> — data is not deleted.
> <https://neon.com/docs/introduction/plans>

**Sizing check.** 58,896 rows of half-hourly data is well under 0.5 GB. The risk
is CU-hours, not storage: 100 CU-hours at 0.25 CU is ~400 awake hours/month, so a
compute that never slept would exhaust the free allowance. Scale-to-zero is
therefore working in your favour — leave it on.

### 3.2 Render — the application

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, point it at the repo. `render.yaml` is picked
   up automatically.
3. When prompted, set `DATABASE_URL` to the Neon **pooled** string.
4. Deploy. The health check is `/api/health`.

> **Verified limits:** free web service is 0.1 CPU / 512 MB, spins down after 15
> minutes idle, takes "about one minute" to spin up, 750 instance hours per
> workspace per month (enough for one always-on service, reset monthly, no
> rollover). Render states plainly: "Do not use them for production
> applications."
> <https://render.com/docs/free>

**Expect a ~1 minute cold start on the first request after idle.** This is
inherent to the free tier, not something the app can fix. If that is unacceptable,
Render's cheapest paid instance removes both the spin-down and the ephemeral
filesystem.

### 3.3 GitHub Actions — ingestion

1. Add repository secret `DATABASE_URL` (the **pooled** string) under
   *Settings → Secrets and variables → Actions*.
2. The workflow in `.github/workflows/ingest.yml` runs daily at 18:10 UTC
   (02:10 SGT) and can be triggered manually.

> **Verified limits:** GitHub Free includes 2,000 Actions minutes/month for
> private repos (unlimited for public repos). Scheduled workflows only run on the
> default branch, have a 5-minute minimum interval, and may be delayed or dropped
> during high load — which is why the schedule sits at 10 past the hour rather
> than on it.
> <https://docs.github.com/en/billing/concepts/product-billing/github-actions>

A run here takes roughly a minute, so this consumes about 30 of the 2,000 free
minutes a month.

### 3.4 First-run backfill

The daily job only re-fetches 14 days. Seed the full history once, locally,
against the **direct** connection string:

```bash
DATABASE_URL="postgresql://...@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" \
  npm run sync:tariff

DATABASE_URL="postgresql://...@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" \
  npm run sync -- --from 2023-05-05

DATABASE_URL="postgresql://...@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" \
  npm run seed
```

That is ~59,000 rows, roughly 17 requests, and completes in a couple of minutes.

---

## 4. Alternative: split frontend and API

Use this when you want Vercel's CDN for the static client. It uses only
well-documented behaviour on both platforms.

1. **Vercel** — import the repo; the included `vercel.json` sets the framework to
   Vite, builds `web/`, and rewrites deep links to `index.html`. Set
   `VITE_API_BASE` to the Render URL and redeploy.
2. **Render** — as above, plus `ALLOWED_ORIGINS=https://your-app.vercel.app`.

The API emits CORS headers **only** for origins in that allowlist. Unset, it emits
none, which is the secure default for the single-process setup.

> **Not recommended:** running the Fastify API itself as a Vercel Function
> alongside the static client. Fastify does have official zero-config support
> (<https://vercel.com/docs/frameworks/backend/fastify>), and Hobby's 300 s
> function ceiling would comfortably fit the ingestion job — but Vercel's docs do
> not describe how a static Vite output and a Fastify Function coexist in one
> project, and that combination is untested here.

---

## 5. Platform limits that shaped the design

| Limit | Value | Consequence |
|---|---|---|
| Vercel Hobby commercial use | **Not permitted** | Excluded from the recommended path. |
| Vercel Hobby cron | Once per day, ±59 min | Would be sufficient, if Hobby were usable commercially. |
| Vercel function duration (Hobby) | 300 s default **and** max (fluid compute) | A 60 s ingestion job fits — but only on fluid compute. Legacy projects cap at 60 s. |
| Render free cron | **Not included** ($1/month minimum) | Ingestion moved to GitHub Actions. |
| Render free spin-down | 15 min idle, ~1 min cold start | Accept, or pay for an always-on instance. |
| Render free filesystem | Ephemeral | SQLite is unusable in production; Neon is mandatory. |
| Render free Postgres | **Expires 30 days after creation** | Not used. Neon instead. |
| Neon scale-to-zero | 5 min, cannot be disabled on Free | Intentional: cuts CU-hour burn. |
| Neon CU-hours | 100/project/month | Enough with scale-to-zero; not enough for an always-awake compute. |
| Neon pooled connections | `SET`/`LISTEN` unsupported | The app issues none — verified. |

---

## 6. Implementation notes

**Postgres-specific handling.** `INSERT … ON CONFLICT DO UPDATE` and `TEXT` are
identical in SQLite and Postgres. `INTEGER PRIMARY KEY AUTOINCREMENT` becomes
`GENERATED ALWAYS AS IDENTITY`; `PRAGMA` is SQLite-only and simply absent; `?`
placeholders become `$1, $2, …`.

**The `ssl` trap.** node-postgres silently discards an explicit `ssl` option when
`sslcert`, `sslkey`, `sslrootcert` or `sslmode` appear in the connection string.
Neon's strings include `sslmode=require`, so the app strips those parameters
before constructing the pool and configures TLS explicitly. Without this, TLS
settings appear to be applied but are not.

**Unique constraint with NULLs.** Postgres treats NULLs as distinct in a plain
`UNIQUE` constraint, so a contract offer with no fixed term could be inserted
repeatedly. Both drivers therefore use an expression index over
`COALESCE(term_months, 0)`.

**Timestamp comparison.** Market rows are stored as ISO8601 with a `+08:00`
offset. Bound values generated by `toISOString()` carry `Z`. Comparing those
lexicographically is not a valid time comparison — it happens to work across
months and misclassifies rows within the same day. Query bounds are therefore
emitted in the stored format (`sgtIso()` in `src/server.ts`).

**Windowed queries.** Each request fetches only its analytics window rather than
the full history. On a 0.25 CU Neon compute that is the difference between a
bounded read and a multi-megabyte transfer per page load.

**Cost-control guards.** The `/api/cron/sync` endpoint returns 503 if
`CRON_SECRET` is unset, so it can never act as an open trigger for unbounded
outbound fetching. Ingestion also chunks requests and throttles between them.

---

## 7. Cost

| Service | Free tier | If you outgrow it |
|---|---|---|
| Render web service | $0 (with spin-down) | ~$7/month for always-on |
| Neon Postgres | $0 | Paid plan if you exceed 0.5 GB or 100 CU-hours |
| GitHub Actions | $0 (2,000 min/month private) | Rarely needed; ~30 min/month used |
| Vercel | $0 Hobby — **non-commercial only** | $20/month Pro |

**Total for a compliant commercial deployment: roughly $7/month** (Render
always-on), or $0 if the cold start is acceptable for a pilot.

---

## 8. What is not verified

- Whether Vercel Hobby enforces a monthly build-minute quota — no such quota is
  documented; its absence is not proof none exists.
- Whether Vercel Cron's once-per-day rule interacts with a `timezone` setting.
- Whether GitHub Actions' 60-day inactivity disable applies to private repos —
  current docs state the rule only for public repositories.
- Real aggregate performance of the ~59k-row analytics on a 0.25 CU Neon compute.
- Neon's explicit default compute size for a new project (the plan table says
  autoscaling up to 2 CU; a specific minimum was not stated).
- Whether a Vite static output and a Fastify Function can share one Vercel project.

---

## 9. Validating the deployment

```bash
# Storage driver, row count, newest period
curl -s https://your-service.onrender.com/api/health

# Confirm Neon is live and SQLite is not in use
curl -s https://your-service.onrender.com/api/sources | grep -o '"driver":"[a-z]*"'

# Prove a full round trip is possible
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://your-service.onrender.com/api/cron/sync
```

`/api/health` reports `storage.driver`. If it says `sqlite` in production,
`DATABASE_URL` is not set and **your data will be lost on the next restart**.

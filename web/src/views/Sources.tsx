/**
 * Data sources and provenance.
 *
 * This view exists because a "real data only" claim is worthless unless it is
 * auditable. Every number in the app can be traced from here: which publisher,
 * which endpoint, when it was fetched, and — where a documented path failed —
 * exactly how it failed.
 */
import { useEffect, useState } from "react";
import { api, type Dashboard, type MarketFactSheet, type SourceStatus } from "../api.ts";
import { Card, Chip, KV, Note, Tile, fmt } from "../components/ui.tsx";

const ACCESS_LABEL: Record<string, { text: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  open: { text: "Open / unauthenticated", tone: "good" },
  scrape: { text: "Public page, parsed", tone: "info" },
  auth_required: { text: "Requires an account", tone: "warn" },
  manual: { text: "Manually verified", tone: "warn" },
  broken: { text: "Documented but non-functional", tone: "bad" },
};

export function SourcesView({
  data,
  onSync,
  syncing,
}: {
  data: Dashboard;
  onSync: (k: "market" | "tariff") => void;
  syncing: string | null;
}) {
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [facts, setFacts] = useState<MarketFactSheet | null>(data.facts ?? null);
  const [storage, setStorage] = useState<
    | {
        driver: "sqlite" | "postgres";
        target: string;
        detail: string;
        durable: boolean;
        warning: string | null;
      }
    | null
  >(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .sources()
      .then((r) => {
        if (cancelled) return;
        setSources(r.sources);
        setFacts(r.facts);
        setStorage(r.storage ?? null);
      })
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="stack" style={{ gap: 18 }}>
      {storage?.warning && (
        <Note tone="bad">
          <strong>This deployment is not storing data durably.</strong> {storage.warning}
        </Note>
      )}
      {storage?.durable && storage.driver === "postgres" && (
        <Note tone="good">
          <strong>Persistent storage active.</strong> Writing to Postgres at{" "}
          <span className="mono">{storage.target}</span>, so ingested data survives restarts and
          redeploys.
        </Note>
      )}

      <div className="grid g-4">
        <Tile
          label="Market periods stored"
          value={data.status.count.toLocaleString()}
          note={`${data.status.span_days.toFixed(0)} days of half-hourly data`}
        />
        <Tile
          label="Oldest data"
          value={fmt.sgtShort(data.status.first)}
          note={fmt.date(data.status.first)}
        />
        <Tile
          label="Newest data"
          value={fmt.sgtShort(data.status.last)}
          tone={data.status.stale ? "warn" : "good"}
          note={fmt.sgt(data.status.last)}
        />
        <Tile
          label="Publisher's own stamp"
          value={data.status.emc_last_updated ?? "—"}
          note="EMC 'Last Updated' column, stored per row"
        />
      </div>

      {err && <Note tone="bad">Could not load source details: {err}</Note>}

      <Card
        title="Where every number comes from"
        subtitle="Each source below is queried live or synced on demand. Where a documented path does not work, the failure is reported rather than worked around silently."
        right={
          <div className="hstack">
            <button className="btn btn-ghost btn-sm" onClick={() => onSync("market")} disabled={!!syncing}>
              {syncing === "market" ? "Syncing…" : "Refresh market feed"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => onSync("tariff")} disabled={!!syncing}>
              {syncing === "tariff" ? "Syncing…" : "Refresh tariff"}
            </button>
          </div>
        }
      >
        <div className="stack">
          {(sources ?? []).map((s) => {
            const access = ACCESS_LABEL[s.access] ?? ACCESS_LABEL.manual;
            const ok = s.status === "OK";
            return (
              <div
                key={s.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-tile)",
                  padding: 15,
                  background: s.active ? "var(--background-alt)" : "var(--surface)",
                }}
              >
                <div className="hstack" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                  <div className="hstack" style={{ gap: 9 }}>
                    <strong style={{ fontSize: 13.5 }}>{s.name}</strong>
                    <Chip tone={access.tone}>{access.text}</Chip>
                  </div>
                  <Chip tone={ok ? "good" : s.active ? "warn" : "bad"} dot>
                    {s.active ? (ok ? "live" : s.status) : "superseded"}
                  </Chip>
                </div>

                <p className="small muted" style={{ margin: "0 0 9px" }}>
                  {s.provides}
                </p>

                <div className="grid g-2" style={{ gap: 12 }}>
                  <div>
                    <KV k="Publisher" v={s.publisher} />
                    {s.unit && <KV k="Unit" v={s.unit} />}
                    <KV k="Endpoint" v={<span className="mono small">{s.endpoint ?? s.url}</span>} />
                    <KV
                      k="Human page"
                      v={
                        <a className="src-link" href={s.url} target="_blank" rel="noreferrer">
                          {s.url}
                        </a>
                      }
                    />
                  </div>
                  <div>
                    {Object.entries(s.stored ?? {}).map(([k, v]) => (
                      <KV
                        key={k}
                        k={k.replace(/_/g, " ")}
                        v={v === null || v === undefined ? "—" : String(v)}
                      />
                    ))}
                    {s.last_run && (
                      <>
                        <KV k="Last run" v={`${s.last_run.status} · ${fmt.sgt(s.last_run.started_at)}`} />
                        {s.last_run.records > 0 && (
                          <KV k="Records" v={s.last_run.records.toLocaleString()} />
                        )}
                      </>
                    )}
                  </div>
                </div>

                {s.limitation && (
                  <div className="mt-2">
                    <Note tone="warn">{s.limitation}</Note>
                  </div>
                )}

                {s.notes && !s.limitation && (
                  <p className="faint small mt-1" style={{ marginBottom: 0 }}>
                    {s.notes}
                  </p>
                )}

                {s.probe && s.probe.ran && (
                  <div className="mt-2">
                    <div className="hstack" style={{ marginBottom: 6 }}>
                      <strong className="small">Live probe of the spec-mandated path</strong>
                      <Chip tone={s.probe.available ? "good" : "bad"}>
                        {s.probe.available ? "returned data" : "returned no data"}
                      </Chip>
                    </div>
                    <Note tone="bad">
                      {s.probe.verdict}
                    </Note>
                    {(() => {
                      const raw = s.probe.raw as
                        | {
                            python?: string;
                            installed_version?: string;
                            probes?: { date: string; ok: boolean; rows: number; error: string | null }[];
                          }
                        | null;
                      if (!raw?.probes?.length) return null;
                      return (
                        <table className="tbl mt-1">
                          <thead>
                            <tr>
                              <th>Probed date</th>
                              <th className="num">Rows returned</th>
                              <th>Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {raw.probes.map((p) => (
                              <tr key={p.date}>
                                <td className="mono">{p.date}</td>
                                <td className="num">{p.rows}</td>
                                <td className="small">
                                  {p.ok ? "data returned" : p.error ?? "no data"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}
                    <p className="faint small mt-1" style={{ marginBottom: 0 }}>
                      Executed in the project virtualenv against{" "}
                      <span className="mono">
                        energy-trading-api=={(s.probe.raw as any)?.installed_version ?? "0.0.34"}
                      </span>
                      , Python {(s.probe.raw as any)?.python ?? "—"}. Recorded rather than removed,
                      because a reader is entitled to know the difference between a source that was
                      never tried and one that was tried and failed.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          {!sources && !err && <p className="muted small">Loading source status…</p>}
        </div>
      </Card>

      <Card
        title="How to read the coverage"
        subtitle="Half-hourly wholesale data is the backbone of every figure in this app."
      >
        <div className="grid g-2">
          <div>
            <KV k="Data type" v="Half-hourly settlement prices and volumes" />
            <KV k="Periods per day" v="48" />
            <KV k="Oldest available" v={fmt.sgt(data.status.first)} />
            <KV k="Newest available" v={fmt.sgt(data.status.last)} />
            <KV k="Span" v={`${data.status.span_days.toFixed(0)} days`} />
          </div>
          <div>
            <KV
              k="Storage"
              v={
                storage
                  ? `${storage.driver === "postgres" ? "Postgres" : "SQLite"} · ${storage.target}`
                  : "—"
              }
            />
            <KV k="Provenance" v="Per-row source id and observed timestamp" />
            <KV k="Publisher stamp" v={data.status.emc_last_updated ?? "—"} />
            <KV
              k="Freshness"
              v={
                <span style={{ color: data.status.stale ? "var(--danger)" : "var(--success)" }}>
                  {fmt.rel(data.status.age_hours)} {data.status.stale ? "(stale)" : "(fresh)"}
                </span>
              }
            />
            <KV k="Ingestion cadence" v="Manual or scheduled via the sync API" />
          </div>
        </div>
      </Card>

      {facts && (
        <>
          <Card
            title="Market context"
            subtitle={facts.disclaimer}
          >
            <div className="stack">
              {facts.groups.map((g) => (
                <div key={g.id}>
                  <h3 className="section-title">{g.title}</h3>
                  <p className="small muted" style={{ marginTop: 0 }}>
                    {g.intro}
                  </p>
                  <div className="stack" style={{ gap: 9 }}>
                    {g.facts.map((f, i) => (
                      <div
                        key={i}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--r-chip)",
                          padding: "11px 13px",
                          background: "var(--background-alt)",
                        }}
                      >
                        <div className="hstack" style={{ justifyContent: "space-between" }}>
                          <strong className="small">{f.label}</strong>
                          <Chip tone={f.verified ? "good" : "warn"}>
                            {f.verified ? "verified" : "unverified"}
                          </Chip>
                        </div>
                        <div style={{ fontWeight: 620, marginTop: 4, fontSize: 13 }}>{f.value}</div>
                        {f.detail && (
                          <p className="small muted" style={{ margin: "4px 0 0" }}>
                            {f.detail}
                          </p>
                        )}
                        <a
                          className="src-link"
                          href={f.source_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: "inline-block", marginTop: 5 }}
                        >
                          {f.source_url}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Official references" subtitle="Primary sources for anything you intend to act on.">
            <ul className="stack" style={{ gap: 7, paddingLeft: 18, margin: 0 }}>
              {facts.regulatory_links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noreferrer">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <Note tone="bad">
        <strong>Data that is deliberately absent.</strong> This application will not invent a price.
        Where a documented access path fails, the affected analytics are left empty and labelled
        rather than filled with an estimate. Business electricity contract rates are not published by
        most retailers, so the fixed-price quotes you see are either real published SME rates with
        their source recorded in the notes field, or rates you entered yourself. Treat every quote as
        needing verification against the retailer's own fact sheet before you sign anything.
      </Note>
    </div>
  );
}

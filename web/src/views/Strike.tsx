/** The recommendation view: verdict, evidence, and cost consequences. */
import type { Dashboard } from "../api.ts";
import { BarChart, HBarChart } from "../components/charts.tsx";
import { Card, Chip, KV, Note, Tile, fmt } from "../components/ui.tsx";
import { FairValueCard } from "../components/FairValue.tsx";
import { ProfileControls, type ProfileState } from "../App.tsx";

const VERDICT_META: Record<
  string,
  { short: string; glyph: string; cls: string; tone: "good" | "info" | "neutral" }
> = {
  STRIKE_FIXED: { short: "Lock in", glyph: "✓", cls: "lock", tone: "good" },
  FLOAT_WHOLESALE: { short: "Float", glyph: "≈", cls: "float", tone: "info" },
  HOLD_REGULATED: { short: "Hold", glyph: "⏸", cls: "hold", tone: "neutral" },
  INSUFFICIENT_DATA: { short: "No call", glyph: "?", cls: "hold", tone: "neutral" },
};

export function StrikeView({
  data,
  profile,
  setProfile,
  onSync,
  syncing,
}: {
  data: Dashboard;
  profile: ProfileState;
  setProfile: (p: ProfileState) => void;
  onSync: (k: "market" | "tariff") => void;
  syncing: string | null;
}) {
  const s = data.signal;
  if (!s) return null;
  const meta = VERDICT_META[s.verdict] ?? VERDICT_META.INSUFFICIENT_DATA;
  const pc = s.price_context;
  const fv = s.forward_view;

  const annualBars = s.annualised.map((a) => ({
    label: a.label,
    value: a.annual_sgd,
    highlight: a.route === "fixed" || a.delta_vs_tariff_sgd < 0,
    sub: `${a.effective_c_kwh.toFixed(2)} c/kWh${
      a.route === "regulated" ? " (baseline)" : ` · ${a.delta_vs_tariff_sgd >= 0 ? "+" : "−"}${fmt.sgd(Math.abs(a.delta_vs_tariff_sgd))} vs tariff`
    }`,
  }));

  return (
    <div className="stack" style={{ gap: 18 }}>
      {/* Hero */}
      <div className="hero">
        <div className="hero-verdict">
          <div className={`hero-badge ${meta.cls}`} aria-hidden="true">
            {meta.glyph}
          </div>
          <div style={{ flex: "1 1 380px" }}>
            <div className="hstack" style={{ gap: 8, marginBottom: 6 }}>
              <Chip tone={meta.tone}>{meta.short}</Chip>
              <Chip tone={s.confidence === "high" ? "good" : s.confidence === "medium" ? "warn" : "neutral"}>
                {s.confidence} confidence
              </Chip>
              <span className="faint small">
                {data.window?.periods.toLocaleString()} real half-hour periods ·{" "}
                {fmt.sgt(data.status.last)}
              </span>
            </div>
            <h1 className="hero-headline">{s.headline}</h1>
            <div className="hero-meta">
              Against the {s.tariff_quarter} regulated tariff of{" "}
              <strong>{s.tariff_c_kwh.toFixed(2)} c/kWh</strong> ex-GST, for a site using{" "}
              {profile.mwh.toLocaleString()} MWh a year.
            </div>
          </div>

          <div className="score-wrap">
            <div className="score-cap">Lock-in score</div>
            <div className="score-num">{s.score}</div>
            <div className="score-track">
              <div className="score-pin" style={{ left: `calc(${s.score}% - 2px)` }} />
            </div>
            <div className="score-ends">
              <span>Float</span>
              <span>Hold</span>
              <span>Lock</span>
            </div>
          </div>
        </div>
      </div>

      {/* Profile controls */}
      <Card
        title="Your site"
        subtitle="Four inputs. Everything below recomputes from them against the same real market data. Hover or tap any ⓘ for guidance on what to enter, including worked examples."
      >
        <ProfileControls
          profile={profile}
          setProfile={setProfile}
          showAlpha
        />
      </Card>

      {/* Key numbers */}
      <div className="grid g-4">
        <Tile
          label="Latest real USEP"
          value={pc ? pc.latest_usep.toFixed(0) : "—"}
          unit="S$/MWh"
          tone={pc && pc.percentile_in_window > 75 ? "bad" : pc && pc.percentile_in_window < 25 ? "good" : undefined}
          note={pc ? `${pc.percentile_in_window.toFixed(0)}th percentile of the window` : undefined}
        />
        <Tile
          label="Wholesale all-in"
          value={
            s.comparison ? (s.comparison.usep.avg / 10 + s.comparison.non_energy.total_c).toFixed(2) : "—"
          }
          unit="c/kWh"
          note={
            s.comparison
              ? `USEP avg ${s.comparison.usep.avg.toFixed(0)} + ${s.comparison.non_energy.total_c.toFixed(2)} non-energy`
              : undefined
          }
        />
        <Tile
          label="Regulated tariff"
          value={s.tariff_c_kwh.toFixed(2)}
          unit="c/kWh"
          note={`${s.tariff_quarter} · excludes 9% GST`}
        />
        <Tile
          label="Price volatility"
          value={s.comparison ? s.comparison.usep.volatility_pct.toFixed(0) : "—"}
          unit="%"
          tone={s.comparison && s.comparison.usep.volatility_pct > 45 ? "warn" : undefined}
          note="Dispersion of USEP around its mean"
        />
      </div>

      {/* Fair value reference — frames whether today's prices are cheap or dear */}
      {data.fair_value && (
        <Card
          title="Fair value reference price"
          subtitle="The long-run cost of supplying electricity in Singapore, built from two independent published anchors. Use it to judge whether what you are being quoted is cheap or dear — not as a price to transact at."
        >
          <FairValueCard fv={data.fair_value} />
        </Card>
      )}

      {/* Reasons */}
      <div className="grid g-23">
        <Card
          title="Why this recommendation"
          subtitle="Every point is tied to the real number behind it. Disagree with the conclusion and the evidence still stands."
        >
          <div className="reasons">
            {s.reasons.map((r, i) => (
              <div key={i} className={`reason ${r.direction}`}>
                <div className="reason-icon" aria-hidden="true">
                  {r.direction === "lock" ? "↑" : r.direction === "float" ? "↓" : "•"}
                </div>
                <div>
                  <div className="reason-text">{r.text}</div>
                  <div className="reason-evidence">{r.evidence}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Annual cost by route" subtitle={`At ${profile.mwh.toLocaleString()} MWh a year, ex-GST.`}>
            {annualBars.length ? (
              <HBarChart rows={annualBars} format={(v) => fmt.sgd(v)} />
            ) : (
              <p className="muted small">No routes to compare.</p>
            )}
          </Card>

          {pc && (
            <Card title="Where today sits" subtitle="Position of the latest real price within the analysis window.">
              <KV k="Latest period" v={fmt.sgt(pc.latest_ts)} />
              <KV k="Latest USEP" v={`${pc.latest_usep.toFixed(2)} S$/MWh`} />
              <KV k="10th percentile" v={`${pc.window_p10.toFixed(0)} S$/MWh`} />
              <KV k="Median" v={`${pc.window_p50.toFixed(0)} S$/MWh`} />
              <KV k="90th percentile" v={`${pc.window_p90.toFixed(0)} S$/MWh`} />
              <KV
                k="7-day vs 30-day trend"
                v={
                  <span style={{ color: pc.trend_7d_vs_30d_pct >= 0 ? "var(--danger)" : "var(--success)" }}>
                    {pc.trend_7d_vs_30d_pct >= 0 ? "▲" : "▼"} {Math.abs(pc.trend_7d_vs_30d_pct).toFixed(1)}%
                  </span>
                }
              />
            </Card>
          )}
        </div>
      </div>

      {/* Forward view */}
      {fv && s.forecast && (
        <Card
          title={`Next ${fv.horizon_hours} hours, forecast`}
          subtitle={s.forecast.method}
          right={
            <div className="hstack">
              <Chip tone={fv.direction === "rising" ? "bad" : fv.direction === "falling" ? "good" : "neutral"}>
                {fv.direction}
              </Chip>
              <Chip tone="info">backtest {s.forecast.backtest.mape_pct}% MAPE</Chip>
            </div>
          }
        >
          <BarChart
            data={s.forecast.points.map((p) => ({
              label: p.label.slice(5),
              value: p.predicted,
              meta: [
                { k: "Period", v: p.label },
                ...(p.basis.length
                  ? [{ k: "Based on", v: `${p.basis.length} prior weeks: ${p.basis.slice(-3).join(", ")}` }]
                  : []),
              ],
            }))}
            height={230}
            color="var(--chart-1)"

            format={(v) => v.toFixed(0)}
            valueSuffix=" S$/MWh"
          />

          <div className="mt-2">
            <Note tone={s.forecast.backtest.skill_pct >= 0 ? "info" : "warn"}>
              {s.forecast.backtest.interpretation}
            </Note>
          </div>

          {data.cheapest_windows && data.cheapest_windows.length > 0 && (
            <>
              <h3 className="section-title mt-3">Cheapest forecast windows for deferrable load</h3>
              <div className="tbl-scroll">
<table className="tbl">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="num">Forecast USEP</th>
                    <th className="num">vs forecast average</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cheapest_windows.map((w) => (
                    <tr key={w.ts}>
                      <td>{w.label}</td>
                      <td className="num">{w.price.toFixed(0)} S$/MWh</td>
                      <td className="num" style={{ color: "var(--success)" }}>
                        {w.vs_average_pct.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
</div>
            </>
          )}
        </Card>
      )}

      <Note tone="info">
        <strong>How to read this.</strong> The lock-in score is a transparent weighted sum of the
        points above, not a black box: it starts at 50 and moves with the gap between your best
        quoted fixed rate and the regulated tariff, the gap between all-in wholesale cost and the
        tariff, realised volatility, the forecast direction, and where the current price sits in
        its range. Prices come from EMC's half-hourly feed; the tariff comes from EMA. Your load
        shape is modelled from the real national demand profile — see{" "}
        <em>Load shifting</em> for the assumptions.
      </Note>
    </div>
  );
}

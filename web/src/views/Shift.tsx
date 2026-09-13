/** Load shifting: an optimisation over real prices, plus the forecast behind it. */
import { useMemo, useState } from "react";
import type { Dashboard } from "../api.ts";
import { AreaChart, BarChart, HBarChart, priceColor } from "../components/charts.tsx";
import { Card, Chip, KV, Note, Tile, fmt } from "../components/ui.tsx";
import { ProfileControls, type ProfileState } from "../App.tsx";

export function ShiftView({
  data,
  profile,
  setProfile,
  onChanged,
}: {
  data: Dashboard;
  profile: ProfileState;
  setProfile: (p: ProfileState) => void;
  onChanged: () => void;
}) {
  const shift = data.shift;
  const diag = data.load_diagnostics;
  const [showMoves, setShowMoves] = useState(false);

  const forecastPoints = useMemo(
    () =>
      (data.signal?.forecast?.points ?? []).map((p) => ({
        label: p.label.slice(5),
        value: p.predicted,
        meta: [{ k: "Period", v: p.label }],
      })),
    [data.signal?.forecast]
  );

  const intradayBars = useMemo(() => {
    // Colour each slot by its real mean price within the day's own range, so
    // expensive and cheap windows are visible at a glance. `priceColor` mixes
    // from the design tokens, so this tracks the active theme.
    const all = (data.intraday ?? []).map((x) => x.mean_usep);
    const lo = all.length ? Math.min(...all) : 0;
    const hi = all.length ? Math.max(...all) : 1;
    return (data.intraday ?? []).map((p) => ({
      label: p.label,
      value: p.mean_usep,
      color: priceColor(hi > lo ? (p.mean_usep - lo) / (hi - lo) : 0.5),
      meta: [
        { k: "Slot", v: p.label },
        { k: "Mean USEP", v: `${p.mean_usep.toFixed(2)} S$/MWh` },
        { k: "Samples", v: String(p.samples) },
      ],
    }));
  }, [data.intraday]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <Card
        title="Your site"
        subtitle="Curtailable load is the amount of demand you can move between half-hour periods — chillers, thermal storage, batch processes, EV charging."
      >
        <ProfileControls profile={profile} setProfile={setProfile} />
      </Card>

      {diag && (
        <div className="grid g-4">
          <Tile
            label="Modelled peak demand"
            value={diag.peak_mw.toFixed(2)}
            unit="MW"
            note={`from ${profile.mwh.toLocaleString()} MWh a year`}
          />
          <Tile
            label="Load factor"
            value={(diag.load_factor * 100).toFixed(0)}
            unit="%"
            note="Average ÷ peak. Higher means flatter."
          />
          <Tile
            label="Energy in peak window"
            value={(diag.peak_window_share * 100).toFixed(0)}
            unit="%"
            note="Share consumed on weekdays 08:00–19:59"
          />
          <Tile
            label="Data coverage"
            value={(diag.coverage * 100).toFixed(0)}
            unit="%"
            tone={diag.coverage > 0.95 ? "good" : "warn"}
            note={`${diag.usable_periods.toLocaleString()} usable periods`}
          />
        </div>
      )}

      {shift && (
        <>
          <div className="grid g-23">
            <Card
              title="Optimal shift against real prices"
              subtitle="A greedy optimiser pairs the most expensive half hours with the cheapest ones, subject to how much load you can actually move. It only ever moves energy from a genuinely dearer period to a cheaper one, so the saving cannot be negative."
              right={
                <Chip tone={shift.saving_sgd > 0 ? "good" : "neutral"}>
                  {fmt.sgd(shift.saving_sgd)} over {shift.constraints.window_days} days
                </Chip>
              }
            >
              <HBarChart
                rows={[
                  {
                    label: "Average price load is moved OUT of",
                    value: shift.from_avg_price,
                    sub: `${shift.shed_periods} half-hour periods reduced`,
                  },
                  {
                    label: "Average price load is moved INTO",
                    value: shift.to_avg_price,
                    sub: `${shift.absorb_periods} half-hour periods increased`,
                    highlight: true,
                  },
                ]}
                format={(v) => `${v.toFixed(0)} S$/MWh`}
                positiveColor="var(--chart-4)"
                negativeColor="var(--chart-3)"
              />
              <p className="small mt-2" style={{ color: "var(--text-secondary)" }}>
                {shift.explanation}
              </p>
            </Card>

            <Card title="What the optimiser achieved">
              <KV k="Energy shifted" v={`${shift.shifted_mwh.toFixed(1)} MWh`} />
              <KV k="Captured spread" v={`${shift.captured_spread.toFixed(2)} S$/MWh`} />
              <KV k="Gross saving" v={<strong>{fmt.sgd(shift.saving_sgd)}</strong>} />
              <KV k="Max per period" v={`${shift.constraints.max_shed_per_period_mwh.toFixed(2)} MWh`} />
              <KV k="Window" v={`${shift.constraints.window_days} days`} />
              <p className="faint small mt-2">
                Annualised, this spread is worth roughly{" "}
                <strong>
                  {fmt.sgd((shift.saving_sgd / Math.max(1, shift.constraints.window_days)) * 365)}
                </strong>{" "}
                if the pattern persists. It will not persist exactly — that figure assumes every day
                looks like the recent average.
              </p>
            </Card>
          </div>

          {shift.moves.length > 0 && (
            <Card
              title="The shift plan itself"
              subtitle="Each row is a real half-hour period, its real price, and where that load goes instead."
              right={
                <button className="btn btn-ghost btn-sm" onClick={() => setShowMoves((v) => !v)}>
                  {showMoves ? "Hide" : `Show all ${shift.moves.length}`}
                </button>
              }
            >
              <div className="tbl-scroll">
<table className="tbl">
                <thead>
                  <tr>
                    <th>Move load out of</th>
                    <th className="num">USEP</th>
                    <th className="num">MWh</th>
                    <th>Move load into</th>
                    <th className="num">USEP</th>
                  </tr>
                </thead>
                <tbody>
                  {(showMoves ? shift.moves : shift.moves.slice(0, 8)).map((m, i) => (
                    <tr key={i}>
                      <td className="mono">{m.ts.slice(0, 16).replace("T", " ")}</td>
                      <td className="num" style={{ color: "var(--danger)" }}>
                        {m.shed_price.toFixed(0)}
                      </td>
                      <td className="num">{m.shed_mwh.toFixed(2)}</td>
                      <td className="mono">{m.absorb_ts.slice(0, 16).replace("T", " ")}</td>
                      <td className="num" style={{ color: "var(--success)" }}>
                        {m.absorb_price.toFixed(0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
</div>
              <p className="faint small mt-2">
                Operationally this reads as: run deferrable load overnight and in the cheapest
                half hours, and pull it out of the spikes. Because Singapore's daytime prices are
                suppressed by solar, the cheapest windows are not always at night — check the
                times above rather than assuming.
              </p>
            </Card>
          )}
        </>
      )}

      <Card
        title="Average price shape across the day"
        subtitle="Real mean USEP by half-hour slot. Bars are coloured from cheapest (green) to dearest (red) across the day."
      >
        <BarChart
          data={intradayBars}
          height={260}
          format={(v) => v.toFixed(0)}
          valueSuffix=" S$/MWh"
          labelEvery={8}
        />
      </Card>

      {forecastPoints.length > 1 && (
        <Card
          title={`Forecast for the next ${data.signal?.forward_view?.horizon_hours ?? 48} hours`}
          subtitle={data.signal?.forecast?.method}
          right={
            <div className="hstack">
              <Chip tone="info">{data.signal?.forecast?.backtest.mape_pct}% MAPE</Chip>
              <Chip
                tone={
                  (data.signal?.forward_view?.change_pct ?? 0) > 0 ? "bad" : "good"
                }
              >
                {data.signal?.forward_view?.direction}
              </Chip>
            </div>
          }
        >
          <AreaChart
            points={forecastPoints}
            height={240}
            color="var(--chart-1)"
            format={(v) => v.toFixed(0)}
          />
          <div className="mt-2">
            <Note tone="warn">
              <strong>Forecast accuracy is reported honestly, not hidden.</strong>{" "}
              {data.signal?.forecast?.backtest.interpretation}
            </Note>
          </div>
        </Card>
      )}

      <Note tone="info">
        <strong>How the load model works.</strong> Your consumption shape is modelled as a scaled
        power of the real national demand profile: L(t) = k · D(t)^α, where α is the load-shape
        control on the previous tab. α = 0 is perfectly flat; α = 1 follows the national profile;
        higher values are peakier. The <em>timing</em> of peaks and troughs is therefore real market
        data, and only the amplitude of your response to it is modelled. The derived load factor and
        peak-window share above are there so you can check α against your own bills. A real
        half-hourly meter import would supersede the model entirely.
      </Note>
    </div>
  );
}

/** Real market prices: history, intraday shape, peak/off-peak and the tariff. */
import type { Dashboard } from "../api.ts";
import { AreaChart, BarChart, HBarChart } from "../components/charts.tsx";
import { Card, Chip, KV, Note, Tile, fmt } from "../components/ui.tsx";

export function MarketView({ data }: { data: Dashboard }) {
  const c = data.signal?.comparison;
  const daily = data.daily ?? [];
  const intraday = data.intraday ?? [];
  const quarterly = data.tariff_quarters ?? [];
  const ancillary = data.ancillary ?? [];

  // Show the daily bars newest-last, but cap the count so bars stay rounded
  // and legible rather than degenerating into a solid block.
  const maxBars = 120;
  const step = Math.max(1, Math.ceil(daily.length / maxBars));
  const dailyBars = daily
    .filter((_, i) => i % step === 0)
    .map((d) => ({
      label: d.date.slice(5),
      value: d.mean,
      meta: [
        { k: "Date", v: d.date },
        { k: "Daily mean", v: `${d.mean.toFixed(2)} S$/MWh` },
        { k: "Min", v: `${d.min.toFixed(2)} S$/MWh` },
        { k: "Max", v: `${d.max.toFixed(2)} S$/MWh` },
      ],
    }));

  const monthlyTariffs = quarterly.map((q) => ({
    label: q.quarter.replace("-", " "),
    value: q.total_c,
    meta: [
      { k: "Quarter", v: q.quarter },
      { k: "Total", v: `${q.total_c.toFixed(2)} c/kWh` },
      { k: "Energy", v: q.energy_c !== null ? `${q.energy_c.toFixed(2)} c/kWh` : "—" },
      { k: "Network", v: q.network_c !== null ? `${q.network_c.toFixed(2)} c/kWh` : "—" },
    ],
  }));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid g-4">
        <Tile
          label="Mean USEP"
          value={c ? c.usep.avg.toFixed(0) : "—"}
          unit="S$/MWh"
          note={c ? `over ${data.window?.periods.toLocaleString()} periods` : undefined}
        />
        <Tile
          label="Range"
          value={c ? `${c.usep.min.toFixed(0)}–${c.usep.max.toFixed(0)}` : "—"}
          unit="S$/MWh"
          note="Real minimum and maximum observed"
        />
        <Tile
          label="Volatility"
          value={c ? c.usep.volatility_pct.toFixed(0) : "—"}
          unit="%"
          tone={c && c.usep.volatility_pct > 45 ? "warn" : undefined}
          note="Standard deviation ÷ mean"
        />
        <Tile
          label="Data coverage"
          value={data.status.span_days.toFixed(0)}
          unit="days"
          tone={data.status.stale ? "warn" : "good"}
          note={`EMC last updated ${data.status.emc_last_updated ?? "—"}`}
        />
      </div>

      <Card
        title="Daily average wholesale price"
        subtitle="Each bar is one day's mean of 48 real half-hourly USEP settlements. Hover for the day's range."
        right={<Chip tone="info">{data.window?.days}-day window</Chip>}
      >
        <BarChart
          data={dailyBars}
          height={260}
          color="var(--chart-1)"

          format={(v) => v.toFixed(0)}
          valueSuffix=" S$/MWh"
        />
      </Card>

      <div className="grid g-2">
        <Card
          title="Average price by time of day"
          subtitle="Real mean USEP for each half-hour slot, pooled across the window. This is the shape a load-shifting programme works against."
        >
          <BarChart
            data={intraday.map((p) => ({
              label: p.label,
              value: p.mean_usep,
              meta: [
                { k: "Slot", v: p.label },
                { k: "Mean", v: `${p.mean_usep.toFixed(2)} S$/MWh` },
                { k: "Samples", v: String(p.samples) },
              ],
            }))}
            height={250}
            color="var(--chart-1)"

            format={(v) => v.toFixed(0)}
            valueSuffix=" S$/MWh"
            labelEvery={8}
          />
        </Card>

        <Card
          title="Peak versus off-peak"
          subtitle={data.peak_off_peak?.definition}
        >
          {data.peak_off_peak && (
            <>
              <HBarChart
                rows={[
                  {
                    label: "Peak (weekday 08:00–19:59)",
                    value: data.peak_off_peak.peak_avg,
                    sub: `${data.peak_off_peak.peak_periods.toLocaleString()} periods`,
                  },
                  {
                    label: "Off-peak (nights & weekends)",
                    value: data.peak_off_peak.offpeak_avg,
                    sub: `${data.peak_off_peak.offpeak_periods.toLocaleString()} periods`,
                  },
                ]}
                format={(v) => `${v.toFixed(0)} S$/MWh`}
                positiveColor="var(--chart-1)"
              />
              <div className="mt-2">
                {data.peak_off_peak.spread >= 0 ? (
                  <Note tone="info">
                    Peak power costs <strong>{data.peak_off_peak.spread.toFixed(0)} S$/MWh</strong> more
                    than off-peak, a spread of {data.peak_off_peak.spread_pct.toFixed(1)}%. Shifting
                    deferrable load out of the peak window captures that difference without changing
                    supplier or contract.
                  </Note>
                ) : (
                  <Note tone="warn">
                    <strong>Off-peak is currently more expensive than peak</strong> by{" "}
                    {Math.abs(data.peak_off_peak.spread).toFixed(0)} S$/MWh (
                    {Math.abs(data.peak_off_peak.spread_pct).toFixed(1)}%). This happens when
                    daytime solar suppresses midday prices while evening and overnight periods carry
                    the peaks. Do not assume the conventional overnight-shift strategy pays — the
                    optimiser on the <em>Load shifting</em> tab works from real prices, not from a
                    peak/off-peak convention.
                  </Note>
                )}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid g-2">
        <Card
          title="Regulated tariff history"
          subtitle="Real quarterly tariffs published by EMA, with their component breakdown. All figures exclude GST."
        >
          {monthlyTariffs.length > 1 ? (
            <BarChart
              data={monthlyTariffs}
              height={230}
              color="var(--chart-1)"

              format={(v) => v.toFixed(1)}
              valueSuffix=" c/kWh"
              rx={8}
            />
          ) : (
            <p className="muted small">Only one quarter is stored, so there is no trend to plot.</p>
          )}
          <table className="tbl mt-2">
            <thead>
              <tr>
                <th>Quarter</th>
                <th className="num">Energy</th>
                <th className="num">Network</th>
                <th className="num">MSS</th>
                <th className="num">Admin + PSO</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...quarterly].reverse().map((q) => (
                <tr key={q.quarter}>
                  <td>{q.quarter}</td>
                  <td className="num">{q.energy_c?.toFixed(2) ?? "—"}</td>
                  <td className="num">{q.network_c?.toFixed(2) ?? "—"}</td>
                  <td className="num">{q.mss_c?.toFixed(2) ?? "—"}</td>
                  <td className="num">{q.pso_c?.toFixed(2) ?? "—"}</td>
                  <td className="num">
                    <strong>{q.total_c.toFixed(2)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small mt-1">
            All values in cents per kWh, excluding GST. Components sum exactly to the total, which is
            how EMA reconciles the published figure.
          </p>
        </Card>

        <Card
          title="Ancillary reserve prices"
          subtitle="Real clearing prices for the reserve products a curtailable load can be paid against. This is the revenue basis for Demand Response."
        >
          {ancillary.length > 1 ? (
            <AreaChart
              points={ancillary.map((a) => ({
                label: a.ts.slice(5, 10),
                value: a.contingency ?? 0,
                meta: [
                  { k: "Period", v: a.ts.slice(0, 16).replace("T", " ") },
                  { k: "Contingency", v: `${(a.contingency ?? 0).toFixed(2)} S$/MWh` },
                  { k: "Primary", v: a.primary !== null ? `${a.primary.toFixed(2)} S$/MWh` : "—" },
                  { k: "Regulation", v: a.regulation !== null ? `${a.regulation.toFixed(2)} S$/MWh` : "—" },
                ],
              }))}
              height={230}
              color="var(--chart-3)"


              format={(v) => v.toFixed(0)}
            />
          ) : (
            <p className="muted small">No ancillary price history stored.</p>
          )}
          <p className="faint small mt-1">
            Contingency Reserve price in SGD/MWh, last 30 days of stored data. Spikes are the periods
            when curtailment actually pays.
          </p>
        </Card>
      </div>

      <Card title="What moves these prices" subtitle="Structural context from the operators, not price data.">
        <div className="grid g-2">
          <div>
            <KV k="Wholesale price" v="USEP, set every half hour" />
            <KV k="Published by" v="Energy Market Company (EMC)" />
            <KV k="Unit" v="SGD per MWh" />
            <KV k="Settlement periods per day" v="48" />
          </div>
          <div>
            <KV k="Tariff benchmark" v={`${data.tariff?.quarter ?? "—"}`} />
            <KV k="Tariff basis" v="Lagged natural gas prices" />
            <KV k="Revision" v="Quarterly" />
            <KV k="GST" v="Excluded throughout this app" />
          </div>
        </div>
      </Card>
    </div>
  );
}

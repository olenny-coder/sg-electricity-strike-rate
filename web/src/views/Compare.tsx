/** Cost comparison across procurement routes, with quote management. */
import { useState } from "react";
import { api, type Dashboard } from "../api.ts";
import { HBarChart, BarChart } from "../components/charts.tsx";
import { Card, Chip, KV, Note, Tile, fmt } from "../components/ui.tsx";
import { FieldLabel } from "../components/HelpTip.tsx";
import { ProfileControls, type ProfileState } from "../App.tsx";

export function CompareView({
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
  const c = data.signal?.comparison;
  const [form, setForm] = useState({
    retailer: "",
    plan: "",
    rate: "",
    term: "24",
    notes: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!c) return null;

  const scenarioRows = c.scenarios.map((s) => ({
    label: s.label,
    value: s.total_sgd,
    highlight: s.id === c.cheapest,
    sub: `${s.effective_c_kwh.toFixed(2)} c/kWh · ${
      s.id === "regulated"
        ? "baseline"
        : `${s.delta_vs_tariff_sgd >= 0 ? "+" : "−"}${fmt.sgd(Math.abs(s.delta_vs_tariff_sgd))} vs tariff`
    }`,
  }));

  async function submit() {
    setErr(null);
    const rate = Number(form.rate);
    if (!form.retailer.trim() || !form.plan.trim()) {
      setErr("Retailer and plan name are required.");
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      setErr("Rate must be a positive number of cents per kWh.");
      return;
    }
    setSaving(true);
    try {
      await api.addOffer({
        retailer: form.retailer.trim(),
        plan: form.plan.trim(),
        rate_c_kwh: rate,
        term_months: form.term === "" ? null : Number(form.term),
        notes: form.notes.trim() || undefined,
      });
      setForm({ retailer: "", plan: "", rate: "", term: "24", notes: "" });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const quarterly = data.tariff_quarters ?? [];

  return (
    <div className="stack" style={{ gap: 18 }}>
      <Card
        title="Your site"
        subtitle="Consumption drives every cost below. The load shape affects how heavily the volatile periods weigh. Hover or tap any ⓘ for guidance on what to enter."
      >
        <ProfileControls profile={profile} setProfile={setProfile} />
      </Card>

      <div className="grid g-4">
        <Tile
          label="Window cost under tariff"
          value={fmt.sgd(c.scenarios.find((s) => s.id === "regulated")?.total_sgd ?? 0)}
          note={`${c.window.days} days · ${c.window.mwh.toLocaleString()} MWh`}
        />
        <Tile
          label="All-in wholesale"
          value={`${(c.usep.avg / 10 + c.non_energy.total_c).toFixed(2)}`}
          unit="c/kWh"
          tone={c.usep.avg / 10 + c.non_energy.total_c > data.signal!.tariff_c_kwh ? "warn" : "good"}
          note={`USEP ${c.usep.avg.toFixed(0)} + ${c.non_energy.total_c.toFixed(2)} non-energy`}
        />
        <Tile
          label="Cheapest route"
          value={
            c.cheapest === "regulated"
              ? "Tariff"
              : c.cheapest === "wholesale"
                ? "Wholesale"
                : c.scenarios.find((s) => s.id === c.cheapest)?.label.split("—")[0].trim() ?? "—"
          }
          tone="good"
          note="Over this window, on your load shape"
        />
        <Tile
          label="Quotes loaded"
          value={String(c.fixed_offers.length)}
          note="Fixed-price offers compared"
        />
      </div>

      <div className="grid g-23">
        <Card
          title="Cost of the same real consumption under each route"
          subtitle={`Identical ${c.window.mwh.toLocaleString()} MWh of modelled consumption over ${c.window.days} days, priced with real half-hourly USEP, the real published tariff, and your quoted rates. Excludes GST.`}
        >
          <HBarChart rows={scenarioRows} format={(v) => fmt.sgd(v)} height={240} />
          <p className="faint small mt-2">
            Shorter bars are cheaper. The green label marks the lowest-cost route for this window.
            A window is a snapshot, not a forecast — a fixed contract locks a price for years, while
            this comparison prices the recent past.
          </p>
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="What makes up the wholesale cost">
            <KV k="Mean USEP" v={`${c.usep.avg.toFixed(2)} S$/MWh`} />
            <KV k="Network charges" v={`${c.non_energy.network_c.toFixed(2)} c/kWh`} />
            <KV k="Market support services" v={`${c.non_energy.mss_c.toFixed(2)} c/kWh`} />
            <KV k="Market admin + PSO" v={`${c.non_energy.pso_c.toFixed(2)} c/kWh`} />
            <KV
              k="Non-energy total"
              v={<strong>{c.non_energy.total_c.toFixed(2)} c/kWh</strong>}
            />
            <KV
              k="All-in wholesale"
              v={
                <strong>
                  {(c.usep.avg / 10 + c.non_energy.total_c).toFixed(2)} c/kWh
                </strong>
              }
            />
            <p className="faint small mt-2">
              The three non-energy components come from EMA's published {c.non_energy.quarter} tariff
              breakdown, because a wholesale buyer still pays them. They are the only defensible
              public source for those charges.
            </p>
          </Card>

          <Card title="Price distribution" subtitle="Real USEP percentiles over the window.">
            <KV k="Minimum" v={`${c.usep.min.toFixed(0)} S$/MWh`} />
            <KV k="10th percentile" v={`${c.usep.p10.toFixed(0)} S$/MWh`} />
            <KV k="Median" v={`${c.usep.p50.toFixed(0)} S$/MWh`} />
            <KV k="90th percentile" v={`${c.usep.p90.toFixed(0)} S$/MWh`} />
            <KV k="Maximum" v={`${c.usep.max.toFixed(0)} S$/MWh`} />
          </Card>
        </div>
      </div>

      {quarterly.length > 1 && (
        <Card
          title="Tariff components over time"
          subtitle="Energy is the volatile component; network, MSS and admin fees are reviewed annually and move slowly."
        >
          {(() => {
            const rows = quarterly.flatMap((q) => [
              { key: `${q.quarter} energy`, label: q.quarter, value: q.energy_c ?? 0, color: "var(--chart-1)" },
            ]);
            return (
              <BarChart
                data={rows.map((r) => ({
                  label: r.label.replace("-", " "),
                  value: r.value,
                  color: r.color,
                  meta: [
                    { k: "Quarter", v: r.key },
                    { k: "Energy component", v: `${r.value.toFixed(2)} c/kWh` },
                  ],
                }))}
                height={210}
                format={(v) => v.toFixed(1)}
                valueSuffix=" c/kWh"
              />
            );
          })()}
          <p className="faint small mt-1">
            The energy component per quarter. Its swing is what makes the regulated tariff move, and
            it lags gas prices by roughly 2.5 months by design.
          </p>
        </Card>
      )}

      <Card
        title="Fixed-price quotes"
        subtitle="Business rates are quoted privately, so these are entered by you. Six real published SME rates are seeded as a starting anchor — replace them with your own quotes for a decision-grade comparison."
      >
        {c.fixed_offers.length > 0 ? (
          <div className="tbl-scroll">
<table className="tbl">
            <thead>
              <tr>
                <th>Retailer</th>
                <th>Plan</th>
                <th className="num">Term</th>
                <th className="num">Rate (ex-GST)</th>
                <th className="num">vs tariff</th>
                <th className="num">Annual at your usage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.fixed_offers.map((o) => {
                const delta = o.rate_c_kwh - (data.signal?.tariff_c_kwh ?? 0);
                const annual = profile.mwh * 1000 * (o.rate_c_kwh / 100);
                const regAnnual =
                  profile.mwh * 1000 * ((data.signal?.tariff_c_kwh ?? 0) / 100);
                return (
                  <tr key={`${o.retailer}-${o.plan}-${o.term_months}`}>
                    <td>{o.retailer}</td>
                    <td>{o.plan}</td>
                    <td className="num">{o.term_months ? `${o.term_months}m` : "—"}</td>
                    <td className="num">{o.rate_c_kwh.toFixed(2)}</td>
                    <td
                      className="num"
                      style={{ color: delta < 0 ? "var(--success)" : "var(--danger)", fontWeight: 640 }}
                    >
                      {delta >= 0 ? "+" : "−"}
                      {Math.abs(delta).toFixed(2)}
                    </td>
                    <td className="num">{fmt.sgd(annual)}</td>
                    <td className="num">
                      <span className="faint small">
                        {annual < regAnnual ? `save ${fmt.sgd(regAnnual - annual)}` : `${fmt.sgd(annual - regAnnual)} more`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
</div>
        ) : (
          <Note tone="warn">
            No quotes loaded. Without at least one fixed-price quote the recommendation cannot
            compare a contract against the market, and will fall back to holding on the tariff.
          </Note>
        )}

        {data.offers && data.offers.length > 0 && (
          <details className="mt-2">
            <summary className="small muted" style={{ cursor: "pointer" }}>
              Show provenance notes for loaded quotes
            </summary>
            <div className="stack mt-1" style={{ gap: 8 }}>
              {data.offers.map((o) => (
                <div key={o.id} className="note">
                  <div className="hstack" style={{ justifyContent: "space-between" }}>
                    <strong>
                      {o.retailer} — {o.plan} {o.term_months ? `(${o.term_months}m)` : ""}
                    </strong>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={async () => {
                        await api.deleteOffer(o.id);
                        onChanged();
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="small mt-1">{o.notes || "No notes recorded."}</div>
                  <div className="faint small">Recorded {fmt.sgt(o.observed_at)}</div>
                </div>
              ))}
            </div>
          </details>
        )}

        <h3 className="section-title mt-3">Add a quoted rate</h3>
        {err && (
          <div className="mb-2">
            <Note tone="bad">{err}</Note>
          </div>
        )}
        <div className="row">
          <div className="field">
            <FieldLabel
              htmlFor="of-ret"
              text="Retailer"
              helpTitle="Retailer"
              help={
                <>
                  <p style={{ margin: 0 }}>
                    Which licensed retailer the quote came from. Twelve are licensed for the
                    Open Electricity Market; the full list is on the <em>Data sources</em> tab.
                  </p>
                  <p style={{ margin: "8px 0 0" }}>
                    If an aggregator or broker obtained the quote, name the retailer who will
                    actually supply you — they are the counterparty on the contract.
                  </p>
                </>
              }
            />
            <input
              id="of-ret"
              type="text"
              placeholder="e.g. Senoko Energy Supply"
              value={form.retailer}
              onChange={(e) => setForm({ ...form, retailer: e.target.value })}
            />
          </div>
          <div className="field">
            <FieldLabel
              htmlFor="of-plan"
              text="Plan"
              helpTitle="Plan name"
              help={
                <>
                  <p style={{ margin: 0 }}>
                    The plan name exactly as the retailer quoted it, including the term if it
                    is part of the name — for example <em>PowerPAK 24</em> or{" "}
                    <em>Budget Planner 36</em>.
                  </p>
                  <p style={{ margin: "8px 0 0" }}>
                    Keep it recognisable. A quote is only useful if you can match it back to the
                    fact sheet when you come to sign.
                  </p>
                </>
              }
            />
            <input
              id="of-plan"
              type="text"
              placeholder="e.g. Business Fixed"
              value={form.plan}
              onChange={(e) => setForm({ ...form, plan: e.target.value })}
            />
          </div>
          <div className="field" style={{ maxWidth: 150 }}>
            <FieldLabel
              htmlFor="of-rate"
              text="Rate (c/kWh ex-GST)"
              helpTitle="Rate excluding GST"
              help={
                <>
                  <p style={{ margin: 0 }}>
                    The quoted rate in <em>cents per kilowatt hour</em>, with GST{" "}
                    <strong>removed</strong> so it is directly comparable with the regulated
                    tariff and with wholesale prices, which are both published ex-GST.
                  </p>
                  <p style={{ margin: "8px 0 0" }}>
                    <strong>If your quote includes GST, divide by 1.09.</strong>
                  </p>
                  <div className="helptip-example">
                    <span className="ex-label">Worked example</span>
                    Quoted S$28.20 c/kWh incl. GST → 28.20 ÷ 1.09 ={" "}
                    <strong>25.87</strong> c/kWh. Enter <strong>25.87</strong>.
                  </div>
                  <p style={{ margin: "8px 0 0" }}>
                    <strong>Watch the add-ons.</strong> Some retailers quote a headline rate
                    plus separate charges — a monthly distribution support charge, or a carbon
                    tax per kWh. Enter the headline rate here and record the extras in Notes, so
                    you are comparing like with like rather than silently mixing them.
                  </p>
                  <p style={{ margin: "8px 0 0" }}>
                    Compare the resulting all-in figure against the tariff shown above. Every
                    published SME rate seen during this build sat below the tariff — but a
                    headline rate below the tariff can still cost more once extras land.
                  </p>
                </>
              }
            />
            <input
              id="of-rate"
              type="number"
              step="0.01"
              placeholder="26.50"
              value={form.rate}
              onChange={(e) => setForm({ ...form, rate: e.target.value })}
            />
          </div>
          <div className="field" style={{ maxWidth: 130 }}>
            <FieldLabel
              htmlFor="of-term"
              text="Term"
              helpTitle="Contract term"
              help={
                <>
                  <p style={{ margin: 0 }}>
                    How long the price is fixed for. Standard plans are offered at 6, 12 or 24
                    months, and 36 months is also common for business.
                  </p>
                  <p style={{ margin: "8px 0 0" }}>
                    <strong>The trade-off:</strong> longer terms usually carry a lower rate,
                    because the retailer is spreading its risk — but they lock you in for
                    longer if the market falls. Compare the 12-month and 36-month rates to see
                    what the retailer is charging you for that certainty.
                  </p>
                  <p style={{ margin: "8px 0 0" }}>
                    Always check the early termination charge and the auto-renewal clause before
                    signing. EMA has consulted on tightening auto-renewal practice.
                  </p>
                </>
              }
            />
            <select
              id="of-term"
              value={form.term}
              onChange={(e) => setForm({ ...form, term: e.target.value })}
            >
              <option value="6">6 months</option>
              <option value="12">12 months</option>
              <option value="24">24 months</option>
              <option value="36">36 months</option>
              <option value="">Other</option>
            </select>
          </div>
          <div className="field" style={{ flex: "2 1 220px" }}>
            <FieldLabel
              htmlFor="of-notes"
              text="Notes (source, date, add-ons)"
              helpTitle="Provenance notes"
              help={
                <>
                  <p style={{ margin: 0 }}>
                    Record where the number came from. This is what makes the comparison
                    auditable months later — for you, and for whoever inherits the decision.
                  </p>
                  <p style={{ margin: "8px 0 0" }}>Worth capturing:</p>
                  <ul>
                    <li>
                      <strong>Who quoted it</strong> and when — a rate has a shelf life.
                    </li>
                    <li>
                      <strong>Whether GST was included</strong>, and what you divided by.
                    </li>
                    <li>
                      <strong>Excluded charges</strong>, e.g. a distribution support charge or
                      carbon tax.
                    </li>
                    <li>
                      <strong>Any qualifier</strong> — fuel or FX thresholds that would let the
                      retailer re-price.
                    </li>
                  </ul>
                  <div className="helptip-example">
                    <span className="ex-label">Example</span>
                    "Quoted by email 12 Sep 2026; 29.32 c/kWh incl GST → 26.90 ex-GST; excludes
                    0.21 c/kWh MDSC and 1.972 c/kWh carbon tax."
                  </div>
                </>
              }
            />
            <input
              id="of-notes"
              type="text"
              placeholder="Quoted by email, 12 Sep 2026; excludes 0.21 c/kWh MDSC"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
          <button className="btn" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Add quote"}
          </button>
        </div>
        <p className="faint small mt-1">
          Enter rates <strong>excluding GST</strong> so they are comparable with the tariff and with
          wholesale. Always check the retailer's fact sheet for separate charges — a headline rate can
          sit below the tariff while the all-in cost sits above it.
        </p>
      </Card>
    </div>
  );
}

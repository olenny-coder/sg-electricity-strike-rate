/** Demand Response: what the programme actually pays, priced from real data. */
import { useEffect, useState } from "react";
import { api, type Dashboard, type DrEstimate } from "../api.ts";
import { BarChart, HBarChart, AreaChart } from "../components/charts.tsx";
import { Card, Chip, KV, Note, Tile, fmt } from "../components/ui.tsx";
import { FieldLabel } from "../components/HelpTip.tsx";
import { ProfileControls, type ProfileState } from "../App.tsx";

export function DrView({
  data,
  profile,
  setProfile,
}: {
  data: Dashboard;
  profile: ProfileState;
  setProfile: (p: ProfileState) => void;
}) {
  const [eventHours, setEventHours] = useState(2);
  const [delivery, setDelivery] = useState(1);
  const [lossPerMwh, setLossPerMwh] = useState(0);
  const [override, setOverride] = useState(0);
  const [dr, setDr] = useState<DrEstimate | null>(data.dr ?? null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.dr({
          days: profile.days,
          curtailable_mw: profile.curtailable_mw,
          event_hours: eventHours,
          delivery_rate: delivery,
          production_loss_per_mwh: lossPerMwh,
          incentive_override: override,
        });
        if (!cancelled && !("error" in r)) setDr(r);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [profile.days, profile.curtailable_mw, eventHours, delivery, lossPerMwh, override]);

  const lcpDays = data.daily?.length ?? 0;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <Card
        title="Your site"
        subtitle="Curtailable capacity is the input that matters most here. EMA's minimum is 0.1 MW of load you can drop in about three minutes."
      >
        <ProfileControls profile={profile} setProfile={setProfile} showAlpha={false} />
      </Card>

      <Note tone="warn">
        <strong>Read this before using any number on this page.</strong> Singapore's DR programme
        does <em>not</em> pay you to stand by. It pays an energy incentive only when curtailment is
        actually called: the Load Curtailment Price multiplied by the quantity curtailed, described
        by EMA as one third of the savings created and capped at S$4,500/MWh. Delivering between 80%
        and 100% of a scheduled reduction earns <strong>nothing at all</strong> — there is no
        pro-rata settlement. DR is a marginal credit for most sites, not a procurement strategy.
      </Note>

      {dr && !dr.eligible && (
        <Note tone="bad">{dr.eligibility_note}</Note>
      )}

      {dr && dr.eligible && (
        <>
          <div className="grid g-4">
            <Tile
              label="Real curtailment events"
              value={String(dr.events.periods_with_lcp)}
              note={`settled periods across ${dr.events.event_days} days in this window`}
            />
            <Tile
              label="Observed incentive rate"
              value={dr.incentive.rate_used.toFixed(0)}
              unit="S$/MWh"
              tone={dr.incentive.capped ? "warn" : undefined}
              note={
                dr.incentive.capped
                  ? `Capped at S$${dr.incentive.cap.toLocaleString()}/MWh`
                  : "Real mean LCP where settled"
              }
            />
            <Tile
              label="Trigger level"
              value={dr.trigger.level.toFixed(0)}
              unit="S$/MWh"
              note={
                dr.trigger.source === "mapt"
                  ? `From published cap · ${dr.events.trigger_rate_pct.toFixed(1)}% of periods crossed it`
                  : "98th percentile proxy"
              }
            />
            <Tile
              label="Net annual value (upper bound)"
              value={fmt.sgd(dr.revenue.net_annual_sgd)}
              tone="warn"
              note={`${fmt.sgd(dr.revenue.sgd_per_mw_year)} per MW — assumes you are called every time`}
            />
          </div>

          <Note tone="bad">
            <strong>That revenue figure is an upper bound, not a forecast.</strong> It assumes you
            are scheduled in <em>every</em> period the market settled a curtailment and capture the
            full clearing price each time. In reality you are one participant among many: whether you
            are called depends on your aggregator's bid and on system need, and the clearing price is
            struck against the total quantity offered nationally. A single site captures materially
            less. Use the number to judge whether DR is worth pursuing at all — not to budget from.
          </Note>

          <div className="grid g-23">
            <Card
              title="Where the estimate comes from"
              subtitle="Every rate below is measured from the market feed, not assumed."
            >
              <div className="stack">
                <div>
                  <h3 className="section-title">Activation trigger</h3>
                  <p className="small" style={{ margin: 0, color: "var(--text-secondary)" }}>
                    {dr.trigger.basis}
                  </p>
                </div>

                <div>
                  <h3 className="section-title">Incentive rate</h3>
                  <p className="small" style={{ margin: 0, color: "var(--text-secondary)" }}>
                    {dr.incentive.rate_source}
                  </p>
                  {dr.events.lcp_max > 0 && (
                    <div className="hstack mt-1">
                      <Chip tone="info">observed peak {dr.events.lcp_max.toFixed(0)} S$/MWh</Chip>
                      {Math.abs(dr.events.lcp_max - 4500) < 1 && (
                        <Chip tone="good">cap binding in real data</Chip>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="section-title">The 80% cliff</h3>
                  <p className="small" style={{ margin: 0, color: "var(--text-secondary)" }}>
                    {dr.cliff.note}
                  </p>
                </div>

                <div>
                  <h3 className="section-title">Assumptions in force</h3>
                  <ul className="small" style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
                    {dr.assumptions.map((a, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>

            <div className="stack" style={{ gap: 16 }}>
              <Card title="Revenue build-up">
                <KV k="Committed capacity" v={`${profile.curtailable_mw} MW`} />
                <KV k="Hours per activation" v={`${eventHours} h`} />
                <KV k="MWh curtailed per event" v={`${dr.revenue.mwh_per_event.toFixed(2)} MWh`} />
                <KV k="Annualised events" v={String(dr.events.annualised_events)} />
                <KV
                  k="MWh curtailed per year"
                  v={`${dr.revenue.curtailed_mwh_per_year.toFixed(1)} MWh`}
                />
                <KV k="Gross incentive" v={fmt.sgd(dr.revenue.gross_annual_sgd)} />
                <KV
                  k="Production loss"
                  v={
                    <span style={{ color: dr.revenue.production_loss_sgd > 0 ? "var(--danger)" : undefined }}>
                      −{fmt.sgd(dr.revenue.production_loss_sgd)}
                    </span>
                  }
                />
                <KV k="Net per year" v={<strong>{fmt.sgd(dr.revenue.net_annual_sgd)}</strong>} />
              </Card>

              <Card title="Theoretical ceiling" subtitle="If every stressed period were called.">
                <div className="tile-value" style={{ fontSize: 22 }}>
                  {fmt.sgd(dr.upside.annual_sgd)}
                </div>
                <p className="small muted mt-1" style={{ marginBottom: 0 }}>
                  {dr.upside.note}
                </p>
              </Card>
            </div>
          </div>

          <Card
            title="Adjust the site's own parameters"
            subtitle="These are properties of your operations, not of the market. The market data is fixed."
          >
            <div className="row">
              <div className="field">
                <FieldLabel
                  htmlFor="dr-hours"
                  text={`Hours per activation: ${eventHours}h`}
                  helpTitle="Hours per activation"
                  help={
                    <>
                      <p style={{ margin: 0 }}>
                        How long a single curtailment call lasts. In the market rules an
                        "instance" may run up to <strong>4 hours</strong> (eight half-hour
                        periods); most calls are shorter.
                      </p>
                      <p style={{ margin: "8px 0 0" }}>
                        This sets how much energy each event is worth: committed MW × hours.
                        Halving the duration halves the revenue per event.
                      </p>
                      <div className="helptip-example">
                        <span className="ex-label">Choosing a value</span>
                        2 hours is a reasonable default. Use 4 if your site can sustain a full
                        instance, and a lower figure if your thermal buffer or production
                        schedule would force you to stop early.
                      </div>
                    </>
                  }
                />
                <input
                  id="dr-hours"
                  type="range"
                  min={0.5}
                  max={4}
                  step={0.5}
                  value={eventHours}
                  onChange={(e) => setEventHours(Number(e.target.value))}
                />
                <span className="hint">An instance may run up to 4 hours</span>
              </div>
              <div className="field">
                <FieldLabel
                  htmlFor="dr-del"
                  text={`Delivery rate: ${(delivery * 100).toFixed(0)}%`}
                  helpTitle="Delivery rate"
                  help={
                    <>
                      <p style={{ margin: 0 }}>
                        Of the capacity you committed, how much you actually deliver when
                        called. This is where the programme's sharpest edge sits.
                      </p>
                      <ul>
                        <li>
                          <strong>100%</strong> — you deliver everything you promised. Paid in
                          full, if scheduled.
                        </li>
                        <li>
                          <strong>80–100%</strong> — you are paid <em>nothing at all</em>.
                          There is no pro-rata settlement. The cliff is real: 99% earns the
                          same as 79%.
                        </li>
                        <li>
                          <strong>Below 80%</strong> — a penalty applies, with a floor of
                          S$5,000.
                        </li>
                      </ul>
                      <div className="helptip-example">
                        <span className="ex-label">Be realistic</span>
                        A site that cannot reliably drop its full committed load should reduce
                        the number it registers rather than assume 100%. Committing 1 MW you
                        can always deliver beats committing 2 MW you usually cannot.
                      </div>
                    </>
                  }
                />
                <input
                  id="dr-del"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={delivery}
                  onChange={(e) => setDelivery(Number(e.target.value))}
                />
                <span className="hint">
                  {delivery >= 0.8
                    ? "At or above 80%: paid in full if scheduled"
                    : "Below 80%: penalty applies, floor S$5,000"}
                </span>
              </div>
              <div className="field">
                <FieldLabel
                  htmlFor="dr-loss"
                  text="Production loss (S$/MWh)"
                  helpTitle="Production loss"
                  help={
                    <>
                      <p style={{ margin: 0 }}>
                        What one MWh of curtailment costs you in lost output or spoiled work.
                        Deducted from the incentive.
                      </p>
                      <p style={{ margin: "8px 0 0" }}>
                        <strong>Leave at 0 only if curtailment is genuinely free.</strong> EMA
                        states plainly that growing demand-side capacity is hard precisely
                        because of "the high opportunity costs for some consumers".
                      </p>
                      <div className="helptip-example">
                        <span className="ex-label">How to size it</span>
                        Take the gross margin you would lose per MWh of interrupted production.
                        A cold store drawing on thermal storage has near-zero loss; a
                        continuous process line may lose far more than the DR payment is worth,
                        in which case the honest answer is that this site should not
                        participate.
                      </div>
                    </>
                  }
                />
                <input
                  id="dr-loss"
                  type="number"
                  min={0}
                  step={10}
                  value={lossPerMwh}
                  onChange={(e) => setLossPerMwh(Math.max(0, Number(e.target.value) || 0))}
                />
                <span className="hint">Set this or the result is optimistic</span>
              </div>
              <div className="field">
                <FieldLabel
                  htmlFor="dr-ovr"
                  text="Override incentive (S$/MWh)"
                  helpTitle="Override the incentive rate"
                  help={
                    <>
                      <p style={{ margin: 0 }}>
                        Leave at <strong>0</strong> to use the real observed Load Curtailment
                        Price from the market feed — which is the honest default, because it is
                        measured rather than assumed.
                      </p>
                      <p style={{ margin: "8px 0 0" }}>
                        Set a figure only when you have better information: a rate your
                        aggregator has contractually offered, or a what-if. The published
                        ceiling is <strong>S$4,500/MWh</strong>, and EMA has reported realised
                        outcomes of roughly S$2,400–2,700/MWh — so treat materially higher
                        numbers with suspicion.
                      </p>
                      <p style={{ margin: "8px 0 0" }}>
                        The app caps the rate at S$4,500 and flags when the cap binds.
                      </p>
                    </>
                  }
                />
                <input
                  id="dr-ovr"
                  type="number"
                  min={0}
                  step={50}
                  value={override}
                  onChange={(e) => setOverride(Math.max(0, Number(e.target.value) || 0))}
                />
                <span className="hint">0 = use the real observed rate</span>
              </div>
            </div>
            {loading && <div className="hstack mt-2"><span className="spinner" /> <span className="small muted">recomputing…</span></div>}
          </Card>

          {dr.events.trigger_rate_pct > 0 && (
            <Card
              title="How often the market actually gets expensive enough"
              subtitle={`Real USEP against the DR trigger level over the window. Only ${dr.events.trigger_rate_pct.toFixed(2)}% of half-hour periods reached the trigger, and only ${dr.events.periods_with_lcp} were actually settled for curtailment.`}
            >
              <HBarChart
                rows={[
                  {
                    label: "Periods at or above the trigger",
                    value: dr.events.periods_above_trigger,
                    sub: `${dr.events.trigger_rate_pct.toFixed(2)}% of the window`,
                  },
                  {
                    label: "Periods actually settled for curtailment",
                    value: dr.events.periods_with_lcp,
                    sub: `${dr.events.event_days} distinct days`,
                    highlight: true,
                  },
                ]}
                format={(v) => `${v.toLocaleString()} periods`}
                positiveColor="var(--chart-3)"
              />
              <p className="faint small mt-2">
                The gap between these two bars is the whole risk in DR: a high price is necessary but
                not sufficient, because curtailment is called on system need.
              </p>
            </Card>
          )}
        </>
      )}

      <Card
        title="Interruptible Load is a different programme"
        subtitle="Worth knowing, because the two are frequently conflated."
      >
        <div className="grid g-2">
          <div>
            <h3 className="section-title">Demand Response (modelled above)</h3>
            <KV k="Paid for" v="Energy actually curtailed" />
            <KV k="Basis" v="LCP × quantity curtailed" />
            <KV k="Trigger" v="USEP above ~1.5× CCGT LRMC" />
            <KV k="Cap" v="S$4,500/MWh" />
            <KV k="Minimum" v="0.1 MW, ~3 min response" />
          </div>
          <div>
            <h3 className="section-title">Interruptible Load</h3>
            <KV k="Paid for" v="Standby availability" />
            <KV k="Basis" v="Contingency reserve clearing price" />
            <KV k="On activation" v="No additional payment" />
            <KV k="Introduced" v="2004" />
            <KV k="Note" v="Sandbox conditions discontinued 1 Jan 2025" />
          </div>
        </div>
        <p className="faint small mt-2">
          Registering for both is possible but they compete for the same physical load, so committed
          capacity should not be double-counted.
        </p>
      </Card>
    </div>
  );
}

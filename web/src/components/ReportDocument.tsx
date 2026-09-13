/**
 * Printable recommendation report.
 *
 * WHY A SEPARATE DOCUMENT RATHER THAN PRINTING THE APP
 * ---------------------------------------------------
 * Printing the live UI produces a mess: sticky headers, tabs, tooltips, scroll
 * containers and screen-only copy. This renders a purpose-built document with a
 * cover block, numbered sections, tables that fit a page, and a provenance
 * appendix — so the PDF reads as a report someone can circulate, not as a
 * screenshot of a dashboard.
 *
 * It is hidden on screen (`display: none`) and revealed by the `@media print`
 * rules in styles.css, which simultaneously hide the app shell. The user gets it
 * via the browser's own "Save as PDF", which keeps the text selectable and
 * searchable and adds no dependency to the bundle.
 *
 * Rendering is driven by the same `Dashboard` payload the UI uses, so the report
 * cannot drift from what is on screen.
 */
import type { Dashboard } from "../api.ts";
import { FairValueCard } from "./FairValue.tsx";

const fmtSgd = (n: number, dp = 0) =>
  `S$${n.toLocaleString("en-SG", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const sgt = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-SG", {
        timeZone: "Asia/Singapore",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rp-section">
      <h2 className="rp-h2">
        <span className="rp-num">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Table({
  head,
  rows,
}: {
  head: string[];
  rows: (string | React.ReactNode)[][];
}) {
  return (
    <table className="rp-table">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} className={i === 0 ? "" : "rp-num-col"}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={j === 0 ? "" : "rp-num-col"}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportDocument({ data }: { data: Dashboard }) {
  const s = data.signal;
  const fv = data.fair_value;
  const diag = data.load_diagnostics;
  const shift = data.shift;
  const dr = data.dr;
  const c = s?.comparison;

  const generated = sgt(data.generated_at);
  const windowDays = data.window?.days ?? 0;
  const siteLabel =
    (data.profile?.name && data.profile.name !== "default" ? data.profile.name : null) ??
    "Unnamed site";

  return (
    <div className="report-doc">
      {/* ---------------- Cover ---------------- */}
      <header className="rp-cover">
        <div className="rp-cover-top">
          <div>
            <div className="rp-brand">STRIKE</div>
            <div className="rp-brand-sub">Singapore electricity price advisory</div>
          </div>
          <div className="rp-cover-meta">
            <div>
              <span>Generated</span> {generated} SGT
            </div>
            <div>
              <span>Data window</span> {windowDays} days ·{" "}
              {data.window?.periods.toLocaleString()} half-hour periods
            </div>
            <div>
              <span>Newest data</span> {sgt(data.status.last)}
            </div>
          </div>
        </div>

        <div className="rp-verdict">
          <div className="rp-verdict-label">Recommendation</div>
          <div className="rp-verdict-text">{s?.headline}</div>
          <div className="rp-verdict-meta">
            Lock-in score <strong>{s?.score}</strong> of 100 · {s?.confidence} confidence ·
            benchmark {s?.tariff_quarter} regulated tariff{" "}
            <strong>{s?.tariff_c_kwh.toFixed(2)} c/kWh</strong> ex-GST
          </div>
        </div>

        <div className="rp-site">
          <div className="rp-site-title">Site parameters used</div>
          <div className="rp-site-grid">
            <div>
              <span>Annual consumption</span>
              <strong>{(data.profile?.annual_mwh ?? 0).toLocaleString()} MWh</strong>
            </div>
            <div>
              <span>Load shape (α)</span>
              <strong>{(data.profile?.alpha ?? 0).toFixed(1)}</strong>
            </div>
            <div>
              <span>Curtailable load</span>
              <strong>{(data.profile?.curtailable_mw ?? 0).toFixed(1)} MW</strong>
            </div>
            <div>
              <span>Analysis window</span>
              <strong>{windowDays} days</strong>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------- 1. Recommendation ---------------- */}
      <Section n={1} title="Why this recommendation">
        <ol className="rp-reasons">
          {s?.reasons.map((r, i) => (
            <li key={i} className={`rp-reason rp-reason-${r.direction}`}>
              <div className="rp-reason-text">{r.text}</div>
              <div className="rp-reason-evidence">{r.evidence}</div>
            </li>
          ))}
        </ol>
      </Section>

      {/* ---------------- 2. Fair value ---------------- */}
      {fv && (
        <Section n={2} title="Fair value reference price">
          <FairValueCard fv={fv} print />
        </Section>
      )}

      {/* ---------------- 3. Cost comparison ---------------- */}
      {c && (
        <Section n={3} title="Cost of this consumption under each route">
          <p className="rp-lead">
            Identical modelled consumption of {c.window.mwh.toLocaleString()} MWh over{" "}
            {c.window.days} days, priced with real half-hourly wholesale prices, the real
            published regulated tariff, and any fixed-price quotes loaded. All figures exclude
            GST.
          </p>
          <Table
            head={["Route", "Effective price (c/kWh)", "Cost over window", "vs regulated tariff"]}
            rows={c.scenarios.map((sc) => [
              sc.label,
              sc.effective_c_kwh.toFixed(2),
              fmtSgd(sc.total_sgd),
              sc.id === "regulated"
                ? "baseline"
                : `${sc.delta_vs_tariff_sgd >= 0 ? "+" : "−"}${fmtSgd(Math.abs(sc.delta_vs_tariff_sgd))} (${sc.delta_vs_tariff_pct >= 0 ? "+" : ""}${sc.delta_vs_tariff_pct.toFixed(1)}%)`,
            ])}
          />
          <p className="rp-note">
            A window is a snapshot, not a forecast. A fixed contract locks a price for years,
            whereas this comparison prices the recent past.
          </p>
        </Section>
      )}

      {/* ---------------- 4. Market context ---------------- */}
      {c && (
        <Section n={4} title="Market context">
          <div className="rp-two-col">
            <div>
              <h3 className="rp-h3">Real wholesale prices</h3>
              <Table
                head={["Statistic", "S$/MWh"]}
                rows={[
                  ["Mean", c.usep.avg.toFixed(2)],
                  ["Minimum", c.usep.min.toFixed(2)],
                  ["10th percentile", c.usep.p10.toFixed(2)],
                  ["Median", c.usep.p50.toFixed(2)],
                  ["90th percentile", c.usep.p90.toFixed(2)],
                  ["Maximum", c.usep.max.toFixed(2)],
                  ["Volatility (sd ÷ mean)", `${c.usep.volatility_pct.toFixed(1)}%`],
                ]}
              />
            </div>
            <div>
              <h3 className="rp-h3">Peak versus off-peak</h3>
              <Table
                head={["Period", "Mean S$/MWh"]}
                rows={[
                  ["Peak (weekdays 08:00–19:59)", data.peak_off_peak?.peak_avg.toFixed(2) ?? "—"],
                  ["Off-peak", data.peak_off_peak?.offpeak_avg.toFixed(2) ?? "—"],
                  ["Spread", `${data.peak_off_peak?.spread.toFixed(2) ?? "—"} (${data.peak_off_peak?.spread_pct.toFixed(1) ?? "—"}%)`],
                ]}
              />
              {data.peak_off_peak && data.peak_off_peak.spread < 0 && (
                <p className="rp-note">
                  Off-peak is currently more expensive than peak. Daytime solar suppresses
                  midday prices, so the conventional overnight-shift assumption does not hold.
                </p>
              )}
            </div>
          </div>
          {s?.forward_view && (
            <p className="rp-lead">
              Forward view over the next {s.forward_view.horizon_hours} hours:{" "}
              <strong>{s.forward_view.direction}</strong>, forecast average{" "}
              {s.forward_view.forecast_avg.toFixed(0)} S$/MWh against a recent realised average
              of {s.forward_view.recent_avg.toFixed(0)}. Backtest error{" "}
              {s.forward_view.backtest_mape_pct}% MAPE; the model beats a naive
              same-half-hour-yesterday benchmark by {s.forward_view.backtest_skill_pct}%. Treat
              direction as more reliable than level.
            </p>
          )}
        </Section>
      )}

      {/* ---------------- 5. Load shifting ---------------- */}
      {shift && shift.shifted_mwh > 0 && (
        <Section n={5} title="Load shifting opportunity">
          <Table
            head={["Measure", "Value"]}
            rows={[
              ["Energy shifted", `${shift.shifted_mwh.toFixed(1)} MWh`],
              ["Average price moved out of", `${shift.from_avg_price.toFixed(0)} S$/MWh`],
              ["Average price moved into", `${shift.to_avg_price.toFixed(0)} S$/MWh`],
              ["Captured spread", `${shift.captured_spread.toFixed(2)} S$/MWh`],
              ["Saving over the window", fmtSgd(shift.saving_sgd)],
              ["Half-hours reduced / increased", `${shift.shed_periods} / ${shift.absorb_periods}`],
            ]}
          />
          <p className="rp-note">{shift.explanation}</p>
        </Section>
      )}

      {/* ---------------- 6. Demand response ---------------- */}
      {dr && (
        <Section n={6} title="Demand response">
          {!dr.eligible ? (
            <p className="rp-note">{dr.eligibility_note}</p>
          ) : (
            <>
              <Table
                head={["Measure", "Value"]}
                rows={[
                  ["Activation trigger (from published cap)", `${dr.trigger.level.toFixed(0)} S$/MWh`],
                  ["Half-hours above trigger", `${dr.events.periods_above_trigger} of the window (${dr.events.trigger_rate_pct.toFixed(2)}%)`],
                  ["Settled curtailment periods observed", `${dr.events.periods_with_lcp} across ${dr.events.event_days} days`],
                  ["Observed incentive rate (LCP)", `${dr.incentive.rate_used.toFixed(2)} S$/MWh`],
                  ["Observed maximum LCP", `${dr.events.lcp_max.toFixed(2)} S$/MWh`],
                  ["Net annual value (upper bound)", fmtSgd(dr.revenue.net_annual_sgd)],
                ]}
              />
              <p className="rp-note rp-note-strong">
                This is an upper bound, not a forecast. It assumes the site is scheduled in
                every period the market settled a curtailment and captures the full clearing
                price each time. In practice you are one participant among many. Note also that
                delivering between 80% and 100% of a scheduled reduction earns nothing at all —
                there is no pro-rata settlement.
              </p>
            </>
          )}
        </Section>
      )}

      {/* ---------------- 7. Derived parameters ---------------- */}
      {diag && (
        <Section n={7} title="Modelled load profile">
          <Table
            head={["Derived measure", "Value"]}
            rows={[
              ["Modelled peak demand", `${diag.peak_mw.toFixed(2)} MW`],
              ["Modelled minimum demand", `${diag.min_mw.toFixed(2)} MW`],
              ["Modelled average demand", `${diag.avg_mw.toFixed(2)} MW`],
              ["Load factor", `${(diag.load_factor * 100).toFixed(0)}%`],
              ["Energy in the peak window", `${(diag.peak_window_share * 100).toFixed(0)}%`],
              ["Data coverage of the window", `${(diag.coverage * 100).toFixed(0)}%`],
            ]}
          />
          <p className="rp-note">
            Consumption shape is modelled as a scaled power of the real national demand profile:
            L(t) = k · D(t)<sup>α</sup>, scaled so the window total matches the stated annual
            consumption. The timing of peaks and troughs is therefore real market data; only the
            amplitude of the site's response to that shape is assumed. Check the load factor above
            against your own bills — if it does not match, adjust α.
          </p>
        </Section>
      )}

      {/* ---------------- 8. Provenance ---------------- */}
      <Section n={8} title="Data provenance">
        <Table
          head={["Source", "Provides", "Access", "Latest publisher stamp"]}
          rows={[
            [
              "EMC — NEMS RT48 feed",
              "Half-hourly USEP, demand, solar, ancillary prices, LCP and TPC parameters",
              "Open, unauthenticated",
              data.status.emc_last_updated ?? "—",
            ],
            [
              "EMA — regulated tariff",
              "Quarterly tariff and its four cost components",
              "Open CSV asset",
              data.tariff?.fetched_at ? sgt(data.tariff.fetched_at) : "—",
            ],
            [
              "Retailer websites",
              "Published SME fixed-price rates (anchor only)",
              "Public pages",
              "Manually recorded",
            ],
          ]}
        />
        <p className="rp-note">
          Stored: {data.status.count.toLocaleString()} half-hour periods spanning{" "}
          {data.status.span_days.toFixed(0)} days, from {sgt(data.status.first)} to{" "}
          {sgt(data.status.last)}. Every row carries its source and observation timestamp. The
          newest day of market data is provisional: EMC revises it, so today's price is
          indicative rather than final.
        </p>
      </Section>

      {/* ---------------- Disclaimer ---------------- */}
      <footer className="rp-footer">
        <h3 className="rp-h3">Basis of preparation and limitations</h3>
        <ul className="rp-disclaimer">
          <li>
            All prices are real published data, ingested directly from the Energy Market Company
            and the Energy Market Authority. Nothing is synthesised. Where a value is modelled,
            the assumption is stated alongside it.
          </li>
          <li>
            The site's load shape is modelled, not metered. A half-hourly meter import would
            supersede it.
          </li>
          <li>
            Demand response revenue is an upper bound and assumes scheduling in every settled
            curtailment period.
          </li>
          <li>
            The demand response incentive cap of S$4,500/MWh dates from October 2024. It is
            corroborated by real settlement data, but confirm current terms with EMA or your
            aggregator.
          </li>
          <li>
            Fixed-price quotes may be seeded from publicly published SME rates, which are not
            quotes for a large industrial site. Verify every rate against the retailer's own fact
            sheet, including charges quoted separately from the headline rate.
          </li>
          <li>
            This report is analysis, not financial advice. It does not constitute a
            recommendation to enter any contract.
          </li>
        </ul>
        <div className="rp-footer-line">
          Strike · generated {generated} SGT · {siteLabel}
        </div>
      </footer>
    </div>
  );
}

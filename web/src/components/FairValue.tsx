/**
 * Fair value reference card.
 *
 * Presentational only, so the same component renders both on screen and inside
 * the printable report. It takes a plain `FairValueReference` and draws:
 *
 *   - the all-in reference price,
 *   - a scale placing it between the two anchors and against what the market
 *     is actually charging, and
 *   - the derivation of each anchor, so the number is auditable.
 */
import type { FairValueReference } from "../api.ts";
import { Chip } from "./ui.tsx";

const VERDICT_LABEL: Record<"below" | "at" | "above", string> = {
  below: "below fair value",
  at: "around fair value",
  above: "above fair value",
};

function verdictTone(v: "below" | "at" | "above") {
  return v === "below" ? "good" : v === "above" ? "warn" : "info";
}

/**
 * Horizontal scale. The reference band is drawn as a rounded segment, with the
 * reference itself as a solid marker and each market price as a labelled pin.
 * A shared axis makes the comparison honest: all values are plotted on the same
 * scale, so a 15% gap looks like a 15% gap.
 */
function FairValueScale({ fv, print }: { fv: FairValueReference; print?: boolean }) {
  const values = [
    fv.energy_low_c,
    fv.energy_high_c,
    fv.market.wholesale_all_in_c,
    fv.market.regulated_all_in_c,
    fv.all_in_reference_c,
    ...fv.inputs.map((i) => i.value_c),
  ];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.12 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const pos = (v: number) => ((v - min) / (max - min)) * 100;

  const bandLeft = pos(fv.energy_low_c);
  const bandRight = pos(fv.energy_high_c);

  const marks = [
    {
      v: fv.all_in_reference_c,
      label: `Fair value ${fv.all_in_reference_c.toFixed(2)}`,
      color: "var(--primary)",
      strong: true,
    },
    {
      v: fv.market.wholesale_all_in_c,
      label: `Wholesale ${fv.market.wholesale_all_in_c.toFixed(2)}`,
      color: "var(--accent)",
      strong: false,
    },
    {
      v: fv.market.regulated_all_in_c,
      label: `Tariff ${fv.market.regulated_all_in_c.toFixed(2)}`,
      color: "var(--chart-8)",
      strong: false,
    },
  ];

  return (
    <div className="fv-scale">
      <div className="fv-track">
        {/* The all-in reference band: energy anchors shifted by the additive
            non-energy charges, which every route pays. */}
        <div
          className="fv-band"
          style={{
            left: `${bandLeft}%`,
            width: `${Math.max(1.5, bandRight - bandLeft)}%`,
          }}
          title="Energy-only anchor band, before non-energy charges"
        />
        {marks.map((m, i) => (
          <div
            key={i}
            className={`fv-mark ${m.strong ? "strong" : ""}`}
            style={{ left: `${pos(m.v)}%`, background: m.color }}
          />
        ))}
      </div>
      <div className="fv-labels">
        {marks.map((m, i) => (
          <span key={i} className="fv-label" style={{ left: `${pos(m.v)}%` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="fv-axis">
        <span>{min.toFixed(0)}</span>
        <span className="fv-axis-cap">
          cents per kWh, all-in{fv.non_energy_c ? ` (incl. ${fv.non_energy_c.toFixed(2)} non-energy)` : ""}
        </span>
        <span>{max.toFixed(0)}</span>
      </div>
      {!print && <span className="sr-only">Fair value scale chart</span>}
    </div>
  );
}

export function FairValueCard({
  fv,
  print = false,
}: {
  fv: FairValueReference;
  /** Print mode drops interactive chrome and uses plainer copy. */
  print?: boolean;
}) {
  return (
    <div className="fv-card">
      <div className="fv-head">
        <div>
          <div className="fv-eyebrow">Fair value reference</div>
          <div className="fv-value">
            {fv.all_in_reference_c.toFixed(2)}
            <span className="fv-unit">cents/kWh all-in, ex-GST</span>
          </div>
          <div className="fv-sub">
            Energy reference {fv.energy_reference_c.toFixed(2)} c/kWh +{" "}
            {fv.non_energy_c.toFixed(2)} c/kWh of network, MSS and market fees.
          </div>
        </div>
        <div className="fv-verdicts">
          <Chip tone={verdictTone(fv.market.wholesale_verdict)}>
            Wholesale {VERDICT_LABEL[fv.market.wholesale_verdict]} (
            {fv.market.wholesale_premium_pct >= 0 ? "+" : ""}
            {fv.market.wholesale_premium_pct.toFixed(1)}%)
          </Chip>
          <Chip tone={verdictTone(fv.market.regulated_verdict)}>
            Tariff {VERDICT_LABEL[fv.market.regulated_verdict]} (
            {fv.market.regulated_premium_pct >= 0 ? "+" : ""}
            {fv.market.regulated_premium_pct.toFixed(1)}%)
          </Chip>
        </div>
      </div>

      <FairValueScale fv={fv} print={print} />

      <p className="fv-interpretation">{fv.interpretation}</p>

      <div className="fv-anchors">
        <div className="fv-anchors-title">
          Derivation — {fv.inputs.length} independent{" "}
          {fv.inputs.length === 1 ? "anchor" : "anchors"}
        </div>
        {fv.inputs.map((i, idx) => (
          <div key={idx} className="fv-anchor">
            <div className="fv-anchor-head">
              <strong>{i.label}</strong>
              <span className="mono">{i.value_c.toFixed(2)} c/kWh</span>
            </div>
            <p className="fv-anchor-basis">{i.basis}</p>
          </div>
        ))}
        <p className="fv-corroboration">{fv.corroboration}</p>
      </div>

      <details className="fv-caveats">
        <summary>What this is not</summary>
        <ul>
          {fv.caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

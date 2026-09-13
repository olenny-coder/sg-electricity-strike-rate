/**
 * Chart primitives.
 *
 * Hand-built SVG rather than a charting library, for two reasons: the bar
 * rounding is a specific design requirement that generic libraries fight you
 * on, and this keeps the client bundle dependency-free.
 *
 * THEME HANDLING: colours are applied through inline `style` rather than SVG
 * presentation attributes. An attribute like fill="#0077B6" cannot hold a CSS
 * custom property, but `style={{ fill: "var(--chart-1)" }}` can — so every
 * chart recolours instantly on theme switch with no re-render.
 *
 * Each chart measures its container and renders at true pixel size, so text
 * stays crisp instead of being scaled by a viewBox.
 */
import { useEffect, useMemo, useRef, useState } from "react";

/** Chart series palette, mirroring the design tokens. */
export const SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
] as const;

/**
 * Cheap-to-expensive colour for a value's rank within its own range.
 * Uses color-mix so it tracks the active theme instead of baking in RGB.
 */
export function priceColor(rank: number): string {
  const t = Math.min(1, Math.max(0, rank));
  return `color-mix(in oklab, var(--success) ${Math.round((1 - t) * 100)}%, var(--danger))`;
}

/** Observe an element's width so SVG can render at real pixel dimensions. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.round(e.contentRect.width);
        if (w > 0) setWidth(w);
      }
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width) || 720);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

interface Tip {
  x: number;
  y: number;
  content: { k: string; v: string }[];
  title: string;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  const left = Math.min(Math.max(8, tip.x + 14), window.innerWidth - 250);
  const top = Math.max(8, tip.y - 12);
  return (
    <div className="tooltip" style={{ left, top }} role="tooltip">
      <div style={{ fontWeight: 650, marginBottom: 3 }}>{tip.title}</div>
      {tip.content.map((c, i) => (
        <div key={i}>
          {c.k}: <b>{c.v}</b>
        </div>
      ))}
    </div>
  );
}

export interface Bar {
  label: string;
  value: number;
  /** Optional per-bar colour, e.g. a rank colour. */
  color?: string;
  meta?: { k: string; v: string }[];
}

/**
 * Vertical bar chart with rounded bars.
 * `rx` defaults to 6px so bars read as rounded tiles rather than rectangles.
 */
export function BarChart({
  data,
  height = 220,
  rx = 6,
  color = SERIES[0],
  format = (v: number) => v.toFixed(0),
  yTicks = 4,
  valueSuffix = "",
  labelEvery,
  compactLabels = false,
}: {
  data: Bar[];
  height?: number;
  rx?: number;
  color?: string;
  format?: (v: number) => string;
  yTicks?: number;
  valueSuffix?: string;
  labelEvery?: number;
  compactLabels?: boolean;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const gradId = useMemo(() => `bg-${Math.random().toString(36).slice(2, 9)}`, []);

  const padL = compactLabels ? 44 : 52;
  const padR = 8;
  const padT = 10;
  const padB = 28;
  const innerW = Math.max(10, width - padL - padR);
  const innerH = Math.max(10, height - padT - padB);

  if (!data.length) {
    return <div className="muted small" style={{ padding: 20 }}>No data in this window.</div>;
  }

  const values = data.map((d) => d.value);
  const maxV = Math.max(0, ...values);
  const minV = Math.min(0, ...values);
  const span = maxV - minV || 1;
  const niceMax = maxV + span * 0.08;
  const niceMin = minV < 0 ? minV - span * 0.08 : 0;
  const range = niceMax - niceMin || 1;

  const n = data.length;
  const slot = innerW / n;
  const barW = Math.max(2, Math.min(slot * 0.68, 44));

  const yOf = (v: number) => padT + innerH - ((v - niceMin) / range) * innerH;
  const zeroY = yOf(0);
  const step = labelEvery ?? Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 64))));

  return (
    <div ref={ref} className="chart-wrap">
      <svg className="chart-svg" width={width} height={height} role="img" aria-label="Bar chart">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.62 }} />
            <stop offset="100%" style={{ stopColor: color, stopOpacity: 1 }} />
          </linearGradient>
        </defs>

        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const v = niceMin + (range * i) / yTicks;
          const y = yOf(v);
          return (
            <g key={i}>
              <line className="chart-grid" x1={padL} x2={padL + innerW} y1={y} y2={y} />
              <text className="chart-axis" x={padL - 7} y={y + 3.5} textAnchor="end">
                {format(v)}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const x = padL + i * slot + (slot - barW) / 2;
          const y = yOf(Math.max(d.value, 0));
          const h = Math.abs(yOf(d.value) - zeroY);
          const top = d.value >= 0 ? y : zeroY;
          const r = Math.min(rx, h / 2, barW / 2);
          return (
            <rect
              key={i}
              className="chart-bar"
              x={x}
              y={top}
              width={barW}
              height={Math.max(1, h)}
              rx={r}
              ry={r}
              style={{ fill: d.color ?? `url(#${gradId})` }}
              onMouseMove={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  title: d.label,
                  content: [
                    { k: "Value", v: `${format(d.value)}${valueSuffix}` },
                    ...(d.meta ?? []),
                  ],
                })
              }
              onMouseLeave={() => setTip(null)}
            />
          );
        })}

        {data.map((d, i) =>
          i % step === 0 ? (
            <text
              key={i}
              className="chart-axis"
              x={padL + i * slot + slot / 2}
              y={height - 9}
              textAnchor="middle"
            >
              {d.label}
            </text>
          ) : null
        )}

        <line
          x1={padL}
          x2={padL + innerW}
          y1={zeroY}
          y2={zeroY}
          style={{ stroke: "var(--border-strong)" }}
          strokeWidth={1}
        />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/**
 * Area + line chart for continuous series such as half-hourly price or a
 * forecast. Negative values are supported, which matters because USEP can and
 * does go negative during oversupply.
 */
export function AreaChart({
  points,
  height = 210,
  color = SERIES[0],
  format = (v: number) => v.toFixed(0),
  yTicks = 4,
  labelEvery,
  markers,
}: {
  points: { label: string; value: number; meta?: { k: string; v: string }[] }[];
  height?: number;
  color?: string;
  format?: (v: number) => string;
  yTicks?: number;
  labelEvery?: number;
  markers?: { value: number; label: string; color: string; dashed?: boolean }[];
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const gradId = useMemo(() => `ag-${Math.random().toString(36).slice(2, 9)}`, []);

  const padL = 52;
  const padR = 10;
  const padT = 10;
  const padB = 26;
  const innerW = Math.max(10, width - padL - padR);
  const innerH = Math.max(10, height - padT - padB);

  if (points.length < 2) {
    return <div className="muted small" style={{ padding: 20 }}>Not enough points to plot.</div>;
  }

  const vals = points.map((p) => p.value);
  const maxV = Math.max(...vals, ...(markers?.map((m) => m.value) ?? []));
  const minV = Math.min(...vals, 0, ...(markers?.map((m) => m.value) ?? []));
  const span = maxV - minV || 1;
  const niceMax = maxV + span * 0.07;
  const niceMin = minV - span * 0.07;
  const range = niceMax - niceMin || 1;

  const xOf = (i: number) => padL + (i / (points.length - 1)) * innerW;
  const yOf = (v: number) => padT + innerH - ((v - niceMin) / range) * innerH;

  const line = points.map((p, i) => `${i ? "L" : "M"}${xOf(i)},${yOf(p.value)}`).join(" ");
  const area = `${line} L${xOf(points.length - 1)},${yOf(niceMin)} L${xOf(0)},${yOf(niceMin)} Z`;
  const step = labelEvery ?? Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 70))));

  return (
    <div ref={ref} className="chart-wrap">
      <svg className="chart-svg" width={width} height={height} role="img" aria-label="Area chart">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.32 }} />
            <stop offset="100%" style={{ stopColor: color, stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>

        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const v = niceMin + (range * i) / yTicks;
          const y = yOf(v);
          return (
            <g key={i}>
              <line className="chart-grid" x1={padL} x2={padL + innerW} y1={y} y2={y} />
              <text className="chart-axis" x={padL - 7} y={y + 3.5} textAnchor="end">
                {format(v)}
              </text>
            </g>
          );
        })}

        <path d={area} style={{ fill: `url(#${gradId})` }} />
        <path
          d={line}
          fill="none"
          style={{ stroke: color }}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {markers?.map((m, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={padL + innerW}
              y1={yOf(m.value)}
              y2={yOf(m.value)}
              style={{ stroke: m.color }}
              strokeWidth={1.4}
              strokeDasharray={m.dashed === false ? undefined : "5 4"}
            />
            <text
              className="chart-axis"
              x={padL + innerW}
              y={yOf(m.value) - 5}
              textAnchor="end"
              style={{ fill: m.color }}
            >
              {m.label}
            </text>
          </g>
        ))}

        {points.map((p, i) =>
          i % step === 0 ? (
            <text key={i} className="chart-axis" x={xOf(i)} y={height - 8} textAnchor="middle">
              {p.label}
            </text>
          ) : null
        )}

        {points.map((p, i) => (
          <rect
            key={`h${i}`}
            x={xOf(i) - innerW / points.length / 2}
            y={padT}
            width={Math.max(2, innerW / points.length)}
            height={innerH}
            fill="transparent"
            onMouseMove={(e) =>
              setTip({
                x: e.clientX,
                y: e.clientY,
                title: p.label,
                content: [{ k: "Value", v: format(p.value) }, ...(p.meta ?? [])],
              })
            }
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/**
 * Horizontal rounded bars — used for cost comparisons and for ranking periods.
 * A negative value renders in the "good" colour, because in every use here a
 * negative number means a saving.
 */
export function HBarChart({
  rows,
  format = (v: number) => v.toFixed(2),
  positiveColor = SERIES[0],
  negativeColor = "var(--success)",
  height,
}: {
  rows: { label: string; value: number; sub?: string; highlight?: boolean }[];
  format?: (v: number) => string;
  positiveColor?: string;
  negativeColor?: string;
  height?: number;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value)), 0.0001);

  return (
    <div className="stack" style={{ gap: 9, position: "relative", minHeight: height }}>
      {rows.map((r, i) => {
        const pct = (Math.abs(r.value) / maxAbs) * 100;
        const neg = r.value < 0;
        return (
          <div key={i}>
            <div className="hstack" style={{ justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: r.highlight ? 680 : 560,
                  color: r.highlight ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {r.label}
              </span>
              <span
                className="mono nowrap"
                style={{
                  fontWeight: 650,
                  fontSize: 12.5,
                  color: neg ? "var(--success)" : "var(--text-primary)",
                }}
              >
                {format(r.value)}
              </span>
            </div>
            <div
              style={{
                height: 12,
                borderRadius: 999,
                background: "var(--surface-sunken)",
                overflow: "hidden",
              }}
            >
              <div
                onMouseMove={(e) =>
                  setTip({
                    x: e.clientX,
                    y: e.clientY,
                    title: r.label,
                    content: [
                      { k: "Value", v: format(r.value) },
                      ...(r.sub ? [{ k: "Note", v: r.sub }] : []),
                    ],
                  })
                }
                onMouseLeave={() => setTip(null)}
                style={{
                  width: `${Math.max(1.5, pct)}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: neg
                    ? `linear-gradient(90deg, ${negativeColor}, color-mix(in oklab, ${negativeColor} 55%, var(--surface)))`
                    : `linear-gradient(90deg, ${positiveColor}, color-mix(in oklab, ${positiveColor} 55%, var(--surface)))`,
                  transition: "width 0.35s cubic-bezier(.2,.7,.3,1)",
                }}
              />
            </div>
            {r.sub ? (
              <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>
                {r.sub}
              </div>
            ) : null}
          </div>
        );
      })}
      <Tooltip tip={tip} />
    </div>
  );
}

/** Small inline sparkline for stat tiles. */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = SERIES[0],
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }} aria-hidden="true">
      <path
        d={d}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export { useWidth };

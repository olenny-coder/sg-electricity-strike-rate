/** Small presentational primitives shared across views. */
import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  right,
  children,
  pad = true,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  pad?: boolean;
  className?: string;
}) {
  return (
    <section className={`card ${pad ? "" : "pad-0"} ${className}`}>
      {(title || right) && (
        <header className="card-head" style={pad ? undefined : { padding: "20px 20px 0" }}>
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Tile({
  label,
  value,
  unit,
  note,
  tone,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  tone?: "good" | "warn" | "bad";
  children?: ReactNode;
}) {
  return (
    <div className={`tile ${tone ? `tone-${tone}` : ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {value}
        {unit && <span className="tile-unit">{unit}</span>}
      </div>
      {note && <div className="tile-note">{note}</div>}
      {children}
    </div>
  );
}

export function Chip({
  tone = "neutral",
  children,
  dot,
}: {
  tone?: "good" | "warn" | "bad" | "info" | "neutral";
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`chip chip-${tone}`}>
      {dot && (
        <span
          className={`dot dot-${
            tone === "good" ? "good" : tone === "bad" ? "bad" : "warn"
          }`}
        />
      )}
      {children}
    </span>
  );
}

export function Note({
  tone,
  children,
}: {
  tone?: "warn" | "bad" | "good" | "info";
  children: ReactNode;
}) {
  return <div className={`note ${tone ?? ""}`}>{children}</div>;
}

export function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

export function Empty({
  title,
  children,
  icon = "◆",
}: {
  title: string;
  children?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        <span style={{ fontSize: 20 }}>{icon}</span>
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="empty">
      <div style={{ marginBottom: 12 }}>
        <span className="spinner" />
      </div>
      <p>{label}…</p>
    </div>
  );
}

/** Formatting helpers kept in one place so units stay consistent. */
export const fmt = {
  sgd: (n: number, dp = 0) =>
    `S$${n.toLocaleString("en-SG", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`,
  num: (n: number, dp = 2) =>
    n.toLocaleString("en-SG", { minimumFractionDigits: dp, maximumFractionDigits: dp }),
  c: (n: number) => `${n.toFixed(2)} c/kWh`,
  /** SGD/MWh from the feed -> cents/kWh, the unit bills are actually in. */
  mwhToC: (n: number) => n / 10,
  pct: (n: number, dp = 1) => `${n >= 0 ? "" : ""}${n.toFixed(dp)}%`,
  sgt: (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString("en-SG", {
          timeZone: "Asia/Singapore",
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—",
  sgtShort: (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString("en-SG", {
          timeZone: "Asia/Singapore",
          day: "2-digit",
          month: "short",
        })
      : "—",
  date: (iso: string | null) => (iso ? iso.slice(0, 10) : "—"),
  rel: (hours: number | null) => {
    if (hours === null) return "never";
    if (hours < 1) return `${Math.round(hours * 60)} min ago`;
    if (hours < 48) return `${hours.toFixed(1)} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  },
};

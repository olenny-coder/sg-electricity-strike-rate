/**
 * Strike — application shell.
 *
 * Owns the buyer profile (consumption, load shape, curtailable capacity), the
 * analytics window, and the theme, because every view is a different lens on the
 * same real dataset rather than an independent page.
 *
 * Navigation adapts to width: an inline tab bar on desktop, a hamburger drawer
 * below 900px. The drawer is rendered only when open, traps Escape, and locks
 * background scrolling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Dashboard } from "./api.ts";
import { Chip, Loading, Note, fmt } from "./components/ui.tsx";
import { FieldLabel } from "./components/HelpTip.tsx";
import { ReportDocument } from "./components/ReportDocument.tsx";
import { useTheme, type ThemePref } from "./theme.ts";
import { StrikeView } from "./views/Strike.tsx";
import { MarketView } from "./views/Market.tsx";
import { CompareView } from "./views/Compare.tsx";
import { ShiftView } from "./views/Shift.tsx";
import { DrView } from "./views/Dr.tsx";
import { SourcesView } from "./views/Sources.tsx";

type TabId = "strike" | "market" | "compare" | "shift" | "dr" | "sources";

const TABS: { id: TabId; label: string; blurb: string }[] = [
  { id: "strike", label: "Recommendation", blurb: "Should you lock, float or hold?" },
  { id: "market", label: "Market prices", blurb: "Real USEP, demand and tariff history" },
  { id: "compare", label: "Compare options", blurb: "Tariff vs wholesale vs your quotes" },
  { id: "shift", label: "Load shifting", blurb: "Move load to cheaper half hours" },
  { id: "dr", label: "Demand response", blurb: "What curtailment actually pays" },
  { id: "sources", label: "Data sources", blurb: "Provenance and freshness" },
];

export interface ProfileState {
  days: number;
  mwh: number;
  alpha: number;
  curtailable_mw: number;
}

const DEFAULT_PROFILE: ProfileState = {
  days: 90,
  mwh: 4000,
  alpha: 1.4,
  curtailable_mw: 1,
};

function loadProfileFromStorage(): ProfileState {
  try {
    const raw = localStorage.getItem("strike.profile");
    if (!raw) return DEFAULT_PROFILE;
    const p = JSON.parse(raw);
    return {
      days: Number(p.days) || DEFAULT_PROFILE.days,
      mwh: Number(p.mwh) || DEFAULT_PROFILE.mwh,
      alpha: Number.isFinite(Number(p.alpha)) ? Number(p.alpha) : DEFAULT_PROFILE.alpha,
      curtailable_mw: Number.isFinite(Number(p.curtailable_mw))
        ? Number(p.curtailable_mw)
        : DEFAULT_PROFILE.curtailable_mw,
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

/* ------------------------------------------------------------------ */
/* Icons (inline so the client stays dependency-free)                  */
/* ------------------------------------------------------------------ */

const IconBolt = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
);

const IconMenu = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const IconClose = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const IconSun = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="4.2" fill="currentColor" />
    <path
      d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
  </svg>
);

const IconMoon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

const IconAuto = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 3.4a8.6 8.6 0 0 1 0 17.2Z" fill="currentColor" />
  </svg>
);

function ThemeButton({
  pref,
  onCycle,
}: {
  pref: ThemePref;
  onCycle: () => void;
}) {
  const label =
    pref === "light" ? "Light theme" : pref === "dark" ? "Dark theme" : "System theme";
  return (
    <button
      className="icon-btn"
      onClick={onCycle}
      title={`${label} — click to change`}
      aria-label={`Theme: ${label}. Activate to change theme.`}
    >
      {pref === "light" ? <IconSun /> : pref === "dark" ? <IconMoon /> : <IconAuto />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [tab, setTab] = useState<TabId>("strike");
  const [profile, setProfile] = useState<ProfileState>(loadProfileFromStorage);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const { pref, cycle } = useTheme();
  const reqId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++reqId.current;
    setBusy(true);
    try {
      const d = await api.dashboard(profile);
      // Ignore responses from superseded requests so rapid changes cannot
      // render a stale result on top of a newer one.
      if (id === reqId.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }, [profile]);

  useEffect(() => {
    const t = setTimeout(refresh, 180);
    try {
      localStorage.setItem("strike.profile", JSON.stringify(profile));
    } catch {
      /* storage disabled */
    }
    return () => clearTimeout(t);
  }, [refresh, profile, tab]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Close the drawer on Escape, and lock background scroll while it is open.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [navOpen]);

  const go = useCallback((id: TabId) => {
    setTab(id);
    setNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const runSync = useCallback(
    async (kind: "market" | "tariff") => {
      setSyncing(kind);
      try {
        if (kind === "market") {
          const r = (await api.syncMarket({ days: 30 })) as any;
          setToast(
            `Market data refreshed: ${r?.sync?.periodsStored ?? 0} half-hour periods stored.`
          );
        } else {
          await api.syncTariff(12);
          setToast("Regulated tariff refreshed from EMA.");
        }
        await refresh();
      } catch (e) {
        setToast(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSyncing(null);
      }
    },
    [refresh]
  );

  const status = data?.status;
  const fresh = status && !status.stale && status.count > 0;

  const statusChip = useMemo(
    () =>
      status ? (
        <Chip tone={fresh ? "good" : status.count ? "warn" : "bad"} dot>
          {status.count
            ? `${status.count.toLocaleString()} periods · ${fmt.rel(status.age_hours)}`
            : "no market data"}
        </Chip>
      ) : null,
    [status, fresh]
  );

  return (
    <>
      <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <IconBolt />
            </div>
            <div className="brand-text">
              <div className="brand-name">Strike</div>
              <div className="brand-sub">Singapore electricity price advisory</div>
            </div>
          </div>

          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="tab"
                onClick={() => go(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="topbar-actions">
            {statusChip}
            {busy && <span className="spinner" aria-label="Loading" />}
            <button
              className="btn btn-ghost btn-sm report-btn"
              onClick={() => window.print()}
              disabled={!data?.ready}
              title="Download a PDF report of this recommendation"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2.2c0 .6.4 1 1 1h12c.6 0 1-.4 1-1V17"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>PDF report</span>
            </button>
            <ThemeButton pref={pref} onCycle={cycle} />
            <button
              className="icon-btn hamburger"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={navOpen}
              aria-controls="strike-drawer"
            >
              <IconMenu />
            </button>
          </div>
        </div>
      </header>

      {navOpen && (
        <>
          <div className="drawer-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
          <aside
            className="drawer"
            id="strike-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Sections"
          >
            <div className="drawer-head">
              <div className="hstack" style={{ gap: 9 }}>
                <div className="brand-mark" aria-hidden="true">
                  <IconBolt />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Strike</div>
                  <div className="faint" style={{ fontSize: 11 }}>
                    Sections
                  </div>
                </div>
              </div>
              <button
                className="icon-btn"
                onClick={() => setNavOpen(false)}
                aria-label="Close navigation menu"
              >
                <IconClose />
              </button>
            </div>

            <nav className="drawer-nav">
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  className="drawer-item"
                  onClick={() => go(t.id)}
                  aria-current={tab === t.id ? "page" : undefined}
                >
                  <span className="idx" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block" }}>{t.label}</span>
                    <span
                      style={{
                        display: "block",
                        fontSize: 11,
                        fontWeight: 500,
                        opacity: 0.75,
                        marginTop: 1,
                      }}
                    >
                      {t.blurb}
                    </span>
                  </span>
                </button>
              ))}
            </nav>

            <div className="drawer-foot">
              <div className="hstack" style={{ justifyContent: "space-between" }}>
                <span className="faint small">Theme</span>
                <button className="btn btn-ghost btn-sm" onClick={cycle}>
                  {pref === "light" ? "Light" : pref === "dark" ? "Dark" : "System"}
                </button>
              </div>
              {statusChip && <div className="mt-2">{statusChip}</div>}
            </div>
          </aside>
        </>
      )}

      <main className="page">
        {error && (
          <div className="mb-2">
            <Note tone="bad">
              <strong>Could not load analytics.</strong> {error}
            </Note>
          </div>
        )}

        {!data && !error && <Loading label="Loading real market data" />}

        {data && !data.ready && (
          <div className="card">
            <h2 className="card-title">No market data yet</h2>
            <p className="card-sub">{data.reason}</p>
            <div className="hstack mt-2">
              <button className="btn" onClick={() => runSync("market")} disabled={!!syncing}>
                {syncing === "market" ? "Syncing…" : "Sync last 30 days"}
              </button>
              <button className="btn btn-ghost" onClick={() => runSync("tariff")} disabled={!!syncing}>
                {syncing === "tariff" ? "Syncing…" : "Sync regulated tariff"}
              </button>
            </div>
          </div>
        )}

        {data?.ready && (
          <>
            {tab === "strike" && (
              <StrikeView
                data={data}
                profile={profile}
                setProfile={setProfile}
                onSync={runSync}
                syncing={syncing}
              />
            )}
            {tab === "market" && <MarketView data={data} />}
            {tab === "compare" && (
              <CompareView
                data={data}
                profile={profile}
                setProfile={setProfile}
                onChanged={refresh}
              />
            )}
            {tab === "shift" && (
              <ShiftView
                data={data}
                profile={profile}
                setProfile={setProfile}
                onChanged={refresh}
              />
            )}
            {tab === "dr" && <DrView data={data} profile={profile} setProfile={setProfile} />}
            {tab === "sources" && (
              <SourcesView data={data} onSync={runSync} syncing={syncing} />
            )}
          </>
        )}
      </main>

      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 22,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--text-primary)",
            color: "var(--background)",
            padding: "11px 18px",
            borderRadius: "var(--r-pill)",
            fontSize: 13,
            boxShadow: "var(--sh-3)",
            zIndex: 100,
            maxWidth: "calc(100vw - 28px)",
            textAlign: "center",
          }}
        >
          {toast}
        </div>
      )}
      </div>

      {/*
        The printable report lives OUTSIDE .shell, because @media print hides the
        shell entirely. It is always mounted and hidden by CSS rather than being
        conditionally rendered on click: rendering it only when printing would race
        the browser's print call against React's commit, and printing a stale or
        half-rendered document is a bug that only shows up in the PDF.
      */}
      {data?.ready && <ReportDocument data={data} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Shared profile control strip, used by several views                 */
/* ------------------------------------------------------------------ */

export function ProfileControls({
  profile,
  setProfile,
  showDays = true,
  showAlpha = true,
}: {
  profile: ProfileState;
  setProfile: (p: ProfileState) => void;
  showDays?: boolean;
  showAlpha?: boolean;
}) {
  const upd = (patch: Partial<ProfileState>) => setProfile({ ...profile, ...patch });
  return (
    <div className="row">
      {showDays && (
        <div className="field">
          <FieldLabel
            htmlFor="pc-days"
            text="Analysis window"
            helpTitle="Analysis window"
            help={
              <>
                <p style={{ margin: 0 }}>
                  How much recent history every figure on this page is averaged over.
                </p>
                <ul>
                  <li>
                    <strong>30 days</strong> — reacts fast, but a single spike week can
                    dominate. Use when you are close to a decision deadline.
                  </li>
                  <li>
                    <strong>90 days</strong> — the default, and a good balance. Roughly one
                    quarter, which matches how the regulated tariff is revised.
                  </li>
                  <li>
                    <strong>180–365 days</strong> — smooths out seasonal and one-off events,
                    so it is the fairer basis for a multi-year contract decision. It also
                    hides recent changes.
                  </li>
                </ul>
                <div className="helptip-example">
                  <span className="ex-label">Practical tip</span>
                  Compare 90 days against 365 days. If they point to different conclusions,
                  the market has moved recently — that itself is a reason to look closely
                  before signing a long contract.
                </div>
              </>
            }
          />
          <select
            id="pc-days"
            value={profile.days}
            onChange={(e) => upd({ days: Number(e.target.value) })}
          >
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
            <option value={365}>Last 12 months</option>
          </select>
        </div>
      )}

      <div className="field">
        <FieldLabel
          htmlFor="pc-mwh"
          text="Annual consumption (MWh)"
          helpTitle="Annual consumption"
          help={
            <>
              <p style={{ margin: 0 }}>
                Your total electricity use for a year, in <em>megawatt hours</em>. This
                scales every cost figure, so it is the one input worth getting right.
              </p>
              <p style={{ margin: "8px 0 0" }}>
                <strong>Where to find it:</strong>
              </p>
              <ul>
                <li>
                  Add up 12 months of SP Group bills (kWh) and divide by <strong>1,000</strong>.
                </li>
                <li>
                  On a fixed contract, the retailer's fact sheet states your contracted
                  quantity — use that.
                </li>
                <li>
                  A single monthly bill is fine if your usage is steady: monthly kWh ÷ 1,000
                  × 12.
                </li>
              </ul>
              <div className="helptip-example">
                <span className="ex-label">Worked example</span>
                A site using 333,000 kWh a month is 333 MWh a month, so about{" "}
                <strong>4,000 MWh</strong> a year — enter <strong>4000</strong>.
              </div>
              <p style={{ margin: "8px 0 0" }}>
                <strong>Common mistake:</strong> entering kWh instead of MWh. If you are typing
                something in the millions, divide by 1,000 first.
              </p>
            </>
          }
        />
        <input
          id="pc-mwh"
          type="number"
          min={1}
          step={100}
          value={profile.mwh}
          onChange={(e) => upd({ mwh: Math.max(1, Number(e.target.value) || 0) })}
        />
      </div>

      {showAlpha && (
        <div className="field">
          <FieldLabel
            htmlFor="pc-alpha"
            text={`Load shape: ${profile.alpha <= 0 ? "flat" : profile.alpha.toFixed(1)}`}
            helpTitle="Load shape (α)"
            help={
              <>
                <p style={{ margin: 0 }}>
                  One dial controlling how <em>peaky</em> your consumption is. It matters
                  because wholesale prices swing through the day, so a peaky site is far more
                  exposed to expensive half hours than a flat one.
                </p>
                <ul>
                  <li>
                    <strong>0</strong> — perfectly flat. 24/7 load with no cooling swing, e.g.
                    a data centre on chilled-water storage.
                  </li>
                  <li>
                    <strong>1.0</strong> — follows the national demand profile exactly.
                  </li>
                  <li>
                    <strong>1.4</strong> — typical for retail and cold chain. The default.
                  </li>
                  <li>
                    <strong>2.5+</strong> — strongly peaky: single-shift office or factory that
                    is idle overnight.
                  </li>
                </ul>
                <div className="helptip-example">
                  <span className="ex-label">How to check it</span>
                  The app derives your load factor and peak-window share and shows them on the{" "}
                  <em>Load shifting</em> tab. A 24/7 industrial site is usually 0.6–0.8; a
                  single-shift office is nearer 0.3. If those do not match your own bills,
                  adjust α until they do.
                </div>
                <p style={{ margin: "8px 0 0" }}>
                  Only the <em>timing</em> of peaks is modelled, and it comes from real
                  national demand data — this dial changes how strongly you follow it.
                </p>
              </>
            }
          />
          <input
            id="pc-alpha"
            type="range"
            min={0}
            max={3}
            step={0.1}
            value={profile.alpha}
            onChange={(e) => upd({ alpha: Number(e.target.value) })}
          />
          <span className="hint">
            {profile.alpha <= 0.2
              ? "Flat — 24/7 load with no cooling swing"
              : profile.alpha < 1.1
                ? "Follows the national demand profile"
                : profile.alpha < 2
                  ? "Peakier than average — retail, cold chain"
                  : "Strongly peaky — single-shift, office hours"}
          </span>
        </div>
      )}

      <div className="field">
        <FieldLabel
          htmlFor="pc-curt"
          text="Curtailable load (MW)"
          helpTitle="Curtailable load"
          help={
            <>
              <p style={{ margin: 0 }}>
                The firm load you could drop within about three minutes{" "}
                <em>without harming operations</em>. This is not your total load — only the
                part that is genuinely interruptible.
              </p>
              <p style={{ margin: "8px 0 0" }}>
                <strong>Usually curtailable:</strong> chillers with thermal storage, EV fleet
                charging, batch processes, pumps, and anything with a buffer tank.
              </p>
              <p style={{ margin: "6px 0 0" }}>
                <strong>Usually not:</strong> cold rooms holding product at temperature,
                continuous process lines, and anything with a safety or quality consequence.
              </p>
              <div className="helptip-example">
                <span className="ex-label">Programme thresholds</span>
                EMA requires at least <strong>0.1 MW</strong> of curtailment responding in
                roughly three minutes. Below 1 MW, an aggregator that bundles several sites is
                the realistic route. Set this to <strong>0</strong> if the site cannot curtail
                at all — the recommendation then ignores Demand Response entirely.
              </div>
              <p style={{ margin: "8px 0 0" }}>
                Be conservative. Overstating this makes the DR estimate optimistic, and the
                programme pays nothing at all for delivering between 80% and 100% of a
                scheduled reduction.
              </p>
            </>
          }
        />
        <input
          id="pc-curt"
          type="number"
          min={0}
          step={0.1}
          value={profile.curtailable_mw}
          onChange={(e) => upd({ curtailable_mw: Math.max(0, Number(e.target.value) || 0) })}
        />
        <span className="hint">Firm load you can drop on request</span>
      </div>
    </div>
  );
}

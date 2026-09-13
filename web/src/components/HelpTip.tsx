/**
 * Contextual help tooltip.
 *
 * Design constraints that shaped this:
 *
 *  - It must not be clipped. The form controls sit inside cards with rounded
 *    corners and `overflow: hidden` in places, so an absolutely-positioned panel
 *    gets cut off. This positions itself with `position: fixed` from the trigger's
 *    measured rect, and flips above the trigger when there is no room below.
 *  - It must work on touch. There is no hover on a phone, so tapping toggles the
 *    panel and tapping outside dismisses it.
 *  - It must work from the keyboard. The trigger is a real button, so Tab reaches
 *    it, Enter/Space opens it, and Escape closes it.
 *  - It must not be a `title` attribute. Native tooltips cannot hold a worked
 *    example or a caveat, which is precisely what these parameters need.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface Placement {
  left: number;
  top: number;
  width: number;
  above: boolean;
}

const PANEL_WIDTH = 330;
const GAP = 8;

export function HelpTip({
  title,
  children,
  /** Screen-reader label for the trigger; defaults to the title. */
  label,
}: {
  title: string;
  children: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  /** True when opened by tap/click, which suppresses hover-close behaviour. */
  const [pinned, setPinned] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Placement>({ left: 0, top: 0, width: PANEL_WIDTH, above: false });
  const id = useId();

  const reposition = useCallback(() => {
    const btn = btnRef.current;
    const panel = panelRef.current;
    if (!btn) return;

    const r = btn.getBoundingClientRect();
    const panelH = panel?.offsetHeight ?? 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const width = Math.min(PANEL_WIDTH, vw - 24);

    // Prefer right-aligned to the trigger so panels on the right edge stay put.
    let left = r.right - width;
    left = Math.max(12, Math.min(left, vw - width - 12));

    const roomBelow = vh - r.bottom;
    const above = roomBelow < panelH + GAP + 12 && r.top > roomBelow;

    const top = above ? Math.max(12, r.top - panelH - GAP) : r.bottom + GAP;

    setPlace({ left, top, width, above });
  }, []);

  // Measure after the panel exists, so height is known before placing it.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const raf = requestAnimationFrame(reposition);
    return () => cancelAnimationFrame(raf);
  }, [open, reposition]);

  // Dismiss on Escape, outside tap, scroll or resize.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
        btnRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
      setPinned(false);
    };
    const onScrollOrResize = () => {
      // A fixed panel would detach from its trigger, so close instead of drift.
      setOpen(false);
      setPinned(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const show = () => setOpen(true);
  const hide = () => {
    if (!pinned) setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="helptip-btn"
        aria-label={`Help: ${label ?? title}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const next = !open;
          setOpen(next);
          setPinned(next);
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9.4" stroke="currentColor" strokeWidth="1.9" />
          <path
            d="M12 10.6v6.2"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <circle cx="12" cy="7.5" r="1.3" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={id}
          role="tooltip"
          className="helptip-panel"
          style={{ left: place.left, top: place.top, width: place.width }}
        >
          <div className="helptip-title">{title}</div>
          <div className="helptip-body">{children}</div>
        </div>
      )}
    </>
  );
}

/**
 * A labelled form field with an adjacent help trigger.
 * Keeps the label/help row consistent across every parameter form.
 */
export function FieldLabel({
  htmlFor,
  text,
  help,
  helpTitle,
}: {
  htmlFor?: string;
  text: ReactNode;
  help?: ReactNode;
  helpTitle?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="field-label-row">
      <span>{text}</span>
      {help && <HelpTip title={helpTitle ?? String(text)}>{help}</HelpTip>}
    </label>
  );
}

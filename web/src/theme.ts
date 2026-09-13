/**
 * Theme handling.
 *
 * Three states: "light", "dark" and "system". The resolved theme is always
 * written to <html data-theme>, so all colour comes from CSS custom properties
 * and no component needs to know which theme is active.
 *
 * "system" re-resolves live via matchMedia, so an OS-level switch is picked up
 * without a reload.
 */
import { useCallback, useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "strike.theme";

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* private mode or storage disabled */
  }
  return "system";
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "system") return prefersDark() ? "dark" : "light";
  return pref;
}

/** Apply immediately — used before first paint to avoid a flash of the wrong theme. */
export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // Keeps the browser UI (scrollbars, form controls) consistent.
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0A0F1E" : "#F8FAFC");
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemePref()));

  // Apply on every change.
  useEffect(() => {
    const r = resolveTheme(pref);
    setResolved(r);
    applyTheme(r);
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* ignore */
    }
  }, [pref]);

  // Track OS changes while in "system".
  useEffect(() => {
    if (pref !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r = resolveTheme("system");
      setResolved(r);
      applyTheme(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const cycle = useCallback(() => {
    setPref((p) => (p === "light" ? "dark" : p === "dark" ? "system" : "light"));
  }, []);

  return { pref, resolved, setPref, cycle };
}

/** Runs before React mounts so the first paint is already correct. */
export const THEME_BOOTSTRAP = `(function(){try{
var p=localStorage.getItem('${STORAGE_KEY}')||'system';
var d=p==='dark'||(p==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
var r=d?'dark':'light';
document.documentElement.dataset.theme=r;
document.documentElement.style.colorScheme=r;
}catch(e){document.documentElement.dataset.theme='light';}})();`;

/**
 * Shared helpers for Singapore-time bucketing.
 *
 * Market timestamps are stored as ISO8601 with a fixed +08:00 offset, and
 * Singapore has no daylight saving. That means the local wall-clock time is
 * literally present in the string, so slicing is both correct and fast — no
 * timezone database lookups needed for 40k+ half-hour periods.
 */
import type { MarketPeriod } from "../db.ts";

/** "2026-09-01T14:30:00+08:00" -> "2026-09-01" */
export const sgtDate = (ts: string) => ts.slice(0, 10);

/** "2026-09-01T14:30:00+08:00" -> "14:30" */
export const sgtHHMM = (ts: string) => ts.slice(11, 16);

/** Minutes past midnight, SGT. Period start, so 00:00 -> 0 … 23:30 -> 1410. */
export function sgtMinutes(ts: string): number {
  return Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16));
}

/** 0 = Sunday … 6 = Saturday, for the SGT calendar date. */
export function sgtWeekday(ts: string): number {
  const y = Number(ts.slice(0, 4));
  const m = Number(ts.slice(5, 7));
  const d = Number(ts.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isWeekend = (ts: string) => {
  const w = sgtWeekday(ts);
  return w === 0 || w === 6;
};

/**
 * Singapore's demand peak is a working-hours phenomenon. 08:00–19:59 on
 * weekdays is the conventional commercial peak window and is the one used for
 * peak/off-peak reporting.
 */
export function isPeakWindow(ts: string): boolean {
  if (isWeekend(ts)) return false;
  const m = sgtMinutes(ts);
  return m >= 8 * 60 && m < 20 * 60;
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export const round = (n: number, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** Ascending sort by USEP, ignoring nulls. */
export function usepSorted(periods: MarketPeriod[]): number[] {
  return periods
    .map((p) => p.usep)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
}

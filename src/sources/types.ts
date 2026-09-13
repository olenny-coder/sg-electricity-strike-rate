/**
 * Shared source-layer types.
 *
 * A "source" in Strike is a named, documented origin for a real value.
 * Every source declares its access mode so the API and UI can be honest about
 * what is actually available versus what requires a human step.
 */

export type AccessMode =
  /** Public, unauthenticated, machine-readable. */
  | "open"
  /** Public HTML page that must be parsed. */
  | "scrape"
  /** Behind a login / SSO wall. Requires a human with credentials. */
  | "auth_required"
  /** No public origin exists; a human must enter verified values. */
  | "manual"
  /** Documented but currently non-functional. */
  | "broken";

export type RunStatus = "OK" | "FAILED" | "AUTH_REQUIRED" | "EMPTY" | "NEVER_RUN";

export interface SourceDescriptor {
  id: string;
  name: string;
  /** What this source provides, in plain business language. */
  provides: string;
  unit: string | null;
  access: AccessMode;
  /** Canonical human-facing URL (the page a person would open). */
  url: string;
  /** Exact endpoint the ingestion code calls, when machine-facing. */
  endpoint?: string;
  publisher: string;
  /** How long a value from this source may be considered current. */
  maxAgeHours: number;
  notes?: string;
  /** Called out in the UI as the reason a panel is empty. */
  limitation?: string;
}

/** A value with full provenance, as returned by the API. */
export interface Dated<T> {
  value: T;
  source_id: string;
  source_url: string | null;
  observed_at: string;
  age_hours: number;
  stale: boolean;
}

export function ageHours(observedAt: string, at: Date = new Date()): number {
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (at.getTime() - t) / 3_600_000;
}

export function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

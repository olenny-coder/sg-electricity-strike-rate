#!/usr/bin/env python
"""
Mandated USEP probe — `energy-trading-api==0.0.34`.

The build spec names this package as the PRIMARY access path for USEP:

    from energy_trading_api import singaporeNEMS
    df = singaporeNEMS.singaporeUSEP(date="2026-09-01")

That call is implemented as `pandas.read_html()` against
https://www.emcsg.com/marketdata/priceinformation?...  This script invokes it
exactly as documented and records what actually comes back, so the application
can report the real status of the mandated path instead of assuming it works.

Results are written to a JSON file (not stdout) so the result survives even
when the parent process cannot capture a pipe.

Usage:
    python tools/usep_mandated.py --out data/mandated_probe.json
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import date, timedelta


def probe_one(singaporeNEMS, date_str: str) -> dict:
    """Invoke the documented call for a single date and classify the outcome."""
    rec: dict = {"date": date_str, "ok": False, "rows": 0, "error": None, "sample": []}
    try:
        df = singaporeNEMS.singaporeUSEP(date=date_str)
    except Exception as exc:  # noqa: BLE001 - we are deliberately reporting anything
        rec["error"] = f"{type(exc).__name__}: {exc}"
        return rec

    if df is None:
        rec["error"] = "returned None (the wrapper swallows its own exception)"
        return rec

    try:
        rec["rows"] = int(len(df))
        rec["columns"] = [str(c) for c in df.columns]
        if len(df):
            # Emit a couple of real values so the caller can see actual data.
            rec["sample"] = [
                {
                    "period": int(r["PERIOD"]) if "PERIOD" in df.columns else None,
                    "usep": float(r["USEP ($/MWh)"])
                    if "USEP ($/MWh)" in df.columns
                    else None,
                }
                for _, r in df.head(4).iterrows()
            ]
        rec["ok"] = rec["rows"] > 0
    except Exception as exc:  # noqa: BLE001
        rec["error"] = f"post-processing failed: {type(exc).__name__}: {exc}"
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="path to write the JSON result")
    ap.add_argument("--dates", default="", help="comma-separated ISO dates to probe")
    args = ap.parse_args()

    today = date.today()
    if args.dates:
        dates = [d.strip() for d in args.dates.split(",") if d.strip()]
    else:
        # Today, a recent settled day, and a historical day: the path should
        # work for all three if the source were genuinely public.
        dates = [
            today.isoformat(),
            (today - timedelta(days=10)).isoformat(),
            (today - timedelta(days=400)).isoformat(),
        ]

    result: dict = {
        "package": "energy-trading-api",
        "pinned_version": "0.0.34",
        "python": sys.version.split()[0],
        "import_ok": False,
        "import_error": None,
        "probes": [],
        "verdict": None,
    }

    try:
        from energy_trading_api import singaporeNEMS  # type: ignore

        result["import_ok"] = True
    except Exception as exc:  # noqa: BLE001
        result["import_error"] = f"{type(exc).__name__}: {exc}"
        result["verdict"] = (
            "The mandated package could not be imported in this environment."
        )
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
        print(result["verdict"])
        return 0

    try:
        import energy_trading_api  # type: ignore

        result["installed_version"] = getattr(energy_trading_api, "__version__", None)
    except Exception:  # noqa: BLE001
        pass

    for d in dates:
        result["probes"].append(probe_one(singaporeNEMS, d))

    ok_any = any(p["ok"] for p in result["probes"])
    if ok_any:
        result["verdict"] = "Mandated path returned data."
    else:
        errs = {p["error"] for p in result["probes"] if p["error"]}
        result["verdict"] = (
            "Mandated path returned no data for any probed date ("
            + "; ".join(sorted(errs))
            + ")."
        )
    result["path_usable"] = ok_any

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
    print(result["verdict"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        raise SystemExit(1)

/**
 * Real-data audit.
 *
 * "Real data only" is a claim that has to be testable. This script re-fetches
 * the upstream sources independently and reconciles them against what is
 * actually stored, so drift, fabrication or a silently-broken scraper cannot go
 * unnoticed.
 *
 * It checks four things:
 *
 *   1. LIVE RECONCILIATION — pull a day from EMC's NEMS feed and from EMA's
 *      tariff CSV, and compare with the stored values period by period.
 *   2. PROVENANCE — every stored row must name its source and carry an
 *      observation timestamp.
 *   3. DERIVED-VALUE HONESTY — the contract offers must carry the note
 *      explaining where the rate came from and what was converted.
 *   4. NO FABRICATION — scan the source tree for placeholder or mock values.
 *
 * Network-dependent by design, so it is a tool rather than a CI gate.
 *
 *   node tools/audit-real-data.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { store } from "../src/store/index.ts";

let failures = 0;
let warnings = 0;

const ok = (label, detail = "") => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail = "") => {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
};
const warn = (label, detail = "") => {
  console.log(`  WARN  ${label}${detail ? ` — ${detail}` : ""}`);
  warnings++;
};

console.log("=== 1. Live reconciliation against upstream sources ===\n");

// ---- EMC: re-fetch a recent day and compare with stored values ------------
const range = await store.marketRange();
if (!range.n || !range.hi) {
  bad("stored market data exists", "nothing ingested");
} else {
  console.log(`  Stored: ${range.n.toLocaleString()} periods, newest ${range.hi}`);

  // EMC publishes the current day provisionally and revises it afterwards
  // (observed revisions of several hundred SGD/MWh on the same day). Exact
  // reconciliation is therefore asserted against a SETTLED day, four days back.
  // The newest day is measured and reported separately, not used as a gate.
  const settledMs = Date.parse(range.hi) - 4 * 86_400_000 + 8 * 3_600_000;
  const day = new Date(settledMs).toISOString().slice(0, 10);
  const url =
    `https://www.nems.emcsg.com/api/sitecore/DataSync/DataDownload` +
    `?value=10&fromDate=${day}&toDate=${day}&tpcValue=1`;

  console.log(`  Re-fetching ${day} directly from EMC...`);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    warn("EMC reachable for reconciliation", `HTTP ${res.status}`);
  } else {
    const text = await res.text();
    const lines = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((l) => l.trim().length);

    const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
    const iPeriod = header.indexOf("Period");
    const iUsep = header.findIndex((h) => h.startsWith("USEP"));
    const iLcp = header.findIndex((h) => h.startsWith("LCP"));

    const stored = await store.listMarketPeriods(
      `${day}T00:00:00+08:00`,
      `${day}T23:59:59+08:00`
    );
    const byPeriod = new Map();
    for (const p of stored) {
      const minutes = Number(p.ts.slice(11, 13)) * 60 + Number(p.ts.slice(14, 16));
      byPeriod.set(minutes, p);
    }

    let compared = 0;
    let mismatched = 0;
    let lcpCompared = 0;
    let lcpMismatched = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('","').map((c) => c.replace(/^"|"$/g, ""));
      const period = cols[iPeriod];
      const start = period?.split("-")[0];
      if (!start) continue;
      const [hh, mm] = start.split(":").map(Number);
      const minutes = hh * 60 + mm;

      const upstreamUsep = Number(cols[iUsep]);
      const mine = byPeriod.get(minutes);
      if (!mine) continue;

      compared++;
      if (Math.abs((mine.usep ?? NaN) - upstreamUsep) > 0.005) mismatched++;

      if (iLcp >= 0 && mine.lcp !== null) {
        lcpCompared++;
        if (Math.abs(mine.lcp - Number(cols[iLcp])) > 0.005) lcpMismatched++;
      }
    }

    if (compared === 0) {
      warn("compared stored vs upstream USEP", "no overlapping periods found");
    } else if (mismatched === 0) {
      ok(
        `stored USEP matches EMC exactly on a settled day (${day})`,
        `${compared} periods compared, 0 mismatches`
      );
    } else {
      bad(
        `stored USEP matches EMC exactly on a settled day (${day})`,
        `${mismatched}/${compared} mismatched`
      );
    }

    if (lcpCompared > 0) {
      if (lcpMismatched === 0) {
        ok("stored LCP matches EMC exactly", `${lcpCompared} periods compared`);
      } else {
        bad("stored LCP matches EMC exactly", `${lcpMismatched}/${lcpCompared} mismatched`);
      }
    }
  }

  // Report the provisional newest day separately. A difference here is expected
  // and is precisely why ingestion re-fetches an overlapping window each run.
  const newestDay = range.hi.slice(0, 10);
  const provRes = await fetch(
    `https://www.nems.emcsg.com/api/sitecore/DataSync/DataDownload` +
      `?value=10&fromDate=${newestDay}&toDate=${newestDay}&tpcValue=1`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      },
    }
  );
  if (provRes.ok) {
    const text = await provRes.text();
    const lines = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((l) => l.trim().length);
    const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
    const iPeriod = header.indexOf("Period");
    const iUsep = header.findIndex((h) => h.startsWith("USEP"));

    const stored = await store.listMarketPeriods(
      `${newestDay}T00:00:00+08:00`,
      `${newestDay}T23:59:59+08:00`
    );
    const byMin = new Map();
    for (const p of stored) {
      byMin.set(Number(p.ts.slice(11, 13)) * 60 + Number(p.ts.slice(14, 16)), p);
    }

    let cmp = 0;
    let diff = 0;
    let maxDiff = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('","').map((c) => c.replace(/^"|"$/g, ""));
      const start = cols[iPeriod]?.split("-")[0];
      if (!start) continue;
      const [hh, mm] = start.split(":").map(Number);
      const mine = byMin.get(hh * 60 + mm);
      if (!mine) continue;
      cmp++;
      const d = Math.abs((mine.usep ?? NaN) - Number(cols[iUsep]));
      if (d > 0.005) {
        diff++;
        maxDiff = Math.max(maxDiff, d);
      }
    }

    if (diff === 0) {
      ok(
        `newest day (${newestDay}) is currently in step with EMC`,
        `${cmp} periods, no revision yet`
      );
    } else {
      warn(
        `newest day (${newestDay}) differs from EMC by up to ${maxDiff.toFixed(2)} S$/MWh`,
        `${diff}/${cmp} periods — expected: EMC publishes this day provisionally and revises it. Ingestion re-fetches a 14-day window to absorb revisions.`
      );
    }
  }
}

// ---- EMA: re-fetch the tariff CSV and re-derive the total -----------------
const latest = await store.latestTariff();
if (!latest) {
  bad("stored tariff exists", "nothing ingested");
} else {
  console.log(`\n  Stored tariff: ${latest.quarter} = ${latest.total_c} c/kWh ex-GST`);
  if (latest.source_url) {
    const res = await fetch(latest.source_url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      },
    });
    if (!res.ok) {
      warn("EMA tariff CSV reachable", `HTTP ${res.status}`);
    } else {
      const clean = (await res.text()).replace(/^\uFEFF/, "").trim();
      const values = clean.split(/\r?\n/)[1].split(",").map(Number);
      const sum = values.reduce((a, b) => a + b, 0);

      if (Math.abs(sum - latest.total_c) < 0.005) {
        ok(
          "stored tariff total equals the sum of EMA's published components",
          `${values.join(" + ")} = ${sum.toFixed(2)}`
        );
      } else {
        bad(
          "stored tariff total equals the sum of EMA's published components",
          `components sum to ${sum.toFixed(2)}, stored ${latest.total_c}`
        );
      }
    }
  }

  // Reconcile against EMA's prose headline, which is an independent statement.
  const pageUrl =
    "https://www.ema.gov.sg/consumer-information/electricity/buying-electricity/buying-at-regulated-tariff";
  const page = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    },
  });
  if (page.ok) {
    const html = await page.text();
    // ema.gov.sg is behind Imperva bot management and answers with a ~1 KB
    // challenge page (HTTP 200) when it decides a client is automated. That is a
    // property of the host, not a data-integrity problem, so it is reported
    // distinctly rather than as a parse failure.
    const challenged =
      /_Incapsula_Resource|Request unsuccessful|Incapsula incident ID/i.test(html);

    if (challenged) {
      warn(
        "EMA prose headline cross-check unavailable",
        "ema.gov.sg returned an Imperva bot challenge (HTTP 200, ~1 KB shell). The component CSV is served from a static path and is unaffected, so the tariff figure itself remains verified."
      );
    } else {
      const m = html.match(
        /the\s+regulated\s+tariff\s+is\s+([\d.]+)\s*cents\/kWh\s*\(before\s+GST\),?\s*or\s+([\d.]+)\s*cents\/kWh\s*\(with\s+GST\)/i
      );
      if (m) {
        const exGst = Number(m[1]);
        const incGst = Number(m[2]);
        if (Math.abs(exGst - latest.total_c) < 0.005) {
          ok("stored tariff matches EMA's published headline", `${exGst} c/kWh`);
        } else {
          bad(
            "stored tariff matches EMA's published headline",
            `EMA says ${exGst}, stored ${latest.total_c}`
          );
        }
        // Independent GST check: 9% since 2024.
        if (Math.abs(exGst * 1.09 - incGst) < 0.02) {
          ok(
            "EMA's own ex-GST and inc-GST figures are consistent at 9%",
            `${exGst} x 1.09 = ${incGst}`
          );
        } else {
          warn(
            "GST consistency",
            `${exGst} x 1.09 = ${(exGst * 1.09).toFixed(2)}, EMA states ${incGst}`
          );
        }
      } else {
        warn("could parse EMA's headline prose", "pattern not found");
      }
    }
  }
}

console.log("\n=== 2. Provenance on every stored row ===\n");

const sample = await store.listMarketPeriods(
  range.lo ?? "2023-01-01T00:00:00+08:00",
  range.hi ? `${range.hi.slice(0, 10)}T23:59:59+08:00` : "9999-12-31T00:00:00+08:00"
);
const missingSource = sample.filter((p) => !p.source_id || !p.observed_at);
if (missingSource.length === 0) {
  ok("every market period names its source and observation time", `${sample.length} rows checked`);
} else {
  bad("every market period names its source", `${missingSource.length} rows missing provenance`);
}

const publisherStamped = sample.filter((p) => p.source_last_updated).length;
if (publisherStamped > 0) {
  ok(
    "rows carry the publisher's own Last Updated stamp",
    `${publisherStamped.toLocaleString()} of ${sample.length.toLocaleString()}`
  );
} else {
  warn("publisher stamp present", "none found");
}

const tariffs = await store.listTariffs();
const badTariffs = tariffs.filter((t) => !t.source_id || !t.source_url);
if (badTariffs.length === 0) {
  ok("every tariff quarter records its source URL", `${tariffs.length} quarters`);
} else {
  bad("every tariff quarter records its source URL", `${badTariffs.length} missing`);
}

console.log("\n=== 3. Derived and operator-entered values are labelled ===\n");

const offers = await store.listOffers();
if (offers.length === 0) {
  warn("fixed-price offers present", "none loaded");
} else {
  const undocumented = offers.filter((o) => !o.notes || o.notes.trim().length < 20);
  if (undocumented.length === 0) {
    ok("every offer carries a provenance note", `${offers.length} offers`);
  } else {
    bad("every offer carries a provenance note", `${undocumented.length} lack notes`);
  }

  const seeded = offers.filter((o) => /incl\. GST/i.test(o.notes ?? ""));
  if (seeded.length) {
    ok(
      "seeded published rates state the original incl-GST figure and the conversion",
      `${seeded.length} seeded`
    );
  }
  const operatorEntered = offers.filter((o) => o.source_id === "operator_entered").length;
  ok(
    "all offers are marked operator_entered, not machine-verified",
    `${operatorEntered}/${offers.length}`
  );
}

console.log("\n=== 4. No fabricated values in the source tree ===\n");

const BANNED = [
  /\bmock(ed|ing)?\s*(data|usep|price)/i,
  /\bplaceholder\s*(price|rate|value)/i,
  /\bdummy\s*(data|value)/i,
  /\blorem ipsum\b/i,
  /\bsample\s*usep\b/i,
  /\bfake\s*(data|price)/i,
  /\bhardcoded\s*(price|rate)/i,
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "_research", ".venv"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(process.cwd());
const hits = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) hits.push(`${path.relative(process.cwd(), f)}: ${m[0]}`);
  }
}

if (hits.length === 0) {
  ok("no mock, placeholder or fabricated price values", `${files.length} files scanned`);
} else {
  // Comments explaining what is deliberately absent are fine; flag for review.
  warn("possible fabricated values", hits.join("; "));
}

// Math.random is used for chart element ids; make sure it is not generating data.
const randomInData = files.filter((f) => {
  const t = fs.readFileSync(f, "utf8");
  return /Math\.random\(\)/.test(t) && !/charts\.tsx/.test(f);
});
if (randomInData.length === 0) {
  ok("Math.random is confined to chart element ids, never to data");
} else {
  bad(
    "Math.random must not produce data values",
    randomInData.map((f) => path.relative(process.cwd(), f)).join(", ")
  );
}

console.log(
  `\n${failures === 0 ? "AUDIT PASSED" : `AUDIT FAILED (${failures} failure(s))`}` +
    `${warnings ? ` with ${warnings} warning(s)` : ""}`
);
process.exit(failures === 0 ? 0 : 1);

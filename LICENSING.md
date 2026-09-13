Licensing
=========

Strike is licensed by subject matter, because code and data want different terms.

## Software — MIT

Source code, scripts, configuration and build files are licensed under the MIT
Licence. The full text is in [`LICENSE`](LICENSE).

MIT was chosen so the code can be reused with the fewest possible obligations.

## Data — CC BY 4.0

Compiled datasets, derived data and the factual content of the documentation are
licensed under the Creative Commons Attribution 4.0 International Licence. The
full scope, the attribution wording and the upstream-rights caveats are in
[`LICENSE-DATA`](LICENSE-DATA).

CC BY 4.0 was chosen because the value here is the compilation — the ingested
history, the normalisation, the reconciliation against the publishers — and the
derivations built on it, such as the fair value reference and the lock-in score.

## Which applies to a given file

| Subject matter | Licence |
|---|---|
| Source code, scripts, configuration, build files | MIT |
| Compiled datasets and data exports | CC BY 4.0 |
| Derived data (fair value, lock-in score, cost comparisons, shift plans, demand-response estimates, forecast statistics) | CC BY 4.0 |
| Compiled reference figures and factual content in the documentation | CC BY 4.0 |

Some files mix both. `src/sources/facts.ts` is code that also carries compiled
market facts; `src/seed.ts` is code that also carries compiled published retail
rates. In those files **the code is MIT and the compiled content it carries is
CC BY 4.0**. The line is drawn by subject matter, not by file.

## The upstream data is not ours to license

Stated plainly, because it is easy to assume otherwise. The prices are facts about
the Singapore electricity market, and their publishers retain their own terms:

| Upstream source | Publisher |
|---|---|
| USEP, demand, ancillary reserve prices, Load Curtailment Price, Temporary Price Cap parameters | Energy Market Company (EMC) |
| Regulated tariff and its components | Energy Market Authority (EMA) / SP Group |
| Published retail fixed-price rates | the individual licensed retailers |

CC BY 4.0 here covers the **compilation and the derivation**. It cannot grant any
right in the source data, because that data was never this project's to license.

If you intend to redistribute a compiled dataset rather than use it internally,
satisfy yourself that your use is permitted upstream. Two specifics from the
research recorded in `docs/free-tier-deployment-2026.md`:

- No reuse licence, SLA or rate limit was found published for the EMC endpoint.
  EMC's own documentation directs anyone needing more certainty to its paid data
  subscription.
- `ema.gov.sg` sits behind Imperva bot management, so automated access is
  tolerated conditionally rather than granted. The tariff CSVs are served from a
  static path and are not challenged.

Neither publisher was asked for permission during development, and no claim of
permission is made.

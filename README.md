<p align="center">
  <img src="./assets/avatar.jpg" alt="GPTHEIST" width="128">
</p>
<p align="center">
  <img src="./assets/banner.jpg" alt="GPTHEIST — Ten agents. One decision." width="100%">
</p>

<p align="center">
  <strong>Ten agents pass one market decision forward. Any one of them can kill it.</strong>
</p>

<p align="center">
  <a href="https://github.com/immortalhowwl/gptheist/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/immortalhowwl/gptheist/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="mode" src="https://img.shields.io/badge/mode-paper--only-e5484d">
  <img alt="runtime dependencies" src="https://img.shields.io/badge/runtime%20dependencies-viem-f4efe6">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-f4efe6">
</p>

GPTHEIST is a read-only Robinhood Chain launch desk plus a deterministic market-replay CLI inspired by the ten-agent operating system described by [@immortalhowwl](https://x.com/immortalhowwl). Every Pons factory launch crosses ten visible evidence stages. Palermo vetoes unsupported action; Professor never sends an order.

The live Desk reads public chain data only. It has **no wallet connection, private key, signing, brokerage integration, or order execution path**. Raw launch events alone do not authorize a paper trade: a completed WATCH must also pass fresh quote and paper risk checks.

<p align="center">
  <img src="./assets/desk.png" alt="GPTHEIST Desk showing live Robinhood Chain launches and a Palermo veto" width="100%">
</p>

## Sixty seconds

Requires Node.js 18 or newer.

```bash
git clone https://github.com/immortalhowwl/gptheist.git
cd gptheist
npm install
npm run desk
```

Open `http://127.0.0.1:4173`. The Desk reads recent `TokenLaunched` events from the verified Pons v2 factory on Robinhood Chain (chain ID `4663`). Double-click an intercept to open its transaction on Blockscout.

For the fully offline deterministic replay instead:

```bash
npm run demo
```

The replay uses the bundled `fixtures/success.json`:

```text
GPTHEIST — PAPER-TRADING REPLAY
Safety: simulation only; no wallet, signing, private keys, or live execution.

[2026-01-15T12:00:00.000Z] TOKYO      INFO :: Scout — Observed GPTHEIST-USDC at 0.42 from bundled replay data.
[2026-01-15T12:00:01.000Z] BERLIN     INFO :: Planner / criteria — Criteria locked: momentum >= 0.55, social quality >= 0.50/100 samples, liquidity >= $1m, slippage <= 25 bps.
[2026-01-15T12:00:02.000Z] RIO        PASS :: Technical / chart analysis — Momentum score 0.72.
[2026-01-15T12:00:03.000Z] DENVER     PASS :: Social-signal quality — Social score 0.66 across 250 fixture samples.
[2026-01-15T12:00:04.000Z] LISBON     PASS :: Data / handoff validation — Fixture schema validated; ordered handoff continuity is structurally enforced.
[2026-01-15T12:00:05.000Z] STOCKHOLM  PASS :: Liquidity / slippage / position sizing — Liquidity $5000000; slippage 8 bps; simulated size 1.50%.
[2026-01-15T12:00:06.000Z] NAIROBI    INFO :: Signal brief — Brief: technical, social, data, and sizing checks cleared.
[2026-01-15T12:00:07.000Z] HELSINKI   INFO :: Append-only audit / logistics — Audit trace 9d64be648f8a52d3 prepared; execution remains disabled.
[2026-01-15T12:00:08.000Z] PALERMO    PASS :: Red-team veto gate — Red-team gate found no policy violation.
[2026-01-15T12:00:09.000Z] PROFESSOR  PASS :: Final coordinator / decision — Approved for paper simulation only; no order was sent.

FINAL: PASS — approved (paper-only; executed=false)
Paper trade: BUY 1.50% GPTHEIST-USDC @ 0.42
Audit: runs/b8d3603a21d62139.jsonl
```

## Commands

| Command | What it does |
|---|---|
| `npm run desk` | Builds and opens the read-only live launch desk on port `4173` |
| `npm run demo` | Builds and runs the bundled safe replay |
| `node dist/src/cli.js replay fixtures/veto.json` | Replays any local fixture and writes an audit log |
| `node dist/src/cli.js agents` | Lists all ten roles and boundaries |
| `node dist/src/cli.js doctor` | Checks Node, fixture access, logs, dependencies, and execution mode |
| `npm test` | Builds and runs the complete test suite |

After `npm link`, use the shorter binary form:

```bash
gptheist desk
gptheist demo
gptheist replay fixtures/veto.json
gptheist agents
gptheist doctor
```

## The handoff

```text
TOKYO → BERLIN → RIO → DENVER → LISBON
  → STOCKHOLM → NAIROBI → HELSINKI
  → PALERMO (PASS / VETO) → PROFESSOR
```

1. **Tokyo** frames the observation.
2. **Berlin** locks the criteria before analysis.
3. **Rio** checks technical context.
4. **Denver** grades the supplied social signal.
5. **Lisbon** validates data and handoffs.
6. **Stockholm** checks liquidity, slippage, and simulated size.
7. **Nairobi** compresses the cleared signals.
8. **Helsinki** prepares an append-only trace.
9. **Palermo** attempts to stop unsafe work.
10. **Professor** returns the final paper-only decision.

See [`docs/AGENTS.md`](docs/AGENTS.md) for responsibilities and approval boundaries.

## Replay your own fixture

Copy a bundled fixture and edit its observation fields:

```bash
cp fixtures/success.json my-replay.json
npm run build
node dist/src/cli.js replay my-replay.json
```

Every replay input is local JSON; replay mode does not fetch market data. Fixtures are schema-validated before the first handoff, and terminal control characters are escaped. Identical input under the same policy version produces the same run ID, handoffs, timestamps, and final decision. Audit records are written to `runs/<run-id>.jsonl`. Existing records are immutable: the CLI refuses to overwrite a run ID with different content.

A run is vetoed when any configured boundary fails, including:

- incomplete or invalid replay data;
- momentum below `0.55`;
- social quality below `0.50` or fewer than `100` fixture samples;
- liquidity below `$1,000,000`;
- estimated slippage above `25 bps`;
- requested size outside its explicit cap;
- any supplied risk flag.

These thresholds are demonstration rules, not trading advice or validated predictors.

## What this is not

- not ten live LLM instances;
- not evidence that a historical trade happened;
- not a backtesting engine or profit calculator;
- not a wallet, exchange, broker, or execution system;
- not able to place, sign, route, or settle orders.

The Desk is connected only to public, read-only Robinhood Chain RPC endpoints. It verifies factory provenance and reads each launch's current Pons state at the same snapshot block. A deterministic score can place supported ETH launches on the **WATCH** list; unsupported pairs, unsafe taxes, completed/rescued curves, malformed evidence, and unavailable reads receive an explicit **VETO**. WATCH is observation only, never an order or promise of market quality.

It is an open, deterministic reference implementation of the **ownership → handoff → veto → final decision** pattern. Use it to inspect and extend the coordination logic before connecting any external system.

## Development

```bash
npm install
npm test
npm run build
npm pack --dry-run
```

The only direct runtime dependency is `viem`, used to ABI-encode and decode pinned read-only Multicall3 requests. CI tests Node 18 and Node 20, and dependency audits run before release.

## Safety

Never put secrets or private keys into fixtures. This project has no live execution path. Any future integration that can publish, spend, sign, delete, or move money must remain behind explicit human approval and should be reviewed independently.

## License

MIT © [@immortalhowwl](https://x.com/immortalhowwl)

## Paper trading desk

Start with `npm run desk`, then open **http://127.0.0.1:4173/paper**. The original Desk and Target Dossier remain at `/`; TRACE, CREW, METHOD and VAULT retain their routes. The PAPER page is labeled **PAPER MODE / SIMULATED EXECUTION / NO REAL MONEY**. No wallet, private key or seed phrase is required. This feature cannot sign, broadcast, swap, or place real orders.

The virtual account starts at **$1,000 USD**. Experimental defaults are centralized in `src/paper.ts`:

| Setting | Default |
|---|---:|
| STARTING_BALANCE_USD | 1000 |
| MAX_POSITION_USD | 10 |
| MAX_OPEN_POSITIONS | 5 |
| STOP_LOSS_PERCENT | -10 |
| TAKE_PROFIT_PERCENT | 20 |
| MAX_DAILY_LOSS_USD | 50 |
| QUOTE_MAX_AGE_MS | 30000 |
| MONITOR_INTERVAL_MS | 15000 |

Configuration is copied into the persisted account when it is created. Editing defaults does not silently change an existing account's rules. Reset creates a new account with current defaults.

**Automatic paper flow:** `GPTHEIST WATCH → verified quote → paper risk checks → PAPER_ELIGIBLE → simulated buy → price tracking → exit`. All ten GPTHEIST handoffs must be present in order, with PASS from Rio, Lisbon, Palermo and Professor and no VETO anywhere. INFO from other stages stays INFO: the paper policy accepts WATCH without claiming that social quality has been verified. The research verdict remains WATCH; PAPER_ELIGIBLE is a separate paper result, recorded before the simulated buy. Replay results never enter this account.

**Quotes:** the adapter checks Robinhood Chain identity, fresh block time, factory provenance, curve/token/pair identity, active curve state and token decimals. Reads are pinned to one block and its hash is checked again before the quote is accepted. Sized prices use the integer arithmetic documented in the [official Pons v2 integration guide](https://docs.ponsfamily.com/v2#getting-a-quote), including separately rounded protocol fee, creator tax, opening buy tax and constant-product price impact. Exact token units are persisted for exits. A reserve ratio is shown only as the raw marginal reference price; fills use the sized output.

**USD conversion:** the server reads the public [Coinbase ETH-USD ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker). Buys use ask and sells use bid as USD conversion references, with the exchange's timestamp retained. Quote, block and USD source must all be at most 30 seconds old and not future-dated. There is no fixed-price fallback or API key. This is a USD valuation model, not a claim that a cross-chain ETH conversion was executed.

**Paper risk checks:** entry requires a completed WATCH, quote provenance, matching token/direction/size, sufficient real liquidity and cash, at most 5% modeled price impact, $10 maximum position size, no duplicate position, at most five open positions, and less than $50 gross realized losses during the UTC day. Each launch can be traded once; closed launches are not immediately re-bought. A risk rejection, missing quote or VETO is recorded with its reason. Existing saved account settings remain in effect.

**Supported markets:** native ETH Pons v2 curves only. Unsupported pairs, unavailable reads, changed watch conditions, stale prices, closed curves, partial fills and buys reaching graduation are rejected. Graduated Uniswap pools are not yet quoted. If a held token graduates, its position remains open with an explicit unavailable-quote reason and last-known valuation; the app does not invent an exit price.

**Fees and unknown costs:** modeled protocol/creator/opening fees and price impact are already included in the effective fill and are not charged twice. Gas and execution drift remain `null` and are excluded from P&L rather than assumed to be verified zero. Statistics disclose unknown costs. Paper buys do not alter on-chain reserves; the model does not simulate lasting market impact from its own positions.

**Monitor and exits:** every retained position is monitored before discovery, independently of whether it is still in the launch window. The monitor waits 15 seconds after each completed cycle; network latency adds to that interval. Fresh quotes for the full held quantity update P&L and simulate a sell at the observed quote when net return reaches −10% or +20%. These are observed thresholds, not guaranteed stop prices. Exits continue even when entries are blocked by the daily loss limit or discovery fails. Missing/stale quotes and RPC failures retain the last-known valuation and flag it unavailable; they never produce a $0 exit.

**Persistence:** `PAPER_DATA_DIR` selects the account directory (local fallback `runs/paper`). State uses schema version 2, kernel single-writer ownership, copy-on-write updates, fsync and atomic rename. Corruption fails closed. Recent account arrays are bounded; immutable linked archives preserve completed trades and accounting aggregates. `/api/paper/trades` provides bounded archive pages. Railway/configured durable directories refuse missing state unless `PAPER_INITIALIZE_NEW_ACCOUNT=true` explicitly authorizes a new account. Remove that variable after initialization. A properly mounted volume is required for redeploy persistence; attaching a volume does not recover ephemeral files. See [V5 migration instructions](reports/V5_RAILWAY_MIGRATION.md) before changing production.

To reset **only PAPER data**, stop the Desk, then run:

```bash
npm run build
node dist/src/cli.js paper-reset --confirm-paper-reset
npm run desk
```

The reset refuses a running account owner, saves `runs/paper/reset-backup-<timestamp>.json`, and restores $1,000 with empty positions/trades/history apart from the initial snapshot. It does not touch research logs or unrelated configuration. If state is corrupt, restore a valid backup before using the reset command. SIGINT/SIGTERM shut down the Desk and release the lock.

**Statistics (all persisted closed trades unless stated otherwise):**

- Equity = cash + last-known net position liquidation values; unrealized P&L = those values minus entry cost bases. Newly opened positions use entry value until an independent exit mark exists and are flagged unavailable.
- Realized P&L = sum of closed-trade net proceeds minus entry cost basis; total P&L = equity − starting balance; total return = total P&L / starting balance × 100.
- Wins/losses count strictly positive/negative P&L; breakevens remain in total trades. Win rate = wins / total trades × 100 (0 when empty).
- Gross profit = sum of winning P&L; gross loss = absolute sum of losing P&L. Net realized P&L = gross profit − gross loss.
- Average win/loss = corresponding P&L sum / corresponding count (average loss is negative). Profit factor = gross profit / gross loss. Expectancy = net realized P&L / total trades.
- Maximum drawdown = largest percentage decline from the running equity peak over **all** persisted snapshots; dollar drawdown is also returned. Stale-mark snapshots are flagged and cannot reveal unobserved intraperiod losses.
- Average holding time = mean(exit timestamp − entry timestamp), in milliseconds. Known estimated costs sum executed simulated entry/exit estimates, not repeated marks; unknown-fill counts are separate.
- Undefined averages, profit factor (including an all-win sample), and expectancy are `null` / `N/A`, never JSON Infinity. Losses and inconvenient history are not filtered out.

**UI and API:** `GET /api/paper` exposes the persisted account plus derived statistics, server uptime origin, and data status. It returns the most recent 100 trades/decisions and 200 events for display; calculations still use all stored results. It has no mutation endpoint. The PAPER layout is **`assets/desk/paper.html`**, its page-specific styling is **`assets/desk/paper.css`**, rendering/chart logic is **`assets/desk/paper.js`**, and shared fonts/colors/navigation are **`assets/desk/desk.css`**. Values/events use text nodes rather than HTML injection. The chart uses actual timestamped equity snapshots, including a truthful flat initial balance. Activity objects include timestamp, category, actual stage, token identity, event type, message and metadata.

Paper results do not guarantee real performance. This release provides a persistent account, monitor, risk/accounting engine, and live research audit UI; it supports automatic simulated curve trades after the separate quote and risk gates, without claiming a validated trading strategy or guaranteed real fills. Deterministic prices in the tests are fixtures only and cannot be imported through any endpoint.

Fresh-launch PAPER entries require verified launch/head block timestamps and a `LIVE`
launch event. Set `PAPER_MAX_LAUNCH_AGE_SECONDS` in the desk environment (default: 300
seconds; positive finite number). The setting is saved with the paper account and
can be overridden on startup. Missing chronology fails closed. Existing positions
keep their saved sizing and exit policies; passing the entry-age limit never causes
an exit.

Discovery retains its 25,000-block context window. The first successful scan is
`BACKFILL`; later scans mark only previously unseen launch events beyond the prior
observed head as `LIVE`. Repeated events and restarts are conservative backfill.
The PAPER table shows age in seconds at the verified head, event mode, and recent
traction. Traction compares pinned states no more than 300 seconds apart:
`VERIFIED` means reserve/progress changed (either direction), `WEAK` means those
endpoints are unchanged, and `UNKNOWN` means no valid comparison. Tax deltas are
reported separately. No trade counts, participant counts, volume, or exact last
activity times are inferred from those deltas.

Paper quote reliability: every production buy quote now includes an independent,
full-quantity sell quote. Entry rejects missing/stale round trips, unverified token
units, stale account valuations, and absent positive verified reserve/progress
changes. Launch provenance remains LIVE during observation within the same process;
startup backfills remain ineligible. Token quantities stay in raw bigint units.

`PAPER_QUOTE_REFRESH_MS` controls position refresh independently of discovery
(default 5000; minimum 1000). Quote jobs use concurrency two, per-token serialization,
RPC timeouts/retries and transient-failure backoff. Failed reads retain the previous
value as stale and cannot settle an exit. Gas and execution drift remain unknown.

The offline paper laboratory consumes captured `PAPER_LAB_FRAME` evidence, keeps
CONTROL/SELECTIVE/FAST_FAILURE/RUNNER portfolios separate, rejects future frames,
and rejects missing exact-size quotes instead of interpolating fills. Export frames
as a JSON array, then run `node scripts/paper-laboratory.mjs frames.json lab.json`.
Early captures can lack the sized quote tape and must not be treated as a fair
strategy-performance comparison. Laboratory settings do not modify the primary plan.

See [the reliability audit](PAPER_ENGINE_AUDIT.md) for numerical live examples,
contract-event cross-checks, test results, and remaining verification limitations.

**Entry curve FDV:** the paper tables display derived fully diluted valuation: decimal-normalized total token supply × pinned pre-buy curve reserve-ratio price. Pricing reserves include virtual reserves. This is separate from real ETH liquidity and full-position executable liquidation value; it is not a verified Pons displayed market cap. New quotes store `derivedFdvUsd`, `valuationBasis`, and raw/formatted supply. Older saved `marketCapUsd` values remain intact and are displayed as legacy curve FDV.

**Faster discovery and terminal activity:** `npm run desk` prints scan duration,
entry decisions and rejection reasons, simulated buys/sells and realized P&L.
Discovery defaults to a 4-second cadence measured from cycle start; slow cycles
never overlap. Position monitoring runs alongside discovery. Set
`PAPER_DISCOVERY_INTERVAL_MS` (minimum 1000) to change discovery cadence;
`PAPER_QUOTE_REFRESH_MS` independently controls exit quote refresh. For example:

```bash
PAPER_DISCOVERY_INTERVAL_MS=2000 PAPER_QUOTE_REFRESH_MS=2000 npm run desk
```

RPC latency, snapshot caching and rate limits still affect observed timing.
Fresh-launch, traction, liquidity and risk checks still apply. All fills are simulated.

The [paper entry pipeline improvements](SNIPING_IMPROVEMENTS.md) collect exit
liquidity evidence during inflow confirmation, size within full-exit coverage,
prioritize newer launches, and show current entry blockers on `/paper`. Faster
polling uses time-spaced momentum samples; cached snapshots do not repeat entry
work. These changes address missed-entry delays without claiming a profitable edge.

For the experimental higher-activity paper profile, use `PAPER_STRATEGY_MODE=SCALP`.
It qualifies earlier verified inflows, limits each token to 0.25% of equity, targets
3% net profit, and caps holding time at 90 seconds. `STRICT` retains v3 selection.
The dashboard tracks scalp v4 separately and preserves lifetime results. See the
[scalp rules and recorded-quote results](PAPER_SCALP.md); profitability is unproven.

V5 is one additional **experimental paper-only** mode, selected explicitly with `PAPER_STRATEGY_MODE=V5`; defaults remain STRICT and existing saved positions retain their strategy. It adds a liquidity survival gate, a conservative gap exposure cap, adaptive executable-profit trailing, and exact risk predicates. Read the [engineering report](reports/V5_ENGINEERING_REPORT.md) for verification and limitations. No profitability claim is supported yet. `npm run stress:v5` runs synthetic infrastructure load under a 384 MiB heap limit; it does not enforce a 1 GB container. Forward research tapes in `PAPER_DATA_DIR/research` are temporary, limited to 24 hours and 128 MiB. Critical trade archives are never pruned. Disable optional tape recording with `PAPER_RESEARCH_ENABLED=false`.

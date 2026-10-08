# GPTHEIST V5 implementation and verification

Implemented locally. No live execution, wallet, signing, transaction broadcasting, production deployment, git commit/push, account reset, production data recovery or V5 activation occurred. Defaults remain STRICT; selectable modes are exactly STRICT (V3), SCALP (V4), and V5. Existing historical labels and saved position plans remain valid.

## Repository audit

The machine-readable [symbol audit](v5-symbol-audit.txt) lists current exact file/function lines. Principal paths:

| Responsibility | File and function |
|---|---|
| Launch discovery, incremental logs, recent 24 launches | `src/live.ts`, `fetchLiveSnapshot`, `createLiveDiscoveryCache` |
| Pons verification, multicall, scoring | `src/market.ts`, `readPonsLaunchResearch`, `decodePonsMarketState`, `assessPonsLaunch` |
| Header verification and session retention | `src/launch-evidence.ts`, `launchEvidence` |
| Candidate traction, eligibility and final entry | `src/paper.ts`, `observeCandidateTraction`, `observeSnapshot`, `isPaperTradeEligible`, `preparePaperTrade`, `enterPaper` |
| Real/gross exit reserves, coverage, participation | `src/paper-liquidity.ts`, `sellObservation`, `ExitLiquiditySafetyGate` |
| Pricing reserves, exact full-quantity BUY/SELL, USD freshness | `src/paper-quotes.ts`, `readPaperQuote`, `readPaperExitQuote`, `PaperQuoteService` |
| Portfolio capacity and risk sizing | `src/paper-policy.ts`, `accountCapacity`, `proposeTradePlan` |
| Versioned V3/V4/V5 policy | `src/paper-strategy.ts`, `getPaperStrategy`, `entryQuality`, `entryExecutionQuality` |
| V5 survival, adaptive exits, exact risk predicates | `src/paper-v5.ts`, `LiquiditySurvivalGate`, `AdaptiveProfitExit`, `v5RiskTriggers` |
| Marks, emergency exits, distinct final SELL reads | `src/paper.ts`, `markPaperPosition`, `monitorPaper` |
| Persistence, recovery, locks, archive pagination/export | `src/paper-store.ts`, `PaperStore.open`, `write`, `update`, `historicalTrades`, `exportRecords`, `validatePaperState` |
| Candidate TTL, cache bounds and durable trade archives | `src/paper-retention.ts`, `retainPaperState`, `collectionCounts` |
| Polling, quote deduplication, timers, shutdown | `src/paper-service.ts`, `start`, `tick`, `monitor`, `close` |
| RPC retries/timeouts/read-only allowlist | `src/server.ts`, `createHttpRpcCaller`; `src/runtime-limits.ts`, `WorkLimiter` |
| Health, memory and event-loop telemetry | `src/runtime-limits.ts`, `MemoryHealth`; `PaperService.reportMemory`, `health` |
| Dashboard routes and data | `src/server.ts`, `createDeskServer`; `assets/desk/paper.js`, `sync`, `render` |
| Gas and fees | `src/paper-gas.ts`, `PaperGasCounter`; `roundTripLossPercent`, `performance` |
| Bounded forward research tape | `src/paper-forward.ts`, `ForwardRecorder` |
| Prior laboratory and replay | `src/paper-laboratory.ts`, existing `scripts/paper-strategy-replay.mjs`; new exact two-mode `scripts/v5-replay.mjs` |
| Tests | TypeScript compilation followed by Node test runner, `tests/*.test.ts` |

## Retention and memory findings

A read-only inspection of the existing local `runs/paper/state.json` found 3,057 watch candidates, 5,102 research ledger rows, 500 decisions and 2,000 events. Serialized watchlist occupied approximately 15.10 MB, decisions 7.53 MB, events 4.30 MB, ledger 2.28 MB and traction histories 1.25 MB. These are serialized component sizes, not heap allocation measurements or current Railway telemetry. [Raw inspection](v5-retention-audit.json).

The largest observed retained payload is candidate/watchlist state, not the largest source file. Quote evidence is duplicated within plans, decisions, positions and events. `store.read()` clones state; updates clone then stringify it; dashboard reads previously cloned and serialized the same retained payload. These transient allocations explain why source size is a poor proxy for RSS. Actual live Railway per-module heap attribution was not available. No production heap snapshot was taken.

Changes:

- TTL and newest-first candidate caps, maximum 100 observations per candidate, configurable recent decision/quote-sample limits, 200 events, 100 resident completed trades, 250 equity samples.
- Inactive ledger rows bounded independently; recent traded tombstones are protected until the original launch eligibility window expires, preventing duplicate fills after archival. Active position plans/current/peak/exit observations are protected.
- Duplicate unchanged rejection/quote failure events aggregate first/last timestamps and occurrence count. Reasons that change still produce transitions. Normal scan logging is limited to once per minute; verbose logging is explicit.
- RPC concurrency/pending admission/queue deadlines bounded. Up to two reserved critical RPC slots; dedicated SELL quote lane separate from entry work. Same quote requests coalesce, same-token work serializes, scheduler prevents per-position overlapping monitor jobs. Existing finite HTTP retries/abort deadlines remain.
- Native Node fetch connection reuse retained; no new polling loop per candidate. Session header/observation maps capped at 512/1,024. Existing block-window discovery and USD/header caches remain bounded.
- Memory telemetry samples every 30 seconds: RSS, heap, external, array buffers, event-loop mean delay, counts, timers and pending work. Warning 700 MiB, critical 850 MiB. Cleanup preserves positions; critical pressure pauses candidate admission and sheds inactive caches; durable state is flushed through the sole store. No automatic kill or risk bypass.
- Dashboard fetch interval increases from one to five seconds while its local clock continues every second. Quote monitoring cadence is unchanged.

Shared infrastructure bounds can change candidate admission under saturation. V3/V4 strategy thresholds and saved exit behavior remain unchanged; existing tests pass. This is not a claim that overload shedding produces identical candidate opportunity sets.

## Durable persistence

The likely reset mechanism is the default relative `runs/paper` path on an ephemeral Railway container. Actual production mount configuration could not be inspected. `PAPER_DATA_DIR` now overrides that path. Missing storage fails closed on Railway or configured persistent paths unless new account initialization is explicit. Existing corruption, atomic rename/fsync and schema migration logic is retained. There is one flock owner and a bounded serialized update queue; no second paper account writer.

Resident trade history is paginated through immutable linked archive pages. Accounting aggregates preserve cash/P&L, daily loss and strategy loss-streak controls. Read failure never resets the account. Authenticated streaming export includes the state snapshot and referenced immutable archives; offline restore validates schema, archive completeness and hashes in a new directory without starting an account. The standalone read-only backup script can run in an existing container without deploying this change. [Safe operator migration procedure](V5_RAILWAY_MIGRATION.md).

## Single unified V5

V5 reuses all genuine full-position SELL protections. Entry requires three verified, spaced reserve observations, 30 seconds of full-exit liquidity evidence, majority-safe real reserve share of at least 30%, positive reserve persistence, at most 2% observed reserve drawdown, quote-backed momentum sufficient for friction, maximum 3% modeled round-trip loss, known gas estimate and impact, verified age and score evidence. It reports structured APPROVED / REJECTED / MORE_EVIDENCE_REQUIRED with reserve velocity, acceleration, drawdown and observation span. Acceleration is a diagnostic, not an invented forecast or independently tuned filter. Score remains a deterministic input, not a guarantee. Low FDV is not itself a rejection.

Sizing keeps cash, portfolio exposure, coverage, participation, impact and account risk checks. A fixed 2% equity token cap bounds total-loss gap exposure independently of a 5% downside threshold. It never increases size to recover losses. At a $50 account, gas and the $1 minimum ticket can leave no eligible size; V5 deliberately reports the sizing blocker rather than enlarging risk.

Profit management arms at 2% net executable return. Verified growing liquidation and nondecreasing real reserve allow a 3–5% liquidation trail and a 25%-of-peak profit floor. Weak momentum tightens the trail to 1.5% and the floor to 50% of peak, with a 0.5% minimum floor. No fixed V4-style take-profit target exists for V5. Maximum hold is 180 seconds; nonpositive stagnation limit is 60 seconds. Graduation, rising taxes and sell impact retain protection. This is one experimental integrated policy, not multiple variants.

Emergency monitoring immediately records reserve peak drawdown >=8%, verified >=5% outflow in <=10 seconds, >=10% executable value collapse, coverage/participation breaches and real reserve insufficiency. Multiple predicates retain their exact names/values. Quote failure/staleness creates a pending exit, never a fabricated fill. Exits require a separate fresh exact full-position final SELL quote. The 5% downside limit is a trigger; gaps and outages can still cause much larger realized losses.

## Costs and FOMOPAD

The existing model charges 200,000 assumed swap gas units at a fresh chain gas price and records source/time/model. It does not claim actual transaction gas usage. Exact-path `eth_estimateGas` is not implemented: quote methods are read-only calculator/lens calls, and an exact executable transaction with a funded sender/approval state is not established. Guessing a sender or transaction would not be a valid estimate. Gas stays modeled and unknown when unavailable; V5 refuses unknown gas at entry. Fees/impact are embedded in notionals; gas is charged once per side; unknown slippage stays null. Existing fee/gas reconciliation tests pass.

For the described FOMOPAD evidence, a verified 11.6% reserve drop crosses the 10% shared deterioration threshold regardless of 3,800x coverage and zero failed quotes. The 30-second observation span is an **entry confirmation** requirement, not a prerequisite for immediate open-position emergency risk. Source `markPaperPosition` independently evaluates the prior-reserve drop and `COLLAPSING` behavior. No exact FOMOPAD trade record was located in the specifically inspected local tapes/state artifacts, so the historical trigger is a source-supported explanation, not independently verified recovery of that trade. V5 now records exact reserve predicates rather than inferring insufficient liquidity.

## Forward research and comparison

The sole service records chronological actual snapshot/BUY/SELL frames in separate optional research JSONL files, capped to 24 hours/128 MiB with at most two pending writes and 2 MiB per frame. It does not generate prices. Critical completed trade records remain permanent. Memory pressure suspends optional recording, and skipped-frame counts expose gaps. Entry evidence and MFE/MAE/current/peak/final quote evidence remain in position/trade records. No additional post-exit quote polling was added; post-exit continuation is available only if a later actual exact-quantity quote was captured. This remains a data limitation.

The new replay compares exactly SCALP V4 and V5 with independent cash/exposure/concurrency, chronological source frames, exact-size buy availability and exact-unit SELL reads. Each exit consumes a distinct final read. Missing alternative-size or post-exit data marks results incomplete. No interpolation, reused V4 exit as a hypothetical later V5 exit, or synthetic profitability claim.

Local `runs/scalp-v4/current-tape.json` contains nine trades and 100 quote rows. All nine saved plans are V3, despite the directory name; there are no quote observations after those original exits. It is not a measured V4 cohort or verified current Railway export and does not provide a complete candidate arrival/opportunity tape. [Research status](v5-research.json). No credible V5 profitability or improvement claim can be made; the supplied 86-trade checkpoint remains a user-supplied historical reference, not a newly measured baseline.

| Requested metric | Verified V4 cohort | V5 comparable cohort |
|---|---|---|
| Closed trades / win rate / P&L / profit factor / expectancy | unavailable | incomplete |
| Average winner / loser / worst loss / maximum drawdown | unavailable | incomplete |
| Average hold / catastrophic losses | unavailable | incomplete |
| Estimated gas / known fees / missing slippage | unavailable | incomplete |

## Verification and readiness

`npm test` passed all **238 tests**, including TypeScript compilation, in approximately 20 seconds. [Test summary](v5-tests.json) and [full test log](v5-tests.log). JavaScript syntax checks and `git diff --check` passed. An isolated temporary-account standalone backup/restore drill was also performed; no real account was opened or modified. See the accompanying [machine-readable stress result](v5-memory-stress.json). Automated checks cover V3/V4 compatibility, V5 selection/entry/exit/quotes, reserve emergency despite high coverage, missing quote no-fill behavior, corruption, atomic persistence/restart, single ownership, authenticated export, explicit initialization, candidate expiration, bounded observation arrays, rejection aggregation, RPC concurrency/priority/deadlines, pressure cleanup, retained active state, archive pagination and bounded forward recording.

Final stress run: **61.05 seconds**, **440 accelerated scanner cycles**, **5,280 synthetic launches**, **1 verified restart**, 128 active candidates, 12,800 observations, five open positions and a full 100-trade resident historical page. RSS: **85.1 MiB initial**, **420.4 MiB peak**, **411.5 MiB sustained**, **410.7 MiB final**. Final heap used **149.3 MiB**, external **2.3 MiB**, sampled mean event-loop delay **109.6 ms**. Maximum queued simulated RPC requests was **32** and the queue drained. All five active positions and account recovery survived. Resident collections plateaued at their bounds. The aggressive serialization loop produced noticeable event-loop delay; real dashboard/network timing still needs staging measurement.

The infrastructure stress harness uses synthetic launches/quote updates only, retained paper positions/history, saturated candidates, repeated rejections, dashboard-equivalent serialization, timed/simulated RPC failures and restart recovery. It runs with `--max-old-space-size=384`. Codespaces cgroup memory.max is `max`; **no 1 GB container limit was enforced**. A minute-scale local run and accelerated simulated scanner time do not establish days-long production stability. Perform staging load/restart validation under an actual 1,024 MiB cgroup before deployment.

Local experimental paper evaluation is ready. Production cutover is not verified: backup/access, volume restoration, staging restart preservation, actual container RAM test and forward performance evidence remain required. V5 is not automatically enabled and profitability is unproven.

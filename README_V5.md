# GPTHEIST V5 — setup and operation

GPTHEIST V5 is one experimental paper-trading strategy for the existing GPTHEIST dashboard. It reads Robinhood Chain launch data and executable quotes, applies risk gates, and records simulated buys and sells. It has no wallet, private keys, signing, or real transaction broadcasting.

This guide covers the local Codespaces setup. V5 is already enabled for the account in this workspace. The commands below explain how to reproduce the setup without resetting that account. No production deployment is required.

## 1. Requirements

- A checkout containing the V5 implementation, including `src/paper-v5.ts`.
- Node.js 18 or newer and npm.
- Linux with build tools for the native `fs-ext` dependency; Codespaces provides the development environment.
- Network access to the read-only RPC and ETH/USD sources.
- One Desk process per paper-account directory.

Run commands from the repository root. Local changes that have not been committed or pushed will not appear in a fresh GitHub clone.

## 2. Install and build

If a Desk is already running, stop it through the terminal that launched it with **Ctrl+C**, then wait for shutdown to finish. Closing the HTTP listener can happen before the paper writer releases its lock; wait for the process to exit before starting another instance.

```bash
npm ci
npm run build
```

`npm start` runs the compiled application; it does not rebuild it. Use `npm run build` after changing TypeScript. `npm run desk` builds before starting the Desk.

## 3. Start V5 in Codespaces

Reuse the existing account at `runs/paper`:

```bash
PAPER_STRATEGY_MODE=V5 node --max-old-space-size=384 dist/src/cli.js desk --host 0.0.0.0 --port 4173
```

Keep this terminal running. In Codespaces:

1. Open the **Ports** tab.
2. Forward port **4173** if it is not already listed.
3. Keep the forwarded port **Private**.
4. Open the forwarded URL and navigate to `/paper`.

For a shell session in which subsequent starts should select V5:

```bash
export PAPER_STRATEGY_MODE=V5
npm run desk -- --host 0.0.0.0 --port 4173
```

The heap limit is applied by the direct Node command above. `npm run desk` does not add that limit unless you set `NODE_OPTIONS=--max-old-space-size=384` in that shell. Do not run both commands simultaneously.

The application reads shell environment variables. It does **not** automatically read a `.env` file. An exported variable lasts for that shell session; explicit strategy selection is also saved in the account configuration after successful startup. An unset strategy variable retains the saved account mode. New accounts default to STRICT unless V5 is explicitly selected.

## 4. Verify the engine

In another terminal:

```bash
curl --fail --silent http://127.0.0.1:4173/health
curl --fail --silent http://127.0.0.1:4173/api/paper
```

The paper response should include:

```json
{
  "mode": "PAPER",
  "execution": "SIMULATED",
  "config": {
    "PAPER_STRATEGY_VERSION": 5
  },
  "entryDiagnostics": {
    "strategyMode": "V5"
  }
}
```

This example shows selected fields, not the entire response. Confirm the dashboard shows V5, expected cash/history, and a recent successful durable write. Quote availability and scan status depend on upstream connectivity; an HTTP 200 alone does not prove fresh quotes.

## 5. Strategy modes and behavior

| Mode | Strategy |
|---|---|
| `STRICT` | Existing V3 |
| `SCALP` | Existing V4 |
| `V5` | One unified V5 strategy |

Select a mode through `PAPER_STRATEGY_MODE` at startup. There are no V5 variants. Existing open positions retain the strategy plan saved at entry; changing the mode affects new entries.

V5 requires verified reserve persistence, fresh exact full-position sell quotes, sufficient real exit reserves/coverage, acceptable participation/impact and modeled execution costs. It caps token exposure at 2% of equity, uses adaptive profit protection rather than a fixed profit target, and records exact reserve/executable-price risk predicates. Ordinary downside triggers at 5%; reserve emergencies act immediately when verified. A trigger cannot guarantee its eventual exit price. Profit protection arms at 2% net executable profitability; maximum holding time is 180 seconds.

At roughly $50 equity, the 2% cap is about $1 before gas. The default minimum position is $1, so gas or risk sizing can make the account too small for a valid entry. The dashboard may report `ACCOUNT_TOO_SMALL_FOR_STRATEGY` or an account-sizing blocker. Do not increase risk limits simply to force trades. No trades can also mean insufficient fresh evidence, high friction, unstable reserves, or a loss-streak pause.

## 6. Account storage and initialization

Default local account directory:

```text
runs/paper/
  state.json                 # cash, configuration, open positions and recent history
  writer.lock                # permanent inode used for exclusive writer ownership
  audit-archive-*.json        # immutable linked historical trade/audit pages
  research/research-*.jsonl   # temporary chronological research observations
```

Historical trades can be paged through `/api/paper/trades`. Old trades archived off the resident dashboard remain on disk. Critical account state uses atomic writes, fsync, corruption checks and exclusive writer ownership. Temporary research tapes are limited to 24 hours and 128 MiB; these limits do not delete closed-trade archives.

To select an **existing** account directory:

```bash
PAPER_DATA_DIR=/absolute/path/to/existing/paper \
PAPER_STRATEGY_MODE=V5 \
node --max-old-space-size=384 dist/src/cli.js desk --host 0.0.0.0 --port 4173
```

The directory must contain its state and all linked archives. Merely changing the path does not move account data. A configured data path with missing state fails closed.

Only for a deliberately **new, empty** paper account:

```bash
PAPER_DATA_DIR=/absolute/path/to/new-paper-account \
PAPER_INITIALIZE_NEW_ACCOUNT=true \
PAPER_STRATEGY_MODE=V5 \
node --max-old-space-size=384 dist/src/cli.js desk --host 0.0.0.0 --port 4173
```

A new account defaults to $1,000. On subsequent starts, omit `PAPER_INITIALIZE_NEW_ACCOUNT`. Never use that variable as a remedy for missing historical data. Do not use the dashboard reset controls to resolve a startup error.

## 7. Back up and verify locally

The read-only backup utility reads a consistent critical-state snapshot and its linked immutable archives. It does not start another account writer:

```bash
umask 077
node scripts/v5-readonly-backup.mjs > paper-backup.ndjson
sha256sum paper-backup.ndjson
node scripts/v5-restore-export.mjs paper-backup.ndjson /tmp/gptheist-verified-backup
```

Choose a new restore directory each time; the restore utility refuses an existing directory. It validates the restored account, archive chain and a hash manifest without starting a trading engine. An incomplete export or failed validation is not a verified backup. Keep private backup copies outside the account directory. The export covers critical state and referenced archives; optional research files and older unreferenced migration/reset backups require separate copying if needed.

For another existing account path, prefix the backup command with `PAPER_DATA_DIR=/absolute/path/to/paper`. The utility does not modify the source account. A running account can continue producing later fills after the snapshot; stop the writer and capture a final backup before moving/restoring the account.

An authenticated HTTP export is also available at `GET /api/paper/export` when `PAPER_EXPORT_TOKEN` is configured. It requires a Bearer token. The endpoint is disabled without that token. Keep tokens and account exports private; the local backup utility needs no token.

## 8. Configuration

Values below are code defaults; existing accounts may have persisted overrides.

| Variable | Default | Purpose |
|---|---|---|
| `PAPER_STRATEGY_MODE` | Saved account mode; STRICT for new accounts | STRICT, SCALP or V5 |
| `PAPER_DATA_DIR` | `runs/paper` under the working directory | Account directory |
| `PAPER_REQUIRE_EXPLICIT_INIT` | Unset locally | `true` refuses missing state unless initialization is explicit |
| `PAPER_DISCOVERY_INTERVAL_MS` | 4000 | Discovery cadence; minimum 1000 |
| `PAPER_QUOTE_REFRESH_MS` | 5000 | Position refresh; minimum 1000; persisted account may differ |
| `PAPER_MAX_LAUNCH_AGE_SECONDS` | 300 | Maximum eligible launch age |
| `PAPER_MAX_CANDIDATES` | 128 | Bound inactive-entry candidate tracking |
| `PAPER_MAX_OBSERVATIONS` | 100 | Observations per candidate; range 10–100 |
| `PAPER_MAX_REJECTIONS` | 100 | Recent candidate decisions; range 25–200 |
| `PAPER_MAX_QUOTE_SAMPLES` | 128 | Pending research quote samples; range 10–256 |
| `PAPER_RPC_CONCURRENCY` | 6 | Bounded RPC work with reserved exit capacity |
| `PAPER_MAX_PENDING_RPC` | 128 | Maximum queued RPC work |
| `PAPER_RESEARCH_ENABLED` | Enabled | `false` disables optional research recording |
| `PAPER_DEBUG_LOG` | Disabled | `true` enables per-scan detail |
| `RPC_URL` | Built-in read-only endpoints | Optional comma-separated RPC endpoints |
| `PAPER_EXPORT_TOKEN` | Unset | Enables authenticated private export |

For example, keep V5 and use a two-second quote refresh:

```bash
PAPER_STRATEGY_MODE=V5 PAPER_QUOTE_REFRESH_MS=2000 \
node --max-old-space-size=384 dist/src/cli.js desk --host 0.0.0.0 --port 4173
```

Faster intervals do not manufacture independent observations or bypass quote freshness/risk protections. RPC latency and source limits still affect actual timing.

## 9. Troubleshooting

### Legacy PID-only ownership error

The account lock predates kernel flock ownership. Back up the state and confirm the old runtime is stopped. Only then use the one-time migration acknowledgement:

```bash
PAPER_LEGACY_OWNER_STOPPED=true PAPER_STRATEGY_MODE=V5 \
node --max-old-space-size=384 dist/src/cli.js desk --host 0.0.0.0 --port 4173
```

After successful migration, the lock contains `GPTHEIST_FLOCK_V1`; omit the acknowledgement on future starts. The local account in this workspace has already been migrated. Do not delete the lock file: replacing its inode can allow two writers.

### Account already owned by a running process

Another process still holds the writer lock, possibly while finishing shutdown. Wait for it to exit, then start exactly one Desk. Changing ports does not allow a second writer for the same account.

### Missing state or invalid paper state

Check the working directory and `PAPER_DATA_DIR`. Recover from a verified backup with the writer stopped. Do not reset, delete storage, or initialize a new account over an account you intend to preserve.

### Address already in use

Port 4173 is occupied. Reuse the existing Desk or stop its process before restarting. Only use another port if it will not create a duplicate writer.

### V5 selected but no paper entries

Inspect entry blockers, observation duration, reserve behavior, quote freshness, gas estimates and account sizing. Early historical discovery is classified as backfill; it is not automatically eligible as a fresh launch. Profitability and trade frequency are not guaranteed.

### Stale or unavailable sell quotes

The engine preserves the position and its last-known value. It cannot create a fill without a fresh exact full-position sell quote. Pending exits may survive outages; dashboard values should be read with their freshness status.

## 10. Tests, stress and replay

```bash
npm test
npm run stress:v5
```

The stress harness uses synthetic observations for infrastructure testing only, a 384 MiB heap limit, bounded candidates/requests, active paper positions, a resident trade-history page and restart recovery. It does not establish profitability or enforce a 1 GB container RAM limit.

For a longer infrastructure run:

```bash
STRESS_SECONDS=300 npm run stress:v5
```

Replay requires chronological actual market frames, not a closed-trade summary. Select the required files from `runs/paper/research` in chronological order and provide a separate output path:

```bash
npm run build
node scripts/v5-replay.mjs chronological-frames.jsonl reports/my-v4-v5-replay.json
```

The replay compares exactly V4 SCALP and V5. Missing exact-size BUY quotes, exact-quantity SELL quotes, later observations or recorded frame gaps make the comparison incomplete. Start equity defaults to $50 and can be set with `REPLAY_STARTING_EQUITY`. Unknown slippage is not treated as zero. Gas is modeled using assumed swap units and fresh chain gas prices; actual transaction gas usage is not measured.

## Verification and further reading

The local implementation passed 238 automated tests. The recorded synthetic infrastructure run peaked at approximately 420 MiB RSS and averaged 412 MiB sustained RSS under a 384 MiB heap limit. These are test results, not guarantees for all workloads or proof of a 1 GB production deployment.

- [Engineering report](reports/V5_ENGINEERING_REPORT.md)
- [Test results](reports/v5-tests.json)
- [Stress results](reports/v5-memory-stress.json)
- [Research limitations](reports/v5-research.json)
- [Optional Railway migration guide](reports/V5_RAILWAY_MIGRATION.md)

V5 profitability and improvement over V4 have not been verified with a complete comparable dataset. Use paper trading to collect evidence before drawing performance conclusions.

# Safe Railway preservation and migration — operator procedure only

No production changes, remote account reads, restart, redeploy, commit or push were performed. No production backup has been verified. Repository artifacts are not evidence of current Railway balances.

## Preserve the existing process first

1. Identify the exact running project, service, environment and deployment instance in Railway. Inspect the actual working directory, configured path and volume status through existing authenticated operator access. Do not change variables yet: variable/volume changes can trigger deployments.
2. The inspected source has public `/api/paper` and paginated `/api/paper/trades`, but no pre-existing complete authenticated export. Public dashboard JSON is a partial account view and is not a complete backup. Do not deploy the new export endpoint just to retrieve existing ephemeral data.
3. If existing Railway SSH access is available, the standalone backup script can run in the OLD container without installing code or opening another account writer. It reads one atomic `state.json` snapshot and its immutable archive chain. From an already authenticated, correctly linked operator machine:

   ```bash
   umask 077
   railway ssh -- node --input-type=module < scripts/v5-readonly-backup.mjs > railway-paper-backup.ndjson
   sha256sum railway-paper-backup.ndjson
   node scripts/v5-restore-export.mjs railway-paper-backup.ndjson /tmp/railway-paper-verified-restore
   ```

   Verify the SSH target first. The remote script respects remote `PAPER_DATA_DIR`, otherwise the running container's `cwd/runs/paper`. If the old runtime used another path, supply that verified path explicitly in the script before running it. These commands are documented, not executed against production here.
4. A successful command exit plus successful offline validation is required. Compare cash, open positions, recent trades, archived accounting aggregates, creation time and linked archive record hashes against the existing dashboard. Retain two private copies off Railway. A backup is a point-in-time snapshot: subsequent paper fills are not included.
5. If no authenticated SSH/filesystem access or safe existing export exists, preservation remains blocked by missing access. Keep the old service running. Do not attach a volume or restart on the assumption that old ephemeral files will migrate.

[Railway SSH documentation](https://docs.railway.com/cli/ssh) documents noninteractive command execution and clean piped input. `railway run` runs locally and does not retrieve the running container's files.

## Future authenticated endpoint

Locally implemented `GET /api/paper/export` is disabled unless `PAPER_EXPORT_TOKEN` is configured. It requires `Authorization: Bearer <token>` and streams NDJSON containing the critical state plus every linked immutable archive. It excludes process environment and credentials; do not publish the token or backup. Set the token through Railway's secret environment configuration only after preservation is understood; this is not authorization to deploy now. Use HTTPS. Verify the resulting export offline with the restore utility. Temporary research tapes and old unreferenced reset/schema backups are outside the critical export; retrieve these separately if needed for research/audit.

## Durable mount and cutover

After verified backup and explicit operator-controlled cutover:

- Provision a Railway volume mounted at `/data`, restore the validated account and **all referenced archives** into `/data/paper`, and set `PAPER_DATA_DIR=/data/paper`.
- Attaching a volume does not copy old files. Railway volumes are available at runtime, not build/predeploy. Arrange an offline restore/upload to the volume before enabling the sole account writer. Do not depend on a build step to restore volume data.
- Stop the old account writer at cutover, capture and verify its final snapshot if fills continued, then restore that final state. Never run two account writers. Keep one service instance and one Node worker per account; filesystem flock is not a distributed database lock.
- Preserve the existing STRICT/SCALP mode. Do not set V5 automatically. Restored configuration and per-position saved plans preserve existing exits. Set `PAPER_REQUIRE_EXPLICIT_INIT=true`. Leave `PAPER_INITIALIZE_NEW_ACCOUNT` unset. Only a deliberately new empty account may use that flag once; remove it immediately afterward.
- A legacy PID-only `writer.lock` requires an established stop of its former runtime and the existing one-time `PAPER_LEGACY_OWNER_STOPPED=true` migration flag. Never guess that a running owner is dead.
- The proposed start command is `node --max-old-space-size=384 dist/src/cli.js desk --host 0.0.0.0 --port $PORT`. This heap setting was tested locally under synthetic load. It is not a 1 GB container certification.
- Check health, durable write timestamp, restored cash/positions, ledger reconciliation, archive pagination and quote freshness. Conduct an operator-approved restart/redeploy preservation drill on a copied staging account first. Keep rollback backups private and restore only while the writer is stopped.

[Railway volume guide](https://docs.railway.com/volumes) explains mount paths and runtime availability. [Railway backups](https://docs.railway.com/volumes/backups) describes scheduled backups and restore behavior. No volume or backup was created here.

## Configuration

| Setting | Default / purpose |
|---|---|
| PAPER_DATA_DIR | Local `runs/paper`; use a verified volume path in Railway |
| PAPER_STRATEGY_MODE | Unset retains account mode; STRICT / SCALP / V5 only |
| PAPER_REQUIRE_EXPLICIT_INIT | true recommended; Railway and configured data paths already protect missing state |
| PAPER_INITIALIZE_NEW_ACCOUNT | unset; explicit first-account creation only |
| PAPER_EXPORT_TOKEN | unset disables authenticated export |
| PAPER_MAX_CANDIDATES | 128 inactive-entry watch candidates; open positions protected |
| PAPER_MAX_OBSERVATIONS | 100, range 10–100 |
| PAPER_MAX_REJECTIONS | 100 recent decisions, range 25–200 |
| PAPER_MAX_QUOTE_SAMPLES | 128 pending research samples, range 10–256 |
| PAPER_RPC_CONCURRENCY | 6, range 2–16; reserve up to two slots for exits |
| PAPER_MAX_PENDING_RPC | 128, range 16–256 |
| PAPER_RESEARCH_ENABLED | true; false disables optional research recording |
| PAPER_DEBUG_LOG | false; true enables per-scan detail |

Monitor volume utilization. Critical trade archives intentionally grow durably and are never deleted. Temporary research tapes are pruned independently to 24 hours/128 MiB. Keep automated volume backups and independent exports; backups on an ephemeral filesystem do not survive its loss.

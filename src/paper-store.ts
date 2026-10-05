import { unknownLaunchEvidence } from "./launch-evidence.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureSafeAuditDirectory } from "./simulation.js";
import { PAPER_CONFIG, accountSummary, initialPaperState, quoteProblem, type PaperState } from "./paper.js";

import { EXIT_REASONS, initialManagement, proposeTradePlan } from "./paper-policy.js";

/** Reject corruption; never silently replace an existing account with a new one. */
export function validatePaperState(value: unknown): asserts value is PaperState {
  const s = value as PaperState;
  const finiteTree = (v: unknown): boolean => typeof v === "number" ? Number.isFinite(v) :
    Array.isArray(v) ? v.every(finiteTree) : v !== null && typeof v === "object" ? Object.values(v).every(finiteTree) : true;
  try {
    if (!s || s.schemaVersion !== 2 || s.mode !== "PAPER" || !finiteTree(s) || !Number.isFinite(Date.parse(s.createdAt))) throw new Error();
    initialPaperState(Date.parse(s.createdAt), s.config);
    if (![s.positions, s.trades, s.history, s.events, s.decisions].every(Array.isArray) || !s.history.length || !Number.isFinite(s.cash) || s.cash < 0) throw new Error();
    const ids = new Set<string>(), tokens = new Set<string>();
    for (const p of [...s.positions, ...s.trades]) {
      if (!p.id || ids.has(p.id) || p.mode !== "PAPER" || p.execution !== "SIMULATED" ||
          !/^0x[0-9a-f]{40}$/i.test(p.tokenAddress) || p.quantity <= 0 || p.sizeUsd <= 0 || p.costBasisUsd <= 0 ||
          ![p.quantity, p.sizeUsd, p.costBasisUsd].every(Number.isFinite) ||
          !p.plan || p.plan.version !== 1 || !Array.isArray(p.plan.riskReasons) || !Array.isArray(p.plan.reasoning) ||
          ![p.plan.riskBudgetUsd, p.plan.approvedSizeUsd, p.plan.exitPolicy.downsidePercent, p.plan.exitPolicy.profitArmPercent,
            p.plan.exitPolicy.trailingDrawdownPercent, p.plan.exitPolicy.maxHoldMs, p.plan.exitPolicy.reserveDropPercent,
            p.plan.exitPolicy.taxIncreaseBps, p.plan.exitPolicy.maxExitImpactPercent, p.plan.exitPolicy.graduationProgressBps].every(v => Number.isFinite(v) && v > 0) ||
          p.plan.exitPolicy.downsidePercent >= 100 || Math.abs(p.plan.approvedSizeUsd - p.sizeUsd) > 1e-8 ||
          (p.plan.exitPolicy.takeProfitPercent !== undefined && (!Number.isFinite(p.plan.exitPolicy.takeProfitPercent) || p.plan.exitPolicy.takeProfitPercent <= 0)) ||
          !p.management || !Number.isSafeInteger(p.management.quoteFailureCount) || p.management.quoteFailureCount < 0 ||
          (p.management.peakLiquidationValueUsd !== null && (!Number.isFinite(p.management.peakLiquidationValueUsd) || p.management.peakLiquidationValueUsd <= 0)) ||
          !Number.isFinite(Date.parse(p.enteredAt)) || p.entry.side !== "BUY" ||
          quoteProblem(p.entry, Date.parse(p.entry.timestamp), Number.MAX_SAFE_INTEGER) ||
          quoteProblem(p.current, Date.parse(p.current.timestamp), Number.MAX_SAFE_INTEGER) ||
          p.entry.tokenAddress.toLowerCase() !== p.tokenAddress.toLowerCase() || p.current.tokenAddress.toLowerCase() !== p.tokenAddress.toLowerCase() ||
          Math.abs(p.entry.quantity - p.quantity) > p.quantity * 1e-10 ||
          Math.abs(p.costBasisUsd - p.sizeUsd - (p.entry.costs.gasUsd ?? 0)) > 1e-7) throw new Error();
      ids.add(p.id);
    }
    for (const p of s.positions) { const token = p.tokenAddress.toLowerCase(); if (tokens.has(token)) throw new Error(); tokens.add(token); }
    for (const t of s.trades) {
      if (!Number.isFinite(Date.parse(t.exitedAt)) || Date.parse(t.exitedAt) < Date.parse(t.enteredAt) || t.exit.side !== "SELL" ||
          quoteProblem(t.exit, Date.parse(t.exit.timestamp), Number.MAX_SAFE_INTEGER) ||
          ![...EXIT_REASONS, "STOP_LOSS", "TAKE_PROFIT"].includes(t.exitReason) ||
          Math.abs(t.pnlUsd - (t.exit.notionalUsd - (t.exit.costs.gasUsd ?? 0) - t.costBasisUsd)) > 1e-7) throw new Error();
    }
    if (s.history.some(h => !Number.isFinite(Date.parse(h.timestamp)) || h.equity < 0)) throw new Error();
    const a = accountSummary(s);
    if (!finiteTree(a) || Math.abs(a.totalPnl - a.realizedPnl - a.unrealizedPnl) > 1e-6) throw new Error();
  } catch { throw new Error("Invalid paper state; refusing to reset or trade. Restore a valid backup or explicitly reset PAPER data."); }
}
async function readSafe(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!(await handle.stat()).isFile()) throw new Error("Paper storage must be a regular file"); return await handle.readFile("utf8"); }
  finally { await handle.close(); }
}
function code(error: unknown): string | undefined { return error instanceof Error && "code" in error ? String(error.code) : undefined; }
const LINUX_PROC_TICKS_PER_SECOND = 100;
async function processIdentity(pid: number): Promise<{ startTicks: string; startedAtMs: number }> {
  const [processStat, systemStat] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/stat", "utf8")]);
  const fields = processStat.slice(processStat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error("Unable to verify paper lock process identity");
  const bootTime = Number(systemStat.match(/^btime (\d+)$/m)?.[1]);
  if (!Number.isFinite(bootTime)) throw new Error("Unable to verify paper lock process identity");
  return { startTicks, startedAtMs: bootTime * 1000 + Number(startTicks) * 1000 / LINUX_PROC_TICKS_PER_SECOND };
}
export class PaperStore {
  private tail: Promise<void> = Promise.resolve();
  private constructor(readonly directory: string, private state: PaperState) {}
  static async open(directory: string): Promise<PaperStore> {
    const root = await ensureSafeAuditDirectory(directory), lock = resolve(root, "writer.lock");
    // Linux process start time distinguishes a restarted container's reused PID from its former owner.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { startTicks } = await processIdentity(process.pid);
        const h = await open(lock, "wx", 0o600);
        try { await h.writeFile(JSON.stringify({ pid: process.pid, startTicks })); await h.sync(); } finally { await h.close(); }
        break;
      }
      catch (error) {
        if (code(error) !== "EEXIST" || attempt !== 0) throw error;
        const lockText = await readSafe(lock), lockInfo = await stat(lock);
        let pid: number, priorStartTicks: string | undefined;
        try {
          const parsed: unknown = JSON.parse(lockText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed as { pid?: unknown; startTicks?: unknown };
            pid = Number(record.pid);
            if (typeof record.startTicks === "string" && /^\d+$/.test(record.startTicks)) priorStartTicks = record.startTicks;
          } else pid = Number(parsed);
        } catch { pid = Number(lockText); }
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid paper lock; inspect writer.lock manually");
        let stale = false;
        try {
          process.kill(pid, 0);
          const identity = await processIdentity(pid);
          if (priorStartTicks) stale = identity.startTicks !== priorStartTicks;
          else stale = pid === process.pid && lockInfo.mtimeMs < identity.startedAtMs - 1000;
          if (!stale) throw new Error("Paper account already owned by a running process");
        } catch (probe) {
          if (code(probe) === "ESRCH") stale = true;
          else throw probe;
        }
        await unlink(lock);
      }
    }
    try {
      let state: PaperState;
      try {
        const text = await readSafe(resolve(root, "state.json"));
        const raw = JSON.parse(text) as PaperState;
        if (raw?.config) { for (const [key, value] of Object.entries(PAPER_CONFIG)) raw.config[key as keyof typeof PAPER_CONFIG] ??= value; }
        raw.lastObservedHeadBlock ??= null;
        raw.tractionHistory ??= {};
        raw.tractionWatchlist ??= {};
        // Older PAPER files retained LIVE decisions but not the head/watchlist fields.
        // Recover only their provenance and last observed head; never synthesize traction samples.
        const retained = new Map<string, PaperState["decisions"][number]["candidate"]>();
        for (const decision of raw.decisions ?? []) if (decision.candidate?.eventMode === "LIVE" && decision.candidate.launch)
          retained.set(decision.candidate.launchId, decision.candidate);
        raw.lastObservedHeadBlock = Math.max(raw.lastObservedHeadBlock ?? 0,
          ...[...retained.values()].map(candidate => candidate.currentBlock ?? 0)) || null;
        raw.researchLedger ??= {};
        for (const [id, candidate] of retained) {
          const observedAt = raw.lastSnapshotAt ?? (candidate.launchTimestamp === null ? new Date().toISOString() : new Date(candidate.launchTimestamp * 1000).toISOString());
          const row = raw.researchLedger[id] ??= { firstObservedAt: observedAt, lastObservedAt: observedAt, observations: 1,
            lastResult: null, traded: false };
          row.sourceEventId ??= candidate.sourceEventId ?? id;
          row.eventMode ??= "LIVE";
          row.classificationReason ??= "RECOVERED_PERSISTED_LIVE_DECISION";
          const alreadyPositioned = raw.positions.some(position => position.launchId === id) || raw.trades.some(trade => trade.launchId === id);
          const age = candidate.launchTimestamp === null ? Infinity : Date.now() / 1000 - candidate.launchTimestamp;
          if (candidate.launch && candidate.decision === "WATCH" && !alreadyPositioned && age >= 0 && age <= (raw.config?.PAPER_MAX_LAUNCH_AGE_SECONDS ?? PAPER_CONFIG.PAPER_MAX_LAUNCH_AGE_SECONDS))
            raw.tractionWatchlist[id] ??= candidate.launch;
        }
        if (Number(raw.schemaVersion) === 1) {
          state = migratePaperState(raw);
          validatePaperState(state);
          const backup = await open(resolve(root, `schema-v1-backup-${Date.now()}.json`), "wx", 0o600);
          try { await backup.writeFile(text); await backup.sync(); } finally { await backup.close(); }
        } else { validatePaperState(raw); state = raw; }
      }
      catch (error) { if (code(error) !== "ENOENT") throw error; state = initialPaperState(); }
      for (const c of [...state.decisions.map(d => d.candidate), ...state.positions.map(p => p.candidate), ...state.trades.map(t => t.candidate)]) {
        if (c.launchTimestamp === undefined) Object.assign(c, unknownLaunchEvidence(c.launch?.blockNumber ?? 0));
      }
      if (process.env.PAPER_MAX_LAUNCH_AGE_SECONDS !== undefined) {
        state.config.PAPER_MAX_LAUNCH_AGE_SECONDS = Number(process.env.PAPER_MAX_LAUNCH_AGE_SECONDS);
        initialPaperState(Date.now(), state.config);
      }
      if (process.env.PAPER_QUOTE_REFRESH_MS !== undefined) {
        const interval = Number(process.env.PAPER_QUOTE_REFRESH_MS);
        if (!Number.isFinite(interval) || interval < 1000) throw new Error("PAPER_QUOTE_REFRESH_MS must be at least 1000");
        state.config.PAPER_QUOTE_REFRESH_MS = interval;
      }
      if (process.env.PAPER_STRATEGY_MODE !== undefined) {
        const mode = process.env.PAPER_STRATEGY_MODE;
        if (!["STRICT", "SCALP"].includes(mode)) throw new Error("PAPER_STRATEGY_MODE must be STRICT or SCALP");
        state.config.PAPER_STRATEGY_VERSION = mode === "SCALP" ? 4 : 3;
      }
      for (const key of ["MIN_REAL_EXIT_RESERVE_ETH", "MIN_EXIT_COVERAGE_RATIO", "MAX_EXIT_PARTICIPATION_BPS", "LIQUIDITY_OBSERVATION_COUNT", "LIQUIDITY_OBSERVATION_MIN_MS", "LIQUIDITY_OBSERVATION_WINDOW_MS", "MAX_LIQUIDITY_DROP_PERCENT"] as const) {
        if (process.env[key] !== undefined) state.config[key] = Number(process.env[key]);
      }
      initialPaperState(Date.now(), state.config);
      const store = new PaperStore(root, state); await store.write(state); return store;
    } catch (error) { await unlink(lock); throw error; }
  }
  read(): PaperState { return structuredClone(this.state); }
  private async write(state: PaperState): Promise<void> {
    // Keep the active account bounded without discarding audit evidence or trade history.
    const oldEvents = Math.max(0, state.events.length - 2000), oldDecisions = Math.max(0, state.decisions.length - 500);
    if (oldEvents || oldDecisions) {
      const archive = await open(resolve(this.directory, `audit-archive-${Date.now()}-${randomUUID()}.json`), "wx", 0o600);
      try {
        await archive.writeFile(JSON.stringify({ events: state.events.slice(0, oldEvents), decisions: state.decisions.slice(0, oldDecisions) }));
        await archive.sync();
      } finally { await archive.close(); }
      state.events = state.events.slice(oldEvents); state.decisions = state.decisions.slice(oldDecisions);
    }
    validatePaperState(state);
    const temp = resolve(this.directory, `state-${process.pid}.tmp`);
    const h = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(JSON.stringify(state)); await h.sync(); } finally { await h.close(); }
    await rename(temp, resolve(this.directory, "state.json"));
    const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
  }
  update(fn: (state: PaperState) => void | Promise<void>): Promise<void> {
    const work = this.tail.then(async () => { const next = this.read(); await fn(next); await this.write(next); this.state = next; });
    this.tail = work.catch(() => undefined); return work;
  }
  async setMaxOpenPositions(maxOpenPositions: number): Promise<void> {
    await this.update(state => {
      if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 100) throw new RangeError("Maximum open trades must be an integer from 1 to 100");
      if (maxOpenPositions < state.positions.length) throw new Error("Maximum open trades cannot be lower than the current open position count");
      state.config.MAX_OPEN_POSITIONS = maxOpenPositions;
      initialPaperState(Date.now(), state.config);
      state.events.push({ timestamp: new Date().toISOString(), category: "SYSTEM", stage: "PAPER", tokenAddress: null, tokenSymbol: null,
        eventType: "OPEN_TRADE_LIMIT_UPDATED", message: `Maximum open trades set to ${maxOpenPositions}`, metadata: { maxOpenPositions } });
    });
  }
  async reset(settings: { startingBalanceUsd?: number } = {}): Promise<void> {
    await this.update(async state => {
      const startingBalanceUsd = settings.startingBalanceUsd ?? state.config.STARTING_BALANCE_USD;
      if (!Number.isFinite(startingBalanceUsd) || startingBalanceUsd < 1 || startingBalanceUsd > 1_000_000_000) throw new RangeError("Starting equity must be between $1 and $1,000,000,000");
      const config = { ...state.config, STARTING_BALANCE_USD: startingBalanceUsd };
      initialPaperState(Date.now(), config);
      const backup = await open(resolve(this.directory, `reset-backup-${Date.now()}.json`), "wx", 0o600);
      try { await backup.writeFile(JSON.stringify(state)); await backup.sync(); } finally { await backup.close(); }
      Object.assign(state, initialPaperState(Date.now(), config));
    });
  }
  async close(): Promise<void> { await this.tail; await unlink(resolve(this.directory, "writer.lock")); }
}

/** Preserve balances/history; old universal strategy settings do not drive new entries. */
export function migratePaperState(value: unknown): PaperState {
  const old = structuredClone(value) as PaperState;
  const supplied = old.config as unknown as Record<string, number>;
  const config = { ...PAPER_CONFIG } as PaperState["config"];
  for (const key of Object.keys(PAPER_CONFIG) as (keyof PaperState["config"])[]) {
    if (Object.hasOwn(supplied, key)) config[key] = supplied[key]!;
  }
  old.schemaVersion = 2; old.config = config;
  for (const p of [...old.positions, ...old.trades]) {
    p.plan ??= proposeTradePlan(old, p.candidate, p.entry, Date.parse(p.enteredAt));
    p.plan.approvedSizeUsd = p.sizeUsd;
    p.plan.reasoning.push("Migrated historical position; original entry and account cash retained");
    p.management ??= initialManagement();
    if (p.current.side === "SELL") {
      p.management.lastSuccessfulQuote = p.current; p.management.lastSuccessfulQuoteTimestamp = p.current.timestamp;
      // Only the retained mark is known; do not invent historical peak prices.
      p.management.peakLiquidationValueUsd = p.current.notionalUsd - (p.current.costs.gasUsd ?? 0);
      p.management.peakReturnPercent = (p.management.peakLiquidationValueUsd / p.costBasisUsd - 1) * 100;
      p.management.peakTimestamp = p.current.timestamp;
    }
  }
  for (const d of old.decisions) { d.gptheistVerdict = d.candidate.decision; d.paperVerdict = d.outcome; }
  for (const t of old.trades) t.exitReasoning ??= ["Historical exit retained during schema migration"];
  old.events.push({ timestamp: new Date().toISOString(), category: "SYSTEM", stage: "PAPER", tokenAddress: null, tokenSymbol: null,
    eventType: "POLICY_MIGRATED", message: "Dynamic paper policy enabled; account history retained; schema-v1 backup saved", metadata: {} });
  return old;
}

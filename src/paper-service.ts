import { ForwardRecorder } from "./paper-forward.js";
import { MemoryHealth, runtimeLimits, withRpcPriority, rpcWorkStatus } from "./runtime-limits.js";
import { collectionCounts } from "./paper-retention.js";
import { accountCapacity } from "./paper-policy.js";
import { getPaperStrategy } from "./paper-strategy.js";
import { researchMetrics } from "./paper-research.js";
import { accountSummary, activity, monitorPaper, observeSnapshot, performance, quoteProblem, enterPaper } from "./paper.js";
import type { EntryQuoteProvider, QuoteProvider } from "./paper.js";
import { PaperStore } from "./paper-store.js";
import type { PaperQuoteService } from "./paper-quotes.js";
import { refreshLiveLaunchesAtHead, type LiveSnapshot } from "./live.js";

export interface PaperServiceOptions {
  discoveryIntervalMs?: number | undefined;
  log?: ((message: string) => void) | undefined;
}

export class PaperService {
  private readonly forward: ForwardRecorder;
  private readonly memoryHealth = new MemoryHealth();
  private memory = this.memoryHealth.sample();
  readonly startedAt = Date.now();
  private memoryTimer: ReturnType<typeof setInterval> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private monitorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly failureStates = new Map<string,string>();
  private readonly logTimes = new Map<string,number>();
  private readonly retryAfter = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly sellTape: { token: string; tokenUnits: string; result: import("./paper.js").QuoteResult }[] = [];
  private lastMonitorAt: string | null = null;
  private monitorError: string | null = null;
  private stopped = false;
  private started = false;
  private closing: Promise<void> | undefined;
  private error: string | null = null;
  private lastSuccess: string | null = null;
  private lastScanLogAt = 0;
  private lastCycleMs: number | null = null;
  constructor(readonly store: PaperStore, private readonly snapshot: () => Promise<LiveSnapshot>, private readonly quotes: QuoteProvider,
    private readonly entryQuotes?: EntryQuoteProvider, private readonly sources?: Pick<PaperQuoteService, "status" | "refreshUsd">, private readonly retryClock = Date.now,
    private readonly rpc?: import("./live.js").RpcCaller, private readonly options: PaperServiceOptions = {}) {
    this.forward=new ForwardRecorder(`${store.directory}/research`);
    const interval = options.discoveryIntervalMs ?? 4000;
    if (!Number.isFinite(interval) || interval < 1000) throw new Error("PAPER_DISCOVERY_INTERVAL_MS must be at least 1000");
  }
  private report(message: string): void {
    const key=message.slice(0,300),last=this.logTimes.get(key)??0;
    if(!message.includes("PAPER_BUY") && !message.includes("SIMULATED_SELL") && Date.now()-last<60_000) return;
    this.logTimes.delete(key);this.logTimes.set(key,Date.now());
    if(this.logTimes.size>128)this.logTimes.delete(this.logTimes.keys().next().value!);
    try { this.options.log?.(message); } catch { /* Logging must not interrupt account updates. */ }
  }
  private reportEvents(events: import("./paper.js").ActivityEvent[]): void {
    const failures = new Map<string, number>();
    for (const event of events) {
      const token=event.tokenAddress??"SYSTEM";
      if(event.eventType==="SELL_QUOTE_UPDATED") this.failureStates.delete(token);
      if (event.eventType === "QUOTE_UNAVAILABLE" && this.failureStates.get(token)!==event.message) {
        this.failureStates.set(token,event.message);failures.set(event.message,(failures.get(event.message)??0)+1);
        if(this.failureStates.size>128)this.failureStates.delete(this.failureStates.keys().next().value!);
      }
      if (event.category === "RESEARCH" || !["PAPER_BUY", "SIMULATED_SELL", "OPEN_TRADE_LIMIT_UPDATED"].includes(event.eventType)) continue;
      const numbers = ["sizeUsd", "pnlUsd", "returnPercent"].filter(key => typeof event.metadata[key] === "number")
        .map(key => `${key}=${Number(event.metadata[key]).toFixed(2)}`).join(" ");
      this.report(`[${event.timestamp}] ${event.eventType} ${event.tokenSymbol ?? event.tokenAddress ?? ""} ${event.message}${numbers ? " " + numbers : ""}`);
    }
    for (const [reason,count] of failures) this.report(`PAPER sell failures: ${reason} count=${count}`);
  }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const config = this.store.read().config, policy = getPaperStrategy(config);
    this.report(`PAPER started: ${policy.version === 5 ? "V5" : policy.version === 4 ? "SCALP" : "STRICT"} v${policy.version}; simulated trades; discovery every ${this.options.discoveryIntervalMs ?? 4000}ms; exit quotes every ${config.PAPER_QUOTE_REFRESH_MS}ms`);
    this.memoryTimer=setInterval(()=>void this.reportMemory(),30_000);
    this.memoryTimer.unref();
    void this.tick();
  }
  private async reportMemory(): Promise<void> {
    this.memory=this.memoryHealth.sample();
    if(this.memory.pressure!=="NORMAL") {
      this.report(`MEMORY_PRESSURE ${this.memory.pressure} rssMiB=${(this.memory.rss/1048576).toFixed(1)}`);
      try { await this.store.update(state=>{
        const protectedIds=new Set(state.positions.map(p=>p.launchId));
        for(const id of Object.keys(state.tractionWatchlist??{})) if(!protectedIds.has(id)) {
          // Record eviction evidence before normal durable retention archives it.
          if(this.memory.pressure==="CRITICAL") {
            activity(state,"MEMORY_CANDIDATE_SHED","Inactive candidate shed under critical pressure",Date.now(),undefined,{launchId:id});
            delete state.tractionWatchlist![id];
          }
          delete state.tractionHistory?.[id]; delete state.liquidityHistory?.[id];
        }
      }); } catch(error) { this.report(`PERSISTENCE_FAILURE ${String(error).slice(0,200)}`); }
    }
  }
  async monitor(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.monitorTimer);
    const base = this.store.read();
    this.monitorTimer = setTimeout(() => { void this.monitor(); }, base.config.PAPER_QUOTE_REFRESH_MS);
    this.monitorTimer.unref();
    const jobs = base.positions.map(position => {
      if ((this.retryAfter.get(position.id) ?? 0) > this.retryClock()) return Promise.resolve();
      const pending = this.inFlight.get(position.id);
      if (pending) return pending;
      const job = (async () => {
      const cash = base.cash;
      const draft = { ...base, positions: [position], events: [], trades: [], history: [], decisions: [] };
      await monitorPaper(draft, async p => {
        const result = await withRpcPriority(0,()=>this.quotes(p));
        if (this.sellTape.length >= runtimeLimits.quoteSamples) this.sellTape.shift(); // Every quote also persists in the append-only event archive.
        this.sellTape.push({ token: p.tokenAddress, tokenUnits: p.entry.tokenUnits ?? "", result: structuredClone(result) });
        return result;
      });
      const updated = draft.positions[0];
      if (updated && ["RPC_RATE_LIMIT", "QUOTE_TIMEOUT", "QUOTE_UNAVAILABLE", "RPC_ERROR", "RPC_TIMEOUT"].includes(updated.markReason ?? "")) {
        this.retryAfter.set(position.id, this.retryClock() + Math.min(60_000, 5_000 * 2 ** Math.min(updated.management.consecutiveQuoteFailures, 4)));
      } else this.retryAfter.delete(position.id);
      await this.store.update(state => {
        const index = state.positions.findIndex(p => p.id === position.id);
        if (index < 0) return;
        if (draft.positions[0]) state.positions[index] = draft.positions[0];
        else state.positions.splice(index, 1);
        state.cash += draft.cash - cash;
        state.trades.push(...draft.trades); state.events.push(...draft.events);
        state.history.push({ timestamp: new Date().toISOString(), equity: accountSummary(state).equity,
          stalePositions: state.positions.filter(p => p.markStatus !== "FRESH").length });
      });
      this.reportEvents(draft.events);
      })().catch(error => { this.monitorError = error instanceof Error ? error.message : "Monitor failed"; this.report("PAPER monitor error: " + this.monitorError); })
        .finally(() => { this.inFlight.delete(position.id); });
      this.inFlight.set(position.id, job);
      return job;
    });
    await Promise.all(jobs);
    this.lastMonitorAt = new Date().toISOString();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.pending) return this.pending;
    const cycleStartedAt = Date.now();
    const monitoring = this.monitor();
    this.pending = (async () => {
      // Discovery and retained-position exits run independently.
      void this.sources?.refreshUsd().catch(error => this.report("PAPER USD refresh error: " + String(error)));
      let snapshot: LiveSnapshot | undefined;
      try {
        if(this.memory.pressure==="CRITICAL") return;
        snapshot = await withRpcPriority(3,()=>this.snapshot()); this.lastSuccess = snapshot.fetchedAt; this.error = null;
        const state = this.store.read();
        if (snapshot.fetchedAt === state.lastSnapshotAt) return;
        const present = new Set(snapshot.launches.map(l => `${l.transactionHash}:${l.logIndex}`));
        const retained = Object.entries(state.tractionWatchlist ?? {}).filter(([id, launch]) => !present.has(id) &&
          !state.positions.some(p => p.launchId === id) && !state.trades.some(t => t.launchId === id) && launch.chronology?.eventMode === "LIVE" &&
          launch.chronology.launchTimestamp !== null && Date.now()/1000-launch.chronology.launchTimestamp <= state.config.PAPER_MAX_LAUNCH_AGE_SECONDS);
        if (this.rpc && retained.length) {
          const refreshed = await refreshLiveLaunchesAtHead(this.rpc, retained.map(([, launch]) => launch), snapshot.headBlock);
          snapshot = { ...snapshot, launches: [...snapshot.launches, ...refreshed] };
        }
      }
      catch (error) { this.error = error instanceof Error ? error.message.slice(0, 200) : "RPC unavailable"; }
      try {
        // Discovery/entry network work never holds the account lock or blocks monitoring.
        if (snapshot) {
          const draft = this.store.read();
          draft.events = []; draft.decisions = [];
          const buys: { token: string; sizeUsd: number; result: import("./paper.js").QuoteResult }[] = [];
          const entryQuotes = this.entryQuotes;
          await observeSnapshot(draft, snapshot, Date.now(), entryQuotes ? async (launch, sizeUsd) => {
            const result = await entryQuotes(launch, sizeUsd);
            buys.push({ token: launch.token, sizeUsd, result: structuredClone(result) }); return result;
          } : undefined, Date.now);
          if(this.memory.pressure==="NORMAL" && process.env.PAPER_RESEARCH_ENABLED!=="false")
            await this.forward.record({sequence:Date.now(),completedAt:new Date().toISOString(),snapshot,buys,sells:this.sellTape.splice(0)});
          else this.sellTape.length=0;
          const committedEvents: import("./paper.js").ActivityEvent[] = [];
          await this.store.update(state => {
            const eventStart = state.events.length;
            state.lastSnapshotAt = draft.lastSnapshotAt;
            state.lastObservedHeadBlock = draft.lastObservedHeadBlock;
            if (draft.liquidityHistory) state.liquidityHistory = draft.liquidityHistory;
            if (draft.tractionHistory) state.tractionHistory = draft.tractionHistory;
            if (draft.tractionWatchlist) state.tractionWatchlist = draft.tractionWatchlist;
            if (draft.researchLedger) {
              const priorTraded=new Set(Object.entries(state.researchLedger??{}).filter(([,row])=>row.traded).map(([id])=>id));
              state.researchLedger = draft.researchLedger;
              const traded = new Set([...state.positions, ...state.trades].map(p => p.launchId));
              for (const [id, row] of Object.entries(state.researchLedger)) row.traded = traded.has(id) || priorTraded.has(id) || row.archivedClosed === true;
            }
            state.latestGate = draft.latestGate;
            state.events.push(...draft.events.filter(e => !["PAPER_BUY", "PAPER_ELIGIBLE"].includes(e.eventType)));
            for (const decision of draft.decisions) {
              // Revalidate against current cash/positions and quote age after concurrent exits.
              if (decision.outcome === "PAPER_ELIGIBLE") enterPaper(state, decision.candidate, decision.sizeUsd, Date.now(), decision.plan);
              else state.decisions.push(decision);
            }
            committedEvents.push(...state.events.slice(eventStart));
          });
          this.reportEvents(committedEvents);
          if(process.env.PAPER_DEBUG_LOG === "true" || Date.now()-this.lastScanLogAt>=60_000) { this.lastScanLogAt=Date.now(); this.report(`PAPER scan: block ${snapshot.headBlock}, ${snapshot.launches.length} launches, ${this.store.read().positions.length} open positions, ${Date.now() - cycleStartedAt}ms`); }
        } else await this.store.update(state => { activity(state, "RPC_FAILURE", this.error ?? "RPC unavailable", Date.now()); });
      } catch (error) { this.error = error instanceof Error ? error.message : "Paper persistence failed"; }
    })().finally(async () => {
      await monitoring;
      const active = new Set(this.store.read().positions.map(p=>p.id));
      for (const id of this.retryAfter.keys()) if (!active.has(id)) this.retryAfter.delete(id);
      this.lastCycleMs = Date.now() - cycleStartedAt;
      if (this.error) this.report("PAPER error: " + this.error);
      this.pending = undefined;
      if (!this.stopped) { this.timer = setTimeout(() => { void this.tick(); }, Math.max(0, (this.options.discoveryIntervalMs ?? 4000) - (Date.now() - cycleStartedAt))); this.timer.unref(); }
    });
    return this.pending;
  }
  health() { return {memory:this.memory, persistence:this.store.status(),rpc:rpcWorkStatus(this.rpc)}; }
  view() {
    const state = this.store.read();
    const latestDecisions = new Map<string, typeof state.decisions[number]>();
    for (const decision of state.decisions) if (decision.candidate.currentBlock === state.lastObservedHeadBlock)
      latestDecisions.set(decision.candidate.launchId, decision);
    const live = [...latestDecisions.values()].filter(d => d.candidate.eventMode === "LIVE" && !state.positions.some(p => p.launchId === d.candidate.launchId) &&
      !state.trades.some(t => t.launchId === d.candidate.launchId) && d.candidate.launchTimestamp !== null &&
      Date.now() / 1000 - d.candidate.launchTimestamp <= state.config.PAPER_MAX_LAUNCH_AGE_SECONDS);
    const blockers = new Map<string, number>();
    for (const d of live) if (d.outcome !== "PAPER_ELIGIBLE") blockers.set(d.reason, (blockers.get(d.reason) ?? 0) + 1);
    const allocationCapUsd = accountCapacity(state).equityUsd * getPaperStrategy(state.config, accountCapacity(state).equityUsd).maxTokenExposurePercent / 100;
    const entryDiagnostics = { allocationCapUsd, minimumTradeUsd: state.config.MIN_POSITION_USD,
      accountSizingBlocked: allocationCapUsd < state.config.MIN_POSITION_USD,
      strategyMode: state.config.PAPER_STRATEGY_VERSION === 5 ? "V5" : state.config.PAPER_STRATEGY_VERSION === 4 ? "SCALP" : "STRICT",
      strategyVersion: state.config.PAPER_STRATEGY_VERSION, currentBlock: state.lastObservedHeadBlock, liveCandidates: live.length,
      discoveryIntervalMs: this.options.discoveryIntervalMs ?? 4000, lastCycleMs: this.lastCycleMs, scanning: !!this.pending,
      blockers: [...blockers].map(([reason, count]) => ({ reason, count })).sort((a,b) => b.count - a.count) };
    for (const p of state.positions) {
      const problem = quoteProblem(p.current, Date.now(), state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS);
      if (problem) { p.markStatus = "UNAVAILABLE"; p.markReason ??= problem; }
      const successful = p.management.lastSuccessfulQuote;
      Object.assign(p, { accounting: { costBasisUsd: p.costBasisUsd,
        lastSuccessfulExecutableValueUsd: successful ? successful.notionalUsd - (successful.costs.gasUsd ?? 0) : null,
        currentExecutableValueUsd: successful && p.markStatus === "FRESH" ? successful.notionalUsd - (successful.costs.gasUsd ?? 0) : null,
        unrealizedPnlUsd: successful && p.markStatus === "FRESH" ? successful.notionalUsd - (successful.costs.gasUsd ?? 0) - p.costBasisUsd : null,
        unrealizedPnlStatus: successful && p.markStatus === "FRESH" ? "FRESH" : "UNAVAILABLE" },
        market: p.market ?? "PONS_V2_CURVE", quote_source: successful?.source ?? null, quote_status: p.markStatus,
        quoteStatus: successful ? p.markStatus === "FRESH" ? "LIVE" : "STALE" : "UNAVAILABLE",
        lastQuoteAttemptAt: p.lastQuoteAttempt ?? null, lastSuccessfulQuoteAt: successful?.timestamp ?? null,
        quoteBlock: successful?.blockNumber ?? null, currentBlock: p.quoteDiagnostics?.currentBlock ?? null,
        quoteAgeMs: successful ? Date.now() - Date.parse(successful.timestamp) : null,
        consecutiveFailures: p.management.consecutiveQuoteFailures, lastFailureReason: p.markReason });
    }
    return { systemHealth: {researchRecording:this.forward.status(), rpc:rpcWorkStatus(this.rpc), memory:this.memory, collections:collectionCounts(state), persistence:this.store.status(), pendingExitJobs:this.inFlight.size, timers:Number(!!this.timer)+Number(!!this.monitorTimer)+Number(!!this.memoryTimer)}, entryDiagnostics, monitor: { lastCompletedAt: this.lastMonitorAt, running: this.inFlight.size > 0, error: this.monitorError }, quoteHealth: this.sources?.status() ?? null, execution: "SIMULATED", startedAt: new Date(this.startedAt).toISOString(),
      connection: !this.error && this.lastSuccess && Date.now() - Date.parse(this.lastSuccess) <= state.config.QUOTE_MAX_AGE_MS ? "LIVE" : "UNAVAILABLE",
      error: this.error, lastSuccess: this.lastSuccess, account: accountSummary(state), riskCapacity: accountCapacity(state), performance: performance(state), research: researchMetrics(state),
      ...state, events: state.events.slice(-200), decisions: [...new Map(state.decisions.filter(d => state.tractionWatchlist?.[d.candidate.launchId]).map(d=>[d.candidate.launchId,d])).values()].slice(-100), recentRejections: state.decisions.filter(d=>d.outcome!=="PAPER_ELIGIBLE" && !state.tractionWatchlist?.[d.candidate.launchId]).slice(-25), trades: state.trades.slice(-100) };
  }
  setMaxOpenPositions(maxOpenPositions: number): Promise<void> { return this.store.setMaxOpenPositions(maxOpenPositions); }
  async resetAccount(startingBalanceUsd: number): Promise<void> {
    clearTimeout(this.timer);
    await this.pending;
    clearTimeout(this.timer);
    clearTimeout(this.monitorTimer);
    await Promise.all(this.inFlight.values());
    await this.store.reset({ startingBalanceUsd });
    if (!this.stopped) {
      this.timer = setTimeout(() => { void this.tick(); }, this.options.discoveryIntervalMs ?? 4000);
      this.timer.unref();
      void this.monitor();
    }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped = true; clearTimeout(this.timer); clearTimeout(this.monitorTimer); clearInterval(this.memoryTimer);
      this.memoryHealth.close(); await this.pending; await Promise.all(this.inFlight.values()); clearTimeout(this.timer); clearTimeout(this.monitorTimer); this.retryAfter.clear(); this.failureStates.clear();this.logTimes.clear(); this.sellTape.length=0; await this.forward.close(); await this.store.close();
    })();
  }
}

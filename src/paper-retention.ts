import { runtimeLimits } from "./runtime-limits.js";
import { getPaperStrategy } from "./paper-strategy.js";
import { performance, type PaperState } from "./paper.js";

export const RETENTION = { events: 200, decisions: 100, trades: 100, equity: 250, headerCache: 512, socialCache: 256 } as const;
const permanent = new Set(["STALE_LAUNCH", "BACKFILL_EVENT", "UNSUPPORTED_PAIR", "UNSUPPORTED_CURVE", "INVALID_PROVENANCE", "LAUNCH_TIME_UNVERIFIED", "UNVERIFIED_LAUNCH_AGE", "INVALID_CANDIDATE"]);
export type CandidateLifecycle = "DISCOVERED" | "OBSERVING" | "QUALIFIED" | "REJECTED" | "EXPIRED";
export function candidateLifecycle(state: PaperState, id: string, now: number): CandidateLifecycle {
  if (state.positions.some(p=>p.launchId===id) || state.researchLedger?.[id]?.traded) return "QUALIFIED";
  const launch = state.tractionWatchlist?.[id];
  const row = state.researchLedger?.[id];
  const timestamp = launch?.chronology?.launchTimestamp;
  const occurred = timestamp != null ? timestamp*1000 : row?.sourceEventTimestampMs;
  if (occurred != null && now-occurred > state.config.PAPER_MAX_LAUNCH_AGE_SECONDS*1000) return "EXPIRED";
  if (row?.eventMode === "BACKFILL" || permanent.has(row?.lastResult ?? "") || (launch && launch.verdict !== "WATCH")) return "REJECTED";
  return launch ? "OBSERVING" : "DISCOVERED";
}
/** Returns audit records to durably archive BEFORE committing the compact account. */
export function retainPaperState(state: PaperState, now = Date.now()) {
  const ledger: NonNullable<PaperState["researchLedger"]> = {};
  const watchlist: NonNullable<PaperState["tractionWatchlist"]> = {};
  for (const id of Object.keys(state.tractionWatchlist ?? {})) {
    const lifecycle = candidateLifecycle(state,id,now);
    if (["QUALIFIED","REJECTED","EXPIRED"].includes(lifecycle)) {
      watchlist[id] = state.tractionWatchlist![id]!;
      delete state.tractionWatchlist![id];
      if (!state.positions.some(p=>p.launchId===id)) { delete state.tractionHistory?.[id]; delete state.liquidityHistory?.[id]; }
    }
  }
  for (const [id,row] of Object.entries(state.researchLedger ?? {})) {
    if (candidateLifecycle(state,id,now) === "REJECTED") { delete state.tractionHistory?.[id]; delete state.liquidityHistory?.[id]; }
    const occurred = row.sourceEventTimestampMs ?? row.firstObservedAtMs ?? Date.parse(row.firstObservedAt);
    // Keep compact chronological tombstones through the full existing entry window.
    // Persisted head prevents replayed logs becoming new LIVE events after eviction.
    if (!state.tractionWatchlist?.[id] && !state.positions.some(p=>p.launchId===id) && now-occurred > state.config.PAPER_MAX_LAUNCH_AGE_SECONDS*1000) {
      ledger[id]=row; delete state.researchLedger![id];
      delete state.tractionHistory?.[id]; delete state.liquidityHistory?.[id];
    }
  }
  for (const [map,window] of [[state.tractionHistory,state.config.TRACTION_WINDOW_SECONDS*1000],[state.liquidityHistory,state.config.LIQUIDITY_OBSERVATION_WINDOW_MS]] as const) {
    if (map) for (const [id,rows] of Object.entries(map)) {
      const kept = rows.filter((r: { timestamp: string })=>now-Date.parse(r.timestamp)<=window);
      if (kept.length) map[id]=kept.slice(-runtimeLimits.observations) as typeof rows; else delete map[id];
    }
  }
  const protectedIds = new Set(state.positions.map(p=>p.launchId));
  const inactive = Object.keys(state.tractionWatchlist ?? {}).filter(id=>!protectedIds.has(id))
    .sort((a,b)=>Date.parse(state.researchLedger?.[b]?.lastObservedAt ?? '')-Date.parse(state.researchLedger?.[a]?.lastObservedAt ?? ''));
  for (const id of inactive.slice(runtimeLimits.candidates)) {
    watchlist[id]=state.tractionWatchlist![id]!; delete state.tractionWatchlist![id];
    delete state.tractionHistory?.[id]; delete state.liquidityHistory?.[id];
  }
  const ledgerIds=Object.keys(state.researchLedger??{}).filter(id=>!protectedIds.has(id) && !state.tractionWatchlist?.[id] && !state.researchLedger?.[id]?.traded);
  for (const id of ledgerIds.slice(0,Math.max(0,ledgerIds.length-runtimeLimits.candidates*2))) {
    ledger[id]=state.researchLedger![id]!; delete state.researchLedger![id];
    delete state.tractionHistory?.[id]; delete state.liquidityHistory?.[id];
  }
  const trades = state.trades.splice(0,Math.max(0,state.trades.length-RETENTION.trades));
  state.archivedRealizedPnl=trades.reduce((sum,t)=>sum+t.pnlUsd,state.archivedRealizedPnl??0);
  const day = new Date(now).toISOString().slice(0,10);
  if (state.archivedDailyLoss?.day !== day) state.archivedDailyLoss={day,loss:0};
  for (const t of trades) {
    if (t.exitedAt.slice(0,10)===day) state.archivedDailyLoss!.loss+=Math.max(0,-t.pnlUsd);
    const stats=(state.archivedStrategyStats??={})[String(t.plan.strategyVersion)]??={trades:0,wins:0,grossProfit:0,grossLoss:0};
    stats.trades++; if(t.pnlUsd>0){stats.wins++;stats.grossProfit+=t.pnlUsd;} else stats.grossLoss-=t.pnlUsd;
    const launchAt=t.candidate.launchTimestamp;
    if (launchAt != null && now-launchAt*1000<=state.config.PAPER_MAX_LAUNCH_AGE_SECONDS*1000) {
      (state.researchLedger??={})[t.launchId]??={firstObservedAt:t.enteredAt,lastObservedAt:t.exitedAt,observations:0,lastResult:"LAUNCH_ALREADY_TRADED",traded:true,archivedClosed:true,sourceEventTimestampMs:launchAt*1000,eventMode:t.candidate.eventMode};
    }
    const row=state.researchLedger?.[t.launchId]; if(row) { row.traded=true; row.archivedClosed=true; }
  }
  // Minimal recent records preserve the existing per-strategy loss-streak decision.
  const regime=[...(state.archivedRegimeTrades??[]),...trades].map(t=>({exitedAt:t.exitedAt,pnlUsd:t.pnlUsd,plan:t.plan.strategyVersion === undefined ? {} : {strategyVersion:t.plan.strategyVersion}}));
  state.archivedRegimeTrades=[3,4,5].flatMap(version=>regime.filter(t=>t.plan.strategyVersion===version).sort((a,b)=>Date.parse(a.exitedAt)-Date.parse(b.exitedAt)).slice(-getPaperStrategy({...state.config,PAPER_STRATEGY_VERSION:version}).lossStreakLimit));
  const history = state.history.splice(0,Math.max(0,state.history.length-RETENTION.equity));
  if (trades.length || history.length) state.archivedPerformance = performance({ ...state, positions: [], trades, history });
  // Full raw frames and quote evidence live on disk, never in the resident activity view.
  const rawEvents = state.events.filter(e=>e.eventType === "PAPER_LAB_FRAME");
  state.events = state.events.filter(e=>e.eventType !== "PAPER_LAB_FRAME");
  const events = [...rawEvents,...state.events.splice(0,Math.max(0,state.events.length-RETENTION.events))];
  const obsolete = state.decisions.filter(d=>now-Date.parse(d.timestamp)>state.config.PAPER_MAX_LAUNCH_AGE_SECONDS*1000);
  state.decisions=state.decisions.filter(d=>!obsolete.includes(d));
  const decisions = [...obsolete,...state.decisions.splice(0,Math.max(0,state.decisions.length-runtimeLimits.rejections))];
  return { trades,history,events,decisions,ledger,watchlist };
}
export function collectionCounts(state: PaperState) {
  return { activeCandidates: Object.keys(state.tractionWatchlist??{}).length,
    candidateObservations: Object.values(state.tractionHistory??{}).reduce((n,r)=>n+r.length,0),
    processedTokens: Object.keys(state.researchLedger??{}).length,
    quoteRecords: Object.values(state.liquidityHistory??{}).reduce((n,r)=>n+r.length,0) + state.positions.reduce((n,p)=>n+2+Number(!!p.management.lastSuccessfulQuote),0) + state.trades.length*3 + state.decisions.filter(d=>d.candidate.quote.status === "AVAILABLE").length,
    activityEvents: state.events.length, openPositions: state.positions.length, closedTrades: state.trades.length, equityRecords: state.history.length };
}

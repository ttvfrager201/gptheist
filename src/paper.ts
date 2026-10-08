import { LiquiditySurvivalGate, v5RiskTriggers } from "./paper-v5.js";
import { entryQuality, entryRegimeRejection, entryExecutionQuality, roundTripLossPercent, getPaperStrategy, entryPolicyConfig, PAPER_STRATEGY } from "./paper-strategy.js";
import { V4, v4PoolId, type V4Evidence, type V4Route } from "./uniswap-v4.js";
import { sellObservation, failedSellObservation, appendLiquidityObservation, ExitLiquiditySafetyGate, type LiquidityObservation } from "./paper-liquidity.js";
import { unknownLaunchEvidence, type LaunchEvidence } from "./launch-evidence.js";
import { randomUUID } from "node:crypto";
import { AGENTS, type AgentHandoff } from "./simulation.js";
import type { LiveLaunchDecision, LiveSnapshot } from "./live.js";
import { accountCapacity, proposeTradePlan, evaluateExit, initialManagement, type PaperTradePlan, type Management, type ExitReason } from "./paper-policy.js";

export const PAPER_CONFIG = Object.freeze({
  PAPER_STRATEGY_VERSION: 3,
  MIN_REAL_EXIT_RESERVE_ETH: .01, MIN_EXIT_COVERAGE_RATIO: 100, MAX_EXIT_PARTICIPATION_BPS: 100,
  TRACTION_WINDOW_SECONDS: 300, TRACTION_OBSERVATION_COUNT: 3, TRACTION_OBSERVATION_MIN_MS: 10_000,
  LIQUIDITY_OBSERVATION_COUNT: 3, LIQUIDITY_OBSERVATION_MIN_MS: 30_000, LIQUIDITY_OBSERVATION_WINDOW_MS: 90_000, MAX_LIQUIDITY_DROP_PERCENT: 10,
  PAPER_MAX_LAUNCH_AGE_SECONDS: 300,
  STARTING_BALANCE_USD: 1000, MAX_OPEN_POSITIONS: 5, MAX_DAILY_LOSS_USD: 50,
  MAX_POSITION_EQUITY_PERCENT: 2, MAX_PORTFOLIO_EXPOSURE_PERCENT: 10, MIN_CASH_RESERVE_PERCENT: 20,
  MAX_RISK_EQUITY_PERCENT: .2, MIN_POSITION_USD: 1, MAX_REAL_LIQUIDITY_PERCENT: 2,
  MAX_ENTRY_IMPACT_PERCENT: 2, MAX_DOWNSIDE_PERCENT: 25, MAX_HOLD_MS: 3_600_000,
  QUOTE_MAX_AGE_MS: 30_000, ETH_USD_MAX_AGE_MS: 30_000, MONITOR_INTERVAL_MS: 15_000, PAPER_QUOTE_REFRESH_MS: 5_000
});
export type PaperConfig = { -readonly [K in keyof typeof PAPER_CONFIG]: number };
export interface Costs { feesUsd: number | null; slippageUsd: number | null; priceImpactPercent: number | null; gasUsd: number | null }
/** Prices include known fees/impact/slippage; gas is separate. Quotes must be sized to the requested fill. */
export interface PaperQuote {
  gasEstimate?: { chainId: number; priceWei: string; gwei: number; timestamp: string; gasUnits: number; model: "ASSUMED_SWAP_UNITS" };
  /** Derived curve FDV: total supply × pinned pre-buy reserve-ratio price, including virtual reserves. */
  derivedFdvUsd?: number;
  valuationBasis?: "TOTAL_SUPPLY_X_CURVE_SPOT";
  totalSupplyRaw?: string; totalSupplyTokens?: string;
  /** Legacy saved FDV field. New quotes use derivedFdvUsd; this is not verified Pons market cap. */
  marketCapUsd?: number | null;
  v4?: V4Evidence;
  tokenAddress: string; side: "BUY" | "SELL"; timestamp: string; blockTimestamp: string;
  source: string; blockNumber: number; rawPriceUsd: number; fillPriceUsd: number;
  quantity: number; notionalUsd: number; liquidityUsd: number; costs: Costs;
  /** Exact token units and evidence retained for subsequent sell quotes. */
  tokenUnits?: string;
  quoteRequestedAt?: string; quoteMethod?: string; humanAmountIn?: string; humanAmountOut?: string;
  quoteAssetDecimals?: number; graduationState?: string;
  roundTrip?: { sell: PaperQuote; entryUsd: number; immediateExitUsd: number; lossUsd: number; lossPercent: number; knownTaxesUsd?: number | null; knownFeesUsd: number | null };
  evidence?: { model: "PONS_V2_CURVE"; chainId: number; curve: string; blockHash: string;
    ethUsd: number; usdTimestamp: string; usdSource: string; tokenDecimals: number;
    quoteReserve: string; tokenReserve: string; realQuoteReserve: string;
    feeBps: number; creatorTaxBps: number; snipeTaxBps: number; currentSnipeTaxBps?: number; progressBps: number;
    amountIn: string; amountOut: string; quoteAsset: "ETH"; feeWei: string; creatorTaxWei: string; snipeTaxWei: string; modelSource: string };
}
export interface QuoteDiagnostics {
  migration?: QuoteDiagnostics;
  attemptedAt: string; completedAt?: string; input: { side: string; tokenUnits?: string; quantity?: number; sizeUsd?: number };
  currentBlock?: number; blockTimestamp?: string; launchTimestamp?: string; launchBlockHash?: string;
  rpc: { method: string; params: unknown[]; response?: unknown; error?: string }[];
  roundTripSell?: QuoteResult; ethUsd?: unknown; market?: unknown; calculation?: Record<string, string>; failure?: string;
}
export type QuoteResult = ({ status: "AVAILABLE"; quote: PaperQuote } |
  { status: "NOT_PAPER_TRADABLE"; reason: string; details: string[] }) & { diagnostics?: QuoteDiagnostics };
export interface Candidate extends LaunchEvidence {
  paperEngineReceivedAtMs?: number | null;
  tokenAddress: string; name: string; symbol: string; launchId: string;
  launch?: LiveLaunchDecision;
  decision: "WATCH" | "VETO";
  evidenceComplete: boolean; handoffs: AgentHandoff[]; quote: QuoteResult;
  tractionDiagnostics?: TractionDiagnostics;
}
export interface TractionObservation {
  token: string; symbol: string; sourceEventId: string; block: number; blockHash: string | null; timestamp: string;
  reserve: string | null; previousReserve: string | null; reserveDelta: string | null; reserveDeltaPct: number | null;
  curveProgressBps: number | null; previousCurveProgressBps: number | null; curveProgressDeltaBps: number | null;
  verificationStatus: "VERIFIED" | "UNAVAILABLE"; quoteStatus: string;
}
export interface TractionDiagnostics {
  observationCount: number; verifiedObservationCount: number; observations: TractionObservation[]; tractionWindowSeconds: number;
  positiveReserveChangeDetected: boolean; positiveCurveChangeDetected: boolean; tractionPass: boolean;
  exactFailureReason: string | null;
}
export interface Eligibility { outcome: "PAPER_ELIGIBLE" | "PAPER_BUY" | "PAPER_REJECT" | "NOT_TRADABLE" | "VETO" | "OBSERVING"; reason: string; details: string[] }
export interface ActivityEvent {
  timestamp: string; category: "RESEARCH" | "PAPER" | "SYSTEM"; stage: string;
  tokenAddress: string | null; tokenSymbol: string | null; eventType: string; message: string; metadata: Record<string, unknown>;
}
export interface Position {
  market?: "PONS_V2_CURVE" | "UNISWAP_V4"; executionRoute?: V4Route;
  id: string; mode: "PAPER"; execution: "SIMULATED"; candidate: Candidate;
  tokenAddress: string; name: string; symbol: string; launchId: string;
  entry: PaperQuote; current: PaperQuote; quantity: number; sizeUsd: number; costBasisUsd: number;
  plan: PaperTradePlan; management: Management;
  quoteDiagnostics?: QuoteDiagnostics; lastQuoteAttempt?: string; quoteFailureDetails?: string[]; launchTimestamp?: string; launchBlockHash?: string;
  enteredAt: string; markStatus: "FRESH" | "UNAVAILABLE"; markReason: string | null;
}
export interface ClosedTrade extends Position {
  exit: PaperQuote; exitedAt: string; pnlUsd: number; returnPercent: number; exitReason: ExitReason | "STOP_LOSS" | "TAKE_PROFIT"; exitReasoning: string[];
}
export interface CandidateDecision extends Eligibility { timestamp: string; candidate: Candidate; sizeUsd: number; gptheistVerdict: Candidate["decision"]; paperVerdict: Eligibility["outcome"]; plan?: PaperTradePlan }
export interface EquitySnapshot { timestamp: string; equity: number; stalePositions: number }
export interface PaperState {
  archiveHead?: string;
  archiveTradeHead?: string;
  archivedDailyLoss?: { day: string; loss: number };
  archivedRegimeTrades?: { exitedAt: string; pnlUsd: number; plan: Pick<PaperTradePlan, "strategyVersion"> }[];
  archivedStrategyStats?: Record<string, { trades: number; wins: number; grossProfit: number; grossLoss: number }>;
  archivedRealizedPnl?: number;
  archivedPerformance?: ReturnType<typeof performance>;
  liquidityHistory?: Record<string, LiquidityObservation[]>;
  tractionHistory?: Record<string, TractionObservation[]>;
  tractionWatchlist?: Record<string, LiveLaunchDecision>;
  lastObservedHeadBlock: number | null;
  researchLedger?: Record<string, { firstObservedAt: string; firstObservedAtMs?: number; lastObservedAt: string; observations: number;
    lastResult: string | null; lastOutcome?: string; traded: boolean; archivedClosed?: boolean; sourceEventId?: string;
    sourceEventTimestampMs?: number | null; eventMode?: "LIVE" | "BACKFILL"; classificationReason?: string; deduplicateLogged?: boolean }>;
  schemaVersion: 2; mode: "PAPER"; createdAt: string; config: PaperConfig; cash: number;
  positions: Position[]; trades: ClosedTrade[]; decisions: CandidateDecision[];
  events: ActivityEvent[]; history: EquitySnapshot[]; lastSnapshotAt: string | null;
  latestGate: { stage: string; outcome: string; message: string } | null;
}
const positive = (n: number): boolean => Number.isFinite(n) && n > 0;
const iso = (now: number): string => new Date(now).toISOString();
export function initialPaperState(now = Date.now(), config: PaperConfig = PAPER_CONFIG): PaperState {
  if (Object.keys(PAPER_CONFIG).some(key => !positive(config[key as keyof PaperConfig])) ||
      ![3, 4, 5].includes(config.PAPER_STRATEGY_VERSION) ||
      !Number.isInteger(config.TRACTION_OBSERVATION_COUNT) || config.TRACTION_OBSERVATION_COUNT < 2 ||
      config.TRACTION_WINDOW_SECONDS <= 0 || config.TRACTION_OBSERVATION_MIN_MS <= 0 ||
      !Number.isInteger(config.LIQUIDITY_OBSERVATION_COUNT) || config.LIQUIDITY_OBSERVATION_COUNT < 2 || config.LIQUIDITY_OBSERVATION_COUNT > 100 ||
      config.LIQUIDITY_OBSERVATION_WINDOW_MS < config.LIQUIDITY_OBSERVATION_MIN_MS ||
      !Number.isInteger(config.MAX_EXIT_PARTICIPATION_BPS) || config.MAX_EXIT_PARTICIPATION_BPS > 10000 || config.MAX_LIQUIDITY_DROP_PERCENT >= 100 ||
      !Number.isInteger(config.MAX_OPEN_POSITIONS) || config.MAX_POSITION_EQUITY_PERCENT > 100 ||
      config.MAX_PORTFOLIO_EXPOSURE_PERCENT > 100 || config.MIN_CASH_RESERVE_PERCENT >= 100 ||
      config.MAX_RISK_EQUITY_PERCENT > 100 || config.MAX_DOWNSIDE_PERCENT >= 100 ||
      config.MAX_REAL_LIQUIDITY_PERCENT > 100 || config.MAX_ENTRY_IMPACT_PERCENT >= 100) throw new Error("Invalid paper configuration");
  return { schemaVersion: 2, mode: "PAPER", createdAt: iso(now), config: { ...config }, cash: config.STARTING_BALANCE_USD,
    positions: [], trades: [], decisions: [], events: [], history: [{ timestamp: iso(now), equity: config.STARTING_BALANCE_USD, stalePositions: 0 }],
    lastSnapshotAt: null, lastObservedHeadBlock: null, latestGate: null };
}
export function quoteProblem(q: PaperQuote, now: number, maxAge: number, usdMaxAge = maxAge): string | null {
  try {
  if (![q.rawPriceUsd, q.fillPriceUsd, q.quantity, q.notionalUsd, q.liquidityUsd].every(positive) ||
      !Number.isSafeInteger(q.blockNumber) || q.blockNumber < 0 || !q.source ||
      !["BUY", "SELL"].includes(q.side) || !/^0x[0-9a-f]{40}$/i.test(q.tokenAddress) ||
      ![q.costs.feesUsd, q.costs.slippageUsd, q.costs.priceImpactPercent, q.costs.gasUsd].every(v => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0)) ||
      Object.values(q.costs).some(v => v !== null && (!Number.isFinite(v) || v < 0)) ||
      !Number.isFinite(q.fillPriceUsd * q.quantity) ||
      Math.abs(q.fillPriceUsd * q.quantity - q.notionalUsd) > Math.max(1e-8, q.notionalUsd * 1e-8)) return "INVALID_QUOTE";
  if (q.evidence && (q.evidence.model !== "PONS_V2_CURVE" || q.evidence.chainId !== 4663 || !positive(q.evidence.ethUsd) ||
      !Number.isInteger(q.evidence.tokenDecimals) || q.evidence.tokenDecimals < 0 || q.evidence.tokenDecimals > 36 ||
      ![q.evidence.feeBps, q.evidence.creatorTaxBps, q.evidence.snipeTaxBps].every(n => Number.isInteger(n) && n >= 0 && n <= 10000) ||
      !q.evidence.usdSource || !/^0x[0-9a-f]{64}$/i.test(q.evidence.blockHash) || !q.tokenUnits || !/^[1-9][0-9]*$/.test(q.tokenUnits))) return "INVALID_QUOTE_EVIDENCE";
  if (q.evidence && q.tokenUnits !== (q.side === "BUY" ? q.evidence.amountOut : q.evidence.amountIn)) return "TOKEN_QUANTITY_MISMATCH";
  if (q.source === "UNISWAP_V4" && (!q.v4 || q.evidence)) return "INVALID_QUOTE_EVIDENCE";
  if (q.v4 && (q.side !== "SELL" || q.source !== "UNISWAP_V4" || q.v4.chainId !== 4663 ||
      !q.tokenUnits || !/^[1-9][0-9]*$/.test(q.tokenUnits) || q.v4.amountIn !== q.tokenUnits || BigInt(q.v4.amountOut) <= 0n || !positive(q.v4.ethUsd) ||
      !q.v4.usdSource || !/^0x[0-9a-f]{64}$/i.test(q.v4.blockHash) ||
      q.v4.route.market !== "UNISWAP_V4" || q.v4.route.manager.toLowerCase() !== V4.manager ||
      q.v4.route.quoter.toLowerCase() !== V4.quoter || q.v4.route.router.toLowerCase() !== V4.router ||
      q.v4.route.pool !== v4PoolId(q.v4.route.key) || q.v4.route.key.currency0 !== `0x${"0".repeat(40)}` ||
      BigInt(q.v4.activeLiquidity) <= 0n || BigInt(q.v4.quotePrincipalWei) < BigInt(q.v4.amountOut) ||
      !Number.isInteger(q.v4.tokenDecimals) || q.v4.tokenDecimals < 0 || q.v4.tokenDecimals > 36 ||
      Math.abs(Number(BigInt(q.v4.amountIn)) / 10 ** q.v4.tokenDecimals - q.quantity) > q.quantity * 1e-10 ||
      Math.abs(Number(BigInt(q.v4.amountOut)) / 1e18 * q.v4.ethUsd - q.notionalUsd) > Math.max(1e-8, q.notionalUsd * 1e-8) ||
      q.v4.route.key.currency1.toLowerCase() !== q.tokenAddress.toLowerCase())) return "INVALID_QUOTE_EVIDENCE";
  for (const [time, limit, reason] of [[q.timestamp, maxAge, "QUOTE_STALE"], [q.blockTimestamp, maxAge, "QUOTE_STALE"],
    ...(q.evidence ? [[q.evidence.usdTimestamp, usdMaxAge, "ETH_USD_STALE"]] : []),
    ...(q.v4 ? [[q.v4.usdTimestamp, usdMaxAge, "ETH_USD_STALE"]] : [])] as [string, number, string][]) {
    const age = now - Date.parse(time);
    if (!Number.isFinite(age) || age < 0 || age > limit) return reason;
  }
  return null;
  } catch { return "INVALID_QUOTE"; }
}
export function dailyRealizedLoss(state: PaperState, now: number): number {
  const day = iso(now).slice(0, 10);
  return state.trades.filter(t => t.exitedAt.slice(0, 10) === day).reduce((sum, t) => sum + Math.max(0, -t.pnlUsd), state.archivedDailyLoss?.day === day ? state.archivedDailyLoss.loss : 0);
}
export function paperLaunchRejection(c: Candidate, state: PaperState, now: number): string | null {
  if (c.currentBlock == null || c.launchTimestamp == null || c.currentTimestamp == null || c.tokenAgeSeconds == null ||
      ![c.launchBlock, c.currentBlock, c.launchTimestamp, c.currentTimestamp, c.tokenAgeSeconds].every(Number.isSafeInteger) ||
      c.launchBlock > c.currentBlock || c.launchTimestamp > c.currentTimestamp || c.launchTimestamp <= 0 ||
      c.tokenAgeSeconds !== c.currentTimestamp - c.launchTimestamp || c.launchBlock < 0 ||
      !/^0x[0-9a-f]{64}$/i.test(c.launchBlockHash ?? "") || !/^0x[0-9a-f]{64}$/i.test(c.currentBlockHash ?? "") ||
      (c.launch && c.launchBlock !== c.launch.blockNumber)) return "UNVERIFIED_LAUNCH_AGE";
  // Wall time can only make a verified launch older; it is never used as launch time.
  if (Math.max(c.tokenAgeSeconds, now / 1000 - c.launchTimestamp) > state.config.PAPER_MAX_LAUNCH_AGE_SECONDS) return "STALE_LAUNCH";
  if (c.eventMode !== "LIVE") return "BACKFILL_EVENT";
  if (now / 1000 < c.currentTimestamp || now - c.currentTimestamp * 1000 > state.config.QUOTE_MAX_AGE_MS) return "STALE_CHAIN_EVIDENCE";
  return null;
}
export function isPaperTradeEligible(candidate: Candidate, state: PaperState, sizeUsd: number, now = Date.now()): Eligibility {
  const policy = getPaperStrategy(state.config), entryConfig = entryPolicyConfig(state.config);
  const reject = (reason: string, outcome: Eligibility["outcome"] = "PAPER_REJECT", details: string[] = []): Eligibility => ({ outcome, reason, details });
  if (candidate.decision === "VETO" || candidate.handoffs.some(h => h.outcome === "VETO")) return reject("GPTHEIST_VETO", "VETO");
  if (candidate.decision !== "WATCH" || !candidate.evidenceComplete || !completedWatch(candidate.handoffs)) return reject("INCOMPLETE_GPTHEIST_WATCH");
  if (!/^0x[0-9a-f]{40}$/i.test(candidate.tokenAddress) || !candidate.launchId) return reject("INVALID_CANDIDATE");
  const freshness = paperLaunchRejection(candidate, state, now);
  if (freshness) return reject(freshness);
  if (candidate.quote.status !== "AVAILABLE") return reject(candidate.quote.reason,
    candidate.quote.reason === "INSUFFICIENT_TRACTION" ? candidate.tractionDiagnostics && candidate.tractionDiagnostics.verifiedObservationCount < entryConfig.TRACTION_OBSERVATION_COUNT ? "OBSERVING" : candidate.recentTraction.status === "UNKNOWN" ? "OBSERVING" : "PAPER_REJECT" : "PAPER_REJECT", candidate.quote.details);
  if (candidate.launch && candidate.launch.pairToken !== `0x${"0".repeat(40)}`) return reject("UNSUPPORTED_PAIR", "NOT_TRADABLE");
  const regime = entryRegimeRejection(state, now);
  if (regime) return reject(regime);
  const q = candidate.quote.quote;
  const problem = quoteProblem(q, now, state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS);
  if (problem) return reject(problem, "NOT_TRADABLE");
  if (q.side !== "BUY" || q.tokenAddress.toLowerCase() !== candidate.tokenAddress.toLowerCase()) return reject("QUOTE_MISMATCH", "NOT_TRADABLE");
  if (candidate.launch && (!q.evidence || q.evidence.curve.toLowerCase() !== candidate.launch.curve.toLowerCase())) return reject("MISSING_QUOTE_PROVENANCE", "NOT_TRADABLE");
  const capacity = accountCapacity(state, now);
  if (!positive(sizeUsd) || sizeUsd < state.config.MIN_POSITION_USD) return reject("SIZE_NOT_EXECUTABLE", "PAPER_REJECT", [`requested_position_usd=${sizeUsd}; minimum=${state.config.MIN_POSITION_USD}; condition=!(sizeUsd>0 && sizeUsd>=MIN_POSITION_USD)=true`]);
  const entryCostUsd = sizeUsd + (q.costs.gasUsd ?? 0);
  if (entryCostUsd > capacity.equityUsd * capacity.maxPositionPercent / 100 + 1e-8) return reject("MAX_POSITION_EXPOSURE");
  if (capacity.exposureUsd + entryCostUsd > capacity.equityUsd * state.config.MAX_PORTFOLIO_EXPOSURE_PERCENT / 100 + 1e-8) return reject("MAX_PORTFOLIO_EXPOSURE");
  if (Math.abs(q.notionalUsd - sizeUsd) > 1e-8) return reject("QUOTE_SIZE_MISMATCH", "NOT_TRADABLE");
  if (q.liquidityUsd < sizeUsd) return reject("INSUFFICIENT_LIQUIDITY", "PAPER_REJECT", [`realLiquidityUsd=${q.liquidityUsd}; proposedUsd=${sizeUsd}`]);
  if (sizeUsd > q.liquidityUsd * state.config.MAX_REAL_LIQUIDITY_PERCENT / 100 + 1e-8) return reject("REAL_LIQUIDITY_CAP", "PAPER_REJECT", [`realLiquidityUsd=${q.liquidityUsd}; proposedUsd=${sizeUsd}; maxParticipationPercent=${state.config.MAX_REAL_LIQUIDITY_PERCENT}`]);
  if (q.costs.priceImpactPercent === null || q.costs.priceImpactPercent > state.config.MAX_ENTRY_IMPACT_PERCENT) return reject("PRICE_IMPACT_LIMIT");
  if (state.positions.some(p => p.tokenAddress.toLowerCase() === candidate.tokenAddress.toLowerCase())) return reject("DUPLICATE_POSITION");
  if (state.researchLedger?.[candidate.launchId]?.archivedClosed || state.trades.some(t => t.launchId === candidate.launchId)) return reject("LAUNCH_ALREADY_TRADED");
  if (state.positions.length >= state.config.MAX_OPEN_POSITIONS) return reject("MAX_OPEN_POSITIONS");
  if (dailyRealizedLoss(state, now) >= state.config.MAX_DAILY_LOSS_USD) return reject("DAILY_LOSS_LIMIT");
  if (sizeUsd + (q.costs.gasUsd ?? 0) > state.cash) return reject("INSUFFICIENT_PAPER_CASH");
  if (state.cash - sizeUsd - (q.costs.gasUsd ?? 0) < capacity.equityUsd * state.config.MIN_CASH_RESERVE_PERCENT / 100 - 1e-8) return reject("MIN_CASH_RESERVE");
  const sell = q.roundTrip?.sell;
  if (!sell) return reject("EXIT_QUOTE_UNAVAILABLE");
  if (!q.evidence || !sell.evidence || !q.tokenUnits || !/^[1-9][0-9]*$/.test(q.tokenUnits)) return reject("TOKEN_UNITS_UNVERIFIED");
  const sellProblem = quoteProblem(sell, now, state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS);
  if (sellProblem) return reject(sellProblem);
  if (sell.side !== "SELL" || sell.tokenAddress.toLowerCase() !== q.tokenAddress.toLowerCase() ||
      sell.tokenUnits !== q.tokenUnits || sell.quantity !== q.quantity || sell.blockNumber < q.blockNumber ||
      (q.evidence && (!sell.evidence || sell.evidence.tokenDecimals !== q.evidence.tokenDecimals || sell.evidence.curve !== q.evidence.curve))) return reject("TOKEN_UNITS_UNVERIFIED");
  if (sell.notionalUsd > sell.liquidityUsd) return reject("INVALID_QUOTE_LIQUIDITY", "PAPER_REJECT", [`sellUsd=${sell.notionalUsd}; realLiquidityUsd=${sell.liquidityUsd}`]);
  const roundTripLoss = roundTripLossPercent(q);
  if (roundTripLoss === null || roundTripLoss >= state.config.MAX_DOWNSIDE_PERCENT) return reject("ROUND_TRIP_COST_TOO_HIGH");
  const observation = sellObservation(sell, sizeUsd);
  if (!observation) return reject("CURVE_STATE_UNAVAILABLE", "PAPER_REJECT", ["Full SELL reserve evidence missing"]);
  const safety = ExitLiquiditySafetyGate(observation, state.liquidityHistory?.[candidate.launchId] ?? [], entryConfig);
  if (safety.reason) return reject(safety.reason, "PAPER_REJECT", safety.details);
  const traction = candidate.recentTraction;
  if (traction.status !== "VERIFIED" || (traction.progressChangeBps ?? 0) <= 0 ||
      !/^[1-9][0-9]*$/.test(traction.reserveChangeWei ?? "") || traction.toTimestamp == null ||
      now / 1000 - traction.toTimestamp < 0 || now / 1000 - traction.toTimestamp > state.config.PAPER_MAX_LAUNCH_AGE_SECONDS) return reject("INSUFFICIENT_TRACTION");
  if (candidate.launch) {
    const quality = entryQuality(candidate, q, now, policy);
    if (!quality.passed) return reject(quality.reason!, "PAPER_REJECT", [JSON.stringify(quality)]);
    const executable = entryExecutionQuality(q, state.liquidityHistory?.[candidate.launchId] ?? [], now, policy);
    if (!executable.passed) return reject(executable.reason!, "PAPER_REJECT", [JSON.stringify(executable)]);
  }
  if(policy.version===5) {
    const survival=LiquiditySurvivalGate(candidate,q,state,now);
    if(survival.result!=="V5_ENTRY_APPROVED") return reject(survival.result,"PAPER_REJECT",[JSON.stringify(survival)]);
  }
  return { outcome: "PAPER_ELIGIBLE", reason: "ALL_PAPER_GATES_CLEARED", details: ["SIMULATED_EXECUTION", "Social quality is unverified; gas and execution drift are excluded when unknown"] };
}
/** Every agent must finish in order. INFO is honest completion, not fabricated PASS evidence. */
export function completedWatch(handoffs: AgentHandoff[]): boolean {
  return handoffs.length === AGENTS.length && AGENTS.every((agent, index) => {
    const h = handoffs[index];
    return h?.agent === agent.name && h.sequence === index + 1 &&
      (["RIO", "LISBON", "PALERMO", "PROFESSOR"].includes(agent.name) ? h.outcome === "PASS" : ["PASS", "INFO"].includes(h.outcome));
  });
}
export function positionValue(p: Position): number { return p.current.notionalUsd - (p.current.side === "SELL" ? p.current.costs.gasUsd ?? 0 : 0); }
export function accountSummary(state: PaperState) {
  const realizedPnl = state.trades.reduce((sum, t) => sum + t.pnlUsd, state.archivedRealizedPnl ?? 0);
  const value = state.positions.reduce((sum, p) => sum + positionValue(p), 0);
  const unrealizedPnl = state.positions.reduce((sum, p) => sum + positionValue(p) - p.costBasisUsd, 0);
  const equity = state.cash + value;
  const freshValuation = state.positions.every(p => p.markStatus === "FRESH" && p.current.side === "SELL" &&
    !quoteProblem(p.current, Date.now(), state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS));
  return { currentExecutablePositionValueUsd: freshValuation ? value : null,
    freshUnrealizedPnlUsd: freshValuation ? unrealizedPnl : null, unrealizedPnlStatus: freshValuation ? "FRESH" : "UNAVAILABLE",
    lastKnownPositionValueUsd: value, costBasisUsd: state.positions.reduce((sum,p)=>sum+p.costBasisUsd,0),
    startingBalance: state.config.STARTING_BALANCE_USD, availableCash: state.cash, equity, realizedPnl, unrealizedPnl,
    totalPnl: equity - state.config.STARTING_BALANCE_USD, totalReturnPercent: (equity / state.config.STARTING_BALANCE_USD - 1) * 100 };
}
export function performance(state: PaperState): { totalTrades: number; wins: number; losses: number; winRate: number; grossProfit: number; grossLoss: number; netPnl: number; averageWin: number | null; averageLoss: number | null; profitFactor: number | null; expectancy: number | null; maximumDrawdown: number; maximumDrawdownUsd: number; peakEquity: number; averageHoldingTime: number | null; estimatedFees: { knownUsd: number; unknownFills: number }; estimatedSlippage: { knownUsd: number; unknownFills: number }; estimatedGasCosts: { knownUsd: number; unknownFills: number } } {
  const prior = state.archivedPerformance;
  const trades = state.trades;
  const wins = (prior?.wins ?? 0) + trades.filter(t => t.pnlUsd > 0).length;
  const losses = (prior?.losses ?? 0) + trades.filter(t => t.pnlUsd < 0).length;
  const totalTrades = (prior?.totalTrades ?? 0) + trades.length;
  const grossProfit = trades.filter(t => t.pnlUsd > 0).reduce((s,t)=>s+t.pnlUsd, prior?.grossProfit ?? 0);
  const grossLoss = trades.filter(t => t.pnlUsd < 0).reduce((s,t)=>s-t.pnlUsd, prior?.grossLoss ?? 0);
  let peakEquity = prior?.peakEquity ?? state.config.STARTING_BALANCE_USD;
  let maximumDrawdown = prior?.maximumDrawdown ?? 0, maximumDrawdownUsd = prior?.maximumDrawdownUsd ?? 0;
  for (const h of state.history) { peakEquity = Math.max(peakEquity,h.equity); maximumDrawdownUsd = Math.max(maximumDrawdownUsd,peakEquity-h.equity); maximumDrawdown = Math.max(maximumDrawdown,(peakEquity-h.equity)/peakEquity*100); }
  const fills = [...state.positions.map(p=>p.entry), ...trades.flatMap(t=>[t.entry,t.exit])];
  const cost = (key: keyof Costs, old: { knownUsd: number; unknownFills: number } | undefined) => ({ knownUsd: fills.reduce((s,q)=>s+(q.costs[key]??0),old?.knownUsd??0), unknownFills: (old?.unknownFills??0)+fills.filter(q=>q.costs[key]===null).length });
  const netPnl = grossProfit-grossLoss;
  return { totalTrades,wins,losses,winRate: totalTrades ? wins/totalTrades*100 : 0,grossProfit,grossLoss,netPnl,
    averageWin: wins ? grossProfit/wins : null, averageLoss: losses ? -grossLoss/losses : null,
    profitFactor: grossLoss ? grossProfit/grossLoss : null,expectancy: totalTrades ? netPnl/totalTrades : null,
    maximumDrawdown,maximumDrawdownUsd,peakEquity,
    averageHoldingTime: totalTrades ? (trades.reduce((s,t)=>s+Date.parse(t.exitedAt)-Date.parse(t.enteredAt),0)+(prior?.averageHoldingTime??0)*(prior?.totalTrades??0))/totalTrades : null,
    estimatedFees: cost("feesUsd",prior?.estimatedFees), estimatedSlippage: cost("slippageUsd",prior?.estimatedSlippage), estimatedGasCosts: cost("gasUsd",prior?.estimatedGasCosts) };
}

export function activity(state: PaperState, eventType: string, message: string, now: number, candidate?: Candidate, metadata: Record<string, unknown> = {}): void {
  if (["PAPER_REJECT", "NOT_TRADABLE", "OBSERVING", "QUOTE_UNAVAILABLE"].includes(eventType)) {
    const prior = [...state.events].reverse().find(e=>e.tokenAddress===(candidate?.tokenAddress??null) && e.eventType===eventType);
    if (prior?.message === message) {
      prior.metadata.firstOccurrence ??= prior.timestamp;
      prior.metadata.lastOccurrence = iso(now); prior.metadata.occurrences = Number(prior.metadata.occurrences ?? 1)+1; return;
    }
  }
  state.events.push({ timestamp: iso(now), category: "PAPER", stage: "PAPER", tokenAddress: candidate?.tokenAddress ?? null,
    tokenSymbol: candidate?.symbol ?? null, eventType, message, metadata });
}
export function recordEquity(state: PaperState, now: number): void {
  state.history.push({ timestamp: iso(now), equity: accountSummary(state).equity, stalePositions: state.positions.filter(p => p.markStatus !== "FRESH").length });
}
export function enterPaper(state: PaperState, candidate: Candidate, sizeUsd: number, now = Date.now(), plan?: PaperTradePlan): Eligibility {
  let result = isPaperTradeEligible(candidate, state, sizeUsd, now);
  if (candidate.tractionDiagnostics) result.details.push(`mint=${candidate.tokenAddress}`, `symbol=${candidate.symbol}`,
    `observation_count=${candidate.tractionDiagnostics.observationCount}`, `verified_observation_count=${candidate.tractionDiagnostics.verifiedObservationCount}`,
    `traction_window_seconds=${candidate.tractionDiagnostics.tractionWindowSeconds}`,
    `positive_reserve_change_detected=${candidate.tractionDiagnostics.positiveReserveChangeDetected}`,
    `positive_curve_change_detected=${candidate.tractionDiagnostics.positiveCurveChangeDetected}`,
    `traction_pass=${candidate.tractionDiagnostics.tractionPass}`, `exact_failure_reason=${candidate.tractionDiagnostics.exactFailureReason ?? "NONE"}`);
  if (result.reason === "BACKFILL_EVENT") {
    const occurredAt = candidate.eventOccurredAtMs ?? (candidate.launchTimestamp === null ? null : candidate.launchTimestamp * 1000);
    const isoOrUnknown = (timestamp: number | null | undefined): string => Number.isFinite(timestamp) ? new Date(timestamp!).toISOString() : "UNKNOWN";
    result.details.push(`mint=${candidate.tokenAddress}`, `source=${candidate.source ?? "UNKNOWN"}`, `source_event_id=${candidate.sourceEventId ?? candidate.launchId}`,
      `source_event_timestamp=${isoOrUnknown(occurredAt)}`, `discovered_at=${isoOrUnknown(candidate.discoveredAtMs)}`,
      `ingested_at=${isoOrUnknown(candidate.ingestedAtMs)}`, `normalized_at=${isoOrUnknown(candidate.normalizedAtMs)}`,
      `paper_engine_received_at=${isoOrUnknown(candidate.paperEngineReceivedAtMs)}`, `current_engine_time=${isoOrUnknown(now)}`,
      `event_age_seconds=${occurredAt === null ? "UNKNOWN" : ((now - occurredAt) / 1000).toFixed(3)}`,
      `classification=${candidate.eventMode}`, `classification_reason=${candidate.classificationReason ?? "EVENT_NOT_AFTER_PREVIOUS_HEAD"}`);
  }
    activity(state, result.outcome, result.reason, now, candidate, { details: result.details,
      ...(result.reason === "BACKFILL_EVENT" ? { eventProvenance: Object.fromEntries(result.details.map(detail => {
        const separator = detail.indexOf("="); return [detail.slice(0, separator), detail.slice(separator + 1)];
      })) } : {}) });
  const planStrategy = (plan?.strategyVersion === 4 || plan?.strategyVersion === 5) ? getPaperStrategy({ PAPER_STRATEGY_VERSION: plan.strategyVersion }, plan.account.equityUsd) : PAPER_STRATEGY;
  if (plan && (plan.strategyVersion ?? 0) >= 2 && sizeUsd > plan.account.equityUsd * planStrategy.maxTokenExposurePercent / 100 + 1e-8) {
    result = { outcome: "PAPER_REJECT", reason: "PLAN_GAP_RISK_CAP", details: [] };
  }
  if (plan && (Math.abs(plan.approvedSizeUsd - sizeUsd) > 1e-8 || sizeUsd * plan.exitPolicy.downsidePercent / 100 > plan.riskBudgetUsd + 1e-8)) {
    result = { outcome: "PAPER_REJECT", reason: "PLAN_RISK_BUDGET", details: [] };
  }
  const observation = state.researchLedger?.[candidate.launchId];
  if (observation) { observation.lastResult = result.reason; observation.lastOutcome = result.outcome; if (result.outcome === "PAPER_ELIGIBLE") observation.traded = true; }
  const recorded = structuredClone(candidate);
  if (recorded.quote.status === "AVAILABLE" && quoteProblem(recorded.quote.quote, now, state.config.QUOTE_MAX_AGE_MS)) {
    recorded.quote = { status: "NOT_PAPER_TRADABLE", reason: result.reason, details: ["Invalid or stale quote excluded from stored numeric evidence"] };
  }
  result.details = [...new Set(result.details.filter(d => d !== result.reason))];
  state.decisions.push({ ...result, timestamp: iso(now), candidate: recorded, sizeUsd: Number.isFinite(sizeUsd) ? sizeUsd : 0,
    gptheistVerdict: candidate.decision, paperVerdict: result.outcome, ...(plan ? { plan: structuredClone(plan) } : {}) });
  activity(state, result.outcome, result.reason, now, candidate, { details: result.details });
  state.latestGate = { stage: "PAPER", outcome: result.outcome, message: result.reason };
  if (result.outcome !== "PAPER_ELIGIBLE" || candidate.quote.status !== "AVAILABLE") return result;
  const q = structuredClone(candidate.quote.quote), costBasisUsd = sizeUsd + (q.costs.gasUsd ?? 0);
  const savedPlan = structuredClone(plan ?? proposeTradePlan(state, candidate, q, now));
  savedPlan.approvedSizeUsd = sizeUsd; savedPlan.entryQuote = q;
  savedPlan.exitLiquiditySafety = ExitLiquiditySafetyGate(sellObservation(q.roundTrip!.sell, sizeUsd)!, state.liquidityHistory?.[candidate.launchId] ?? [], entryPolicyConfig(state.config));
  state.cash -= costBasisUsd;
  state.positions.push({ id: randomUUID(), mode: "PAPER", execution: "SIMULATED", candidate: structuredClone(candidate),
    tokenAddress: candidate.tokenAddress, name: candidate.name, symbol: candidate.symbol, launchId: candidate.launchId,
    plan: savedPlan, management: initialManagement(), entry: q, current: structuredClone(q.roundTrip!.sell), quantity: q.quantity, sizeUsd, costBasisUsd, enteredAt: iso(now), markStatus: "UNAVAILABLE", markReason: "Awaiting independent exit quote" });
  markPaperPosition(state, state.positions.at(-1)!.id, { status: "AVAILABLE", quote: q.roundTrip!.sell }, now);
  activity(state, "PAPER_BUY", "SIMULATED position opened after PAPER_ELIGIBLE", now, candidate, { sizeUsd, quantity: q.quantity, fillPriceUsd: q.fillPriceUsd, source: q.source });
  recordEquity(state, now);
  return { ...result, outcome: "PAPER_BUY" };
}
export function markPaperPosition(state: PaperState, id: string, result: QuoteResult, now = Date.now()): boolean {
  const p = state.positions.find(p => p.id === id);
  if (!p) return false;
  p.lastQuoteAttempt = result.diagnostics?.attemptedAt ?? iso(now);
  if (result.diagnostics) {
    p.quoteDiagnostics = result.diagnostics;
    if (result.diagnostics.launchTimestamp) { p.launchTimestamp = result.diagnostics.launchTimestamp; p.launchBlockHash = result.diagnostics.launchBlockHash!; }
  }
  p.quoteFailureDetails = result.status === "AVAILABLE" ? [] : result.details;
  const q = result.status === "AVAILABLE" ? result.quote : null;
  const problem = q ? quoteProblem(q, now, state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS) ??
    (q.side !== "SELL" || q.tokenAddress.toLowerCase() !== p.tokenAddress.toLowerCase() || Math.abs(q.quantity - p.quantity) > p.quantity * 1e-10 ||
     (p.entry.tokenUnits && q.tokenUnits !== p.entry.tokenUnits) ? "QUOTE_MISMATCH" : null) : result.status === "NOT_PAPER_TRADABLE" ? result.reason : "QUOTE_UNAVAILABLE";
  const liquidity = !problem && q ? sellObservation(q) : failedSellObservation(result, p.tokenAddress, p.entry.evidence?.curve ?? "", now, state.config);
  if (liquidity && liquidity.tokenUnits === p.entry.tokenUnits) {
    const prior = p.management.liquidity?.current;
    const rows = appendLiquidityObservation(p.management.liquidity?.observations ?? [], liquidity, state.config);
    p.management.liquidity = ExitLiquiditySafetyGate(liquidity, rows, state.config);
    const before = prior?.realQuoteReserveWei ?? p.entry.roundTrip?.sell.evidence?.realQuoteReserve ?? p.entry.evidence?.realQuoteReserve;
    const drop = before && BigInt(before) > 0n ? Number(BigInt(before) - BigInt(liquidity.realQuoteReserveWei)) / Number(before) * 100 : 0;
    if(p.plan.strategyVersion===5) {
      const triggers=v5RiskTriggers(p,liquidity,prior);
      if(triggers.length) p.management.pendingExit ??= { reason:triggers.length>1?"MULTIPLE_TRIGGERS":triggers[0]!.reason, triggeredAt:iso(now), reasoning:triggers.map(t=>`${t.reason}: ${t.predicate}`) };
    }
    if (p.plan.strategyVersion!==5 && (liquidity.sellResult !== "AVAILABLE" || drop >= state.config.MAX_LIQUIDITY_DROP_PERCENT || p.management.liquidity.behavior === "COLLAPSING" ||
        ["EXIT_COVERAGE_TOO_LOW", "REAL_LIQUIDITY_TOO_LOW"].includes(p.management.liquidity.reason ?? ""))) {
      p.management.pendingExit ??= { reason: "LIQUIDITY_OR_QUOTE_DETERIORATION", triggeredAt: iso(now),
        reasoning: [...p.management.liquidity.details, `previousReserveWei=${before ?? "UNKNOWN"}; currentReserveWei=${liquidity.realQuoteReserveWei}; declinePercent=${drop}`] };
    }
    activity(state, "EXIT_LIQUIDITY_OBSERVED", liquidity.sellResult, now, p.candidate, { liquidity: p.management.liquidity });
  }
  if (problem || !q || q.notionalUsd > q.liquidityUsd || (q.costs.gasUsd ?? 0) >= q.notionalUsd) {
    p.markStatus = "UNAVAILABLE"; p.markReason = problem ?? (!q ? "QUOTE_UNAVAILABLE" : q.notionalUsd > q.liquidityUsd ? "INVALID_QUOTE_LIQUIDITY" : "EXIT_COST_EXCEEDS_PROCEEDS");
    if(p.plan.strategyVersion===5) p.management.pendingExit ??= {reason:p.markReason.includes("STALE")?"SELL_QUOTE_STALE":"SELL_QUOTE_UNAVAILABLE",triggeredAt:iso(now),reasoning:[`quoteFailure=${p.markReason}; no executable fill available; retry until a fresh full sell exists`]};
    p.management.quoteFailureCount++; p.management.consecutiveQuoteFailures++;
    if (p.management.pendingExit) p.management.exitExecutionStatus = "EXIT_TRIGGERED_BUT_UNEXECUTABLE";
    p.management.holdReason = `QUOTE UNAVAILABLE: ${p.markReason}; last successful value retained`;
    activity(state, "QUOTE_UNAVAILABLE", p.markReason, now, p.candidate, { diagnostics: result.diagnostics ?? null, lastSuccessfulQuoteAt: p.management.lastSuccessfulQuoteTimestamp });
    recordEquity(state, now); return false;
  }
  if (q.v4) {
    if (p.executionRoute?.pool !== q.v4.route.pool) activity(state, "MARKET_MIGRATION_DETECTED", "Validated full-position Uniswap v4 SELL", now, p.candidate,
      { token: p.tokenAddress, old_market: p.market ?? "PONS_V2_CURVE", new_market: "UNISWAP_V4", pool: q.v4.route.pool,
        quote_source: q.source, executable_sell_value: q.notionalUsd, liquidity: q.liquidityUsd });
    p.market = "UNISWAP_V4"; p.executionRoute = structuredClone(q.v4.route);
    // Curve reserve history cannot measure liquidity in a different market.
    delete p.management.liquidity;
  }
  p.management.exitExecutionStatus = "EXECUTABLE";
  p.current = structuredClone(q); p.markStatus = "FRESH"; p.markReason = null;
  p.management.lastSuccessfulQuote = structuredClone(q); p.management.lastSuccessfulQuoteTimestamp = q.timestamp;
  p.management.consecutiveQuoteFailures = 0;
  const value = positionValue(p), ret = (value / p.costBasisUsd - 1) * 100;
  p.management.entryLiquidationValueUsd ??= value;
  p.management.excursionTrackingSince ??= q.timestamp;
  p.management.mfePercent = Math.max(p.management.mfePercent ?? 0, ret, 0);
  p.management.maePercent = Math.min(p.management.maePercent ?? 0, ret, 0);
  p.management.state = ret >= p.plan.exitPolicy.profitArmPercent ? "RUNNER" :
    (p.management.peakReturnPercent ?? ret) >= p.plan.exitPolicy.profitArmPercent ? "PROFIT_PROTECTION" : "RISK";
  if (p.management.peakLiquidationValueUsd === null || value > p.management.peakLiquidationValueUsd) {
    p.management.peakLiquidationValueUsd = value; p.management.peakReturnPercent = ret; p.management.peakTimestamp = q.timestamp;
  }
  activity(state, "SELL_QUOTE_UPDATED", "Fresh full-quantity liquidation quote", now, p.candidate,
    { quote: q, liquidationValueUsd: value, mfePercent: p.management.mfePercent, maePercent: p.management.maePercent, pnlUsd: value - p.costBasisUsd, fillPriceUsd: q.fillPriceUsd, source: q.source });
  recordEquity(state, now); return true;
}
export type QuoteProvider = (position: Position) => Promise<QuoteResult>;
export async function monitorPaper(state: PaperState, provider: QuoteProvider, clock = Date.now): Promise<void> {
  const get = async (p: Position): Promise<QuoteResult> => {
    try { return await provider(structuredClone(p)); }
    catch { return { status: "NOT_PAPER_TRADABLE", reason: "QUOTE_UNAVAILABLE", details: ["RPC failure; last valuation retained"] }; }
  };
  await Promise.all([...state.positions].map(async p => {
    const hadPendingExit = p.management.pendingExit !== null;
    const fresh = markPaperPosition(state, p.id, await get(p), clock());
    if (!fresh && (hadPendingExit || !p.management.pendingExit)) return;
    const decision = p.management.pendingExit ?? (fresh ? evaluateExit(p, clock()) : null);
    if (!decision) return;
    // Once triggered, a risk exit remains pending through outages. Never sell an old quote.
    p.management.pendingExit = decision;
    activity(state, "DYNAMIC_EXIT_CONDITION_MET", decision.reason, clock(), p.candidate, { reasoning: decision.reasoning });
    const finalQuote = await get(p);
    if (!markPaperPosition(state, p.id, finalQuote, clock()) || finalQuote.status !== "AVAILABLE") return;
    const now = clock(), q = structuredClone(finalQuote.quote), value = positionValue(p);
    const pnlUsd = value - p.costBasisUsd, returnPercent = pnlUsd / p.costBasisUsd * 100;
    state.cash += value;
    state.trades.push({ ...p, exit: q, exitedAt: iso(now), pnlUsd, returnPercent, exitReason: decision.reason, exitReasoning: decision.reasoning });
    state.positions = state.positions.filter(position => position.id !== p.id);
    activity(state, "SIMULATED_SELL", decision.reason, now, p.candidate, { pnlUsd, returnPercent, finalQuote: q });
    activity(state, "REALIZED_PNL_RECORDED", "Final quoted proceeds credited to paper cash", now, p.candidate, { pnlUsd, returnPercent });
    recordEquity(state, now);
  }));
}
/** WATCH remains the research verdict; eligibility is a separate paper decision. */
export function liveCandidate(launch: LiveLaunchDecision): Candidate {
  const chronology: LaunchEvidence = launch.chronology ?? unknownLaunchEvidence(launch.blockNumber);
  return { ...chronology, launch, tokenAddress: launch.token, name: launch.metadata.status === "DECLARED" ? launch.metadata.name : launch.token,
    symbol: launch.metadata.status === "DECLARED" ? launch.metadata.symbol : "—", launchId: `${launch.transactionHash}:${launch.logIndex}`,
    decision: launch.verdict, evidenceComplete: launch.market.status === "VERIFIED" && completedWatch(launch.handoffs), handoffs: launch.handoffs,
    quote: unavailablePonsQuote(launch) };
}
export function unavailablePonsQuote(launch?: LiveLaunchDecision): QuoteResult {
  return { status: "NOT_PAPER_TRADABLE", reason: launch && launch.market.status !== "VERIFIED" ? "MARKET_UNAVAILABLE" : "QUOTE_NOT_REQUESTED",
    details: [] };
}
export type EntryQuoteProvider = (launch: LiveLaunchDecision, sizeUsd: number) => Promise<QuoteResult>;
/** Build independent exit evidence during inflow confirmation, before the entry signal matures. */
async function observeEntryLiquidity(state: PaperState, candidate: Candidate, quotes: EntryQuoteProvider, clock: () => number): Promise<void> {
  if (accountCapacity(state, clock()).equityUsd * getPaperStrategy(state.config, accountCapacity(state, clock()).equityUsd).maxTokenExposurePercent / 100 < state.config.MIN_POSITION_USD) return;
  if (!candidate.launch || paperLaunchRejection(candidate, state, clock()) || entryRegimeRejection(state, clock()) ||
      state.positions.length >= state.config.MAX_OPEN_POSITIONS || dailyRealizedLoss(state, clock()) >= state.config.MAX_DAILY_LOSS_USD ||
      accountCapacity(state, clock()).availableCapacityUsd < state.config.MIN_POSITION_USD) return;
  const history = state.liquidityHistory?.[candidate.launchId] ?? [];
  if (history.at(-1)?.block === candidate.currentBlock) return;
  const rows = candidate.tractionDiagnostics?.observations ?? [], last = rows.at(-1), previous = rows.at(-2);
  if (!last || !previous || last.verificationStatus !== "VERIFIED" || previous.verificationStatus !== "VERIFIED" ||
      !last.reserve || !previous.reserve || BigInt(last.reserve) <= BigInt(previous.reserve) ||
      (last.curveProgressBps ?? 0) <= (previous.curveProgressBps ?? 0)) return;
  let result: QuoteResult;
  try { result = await quotes(candidate.launch, state.config.MIN_POSITION_USD); }
  catch { return; }
  if (result.status !== "AVAILABLE" || quoteProblem(result.quote, clock(), state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS)) return;
  const q = result.quote, sell = q.roundTrip?.sell;
  if (!sell || q.side !== "BUY" || q.tokenAddress.toLowerCase() !== candidate.tokenAddress.toLowerCase() ||
      !q.tokenUnits || !/^[1-9][0-9]*$/.test(q.tokenUnits) || q.evidence?.curve.toLowerCase() !== candidate.launch.curve.toLowerCase() ||
      Math.abs(q.notionalUsd - state.config.MIN_POSITION_USD) > 1e-8 || sell.tokenAddress.toLowerCase() !== candidate.tokenAddress.toLowerCase() ||
      sell.tokenUnits !== q.tokenUnits || sell.quantity !== q.quantity || sell.blockNumber < q.blockNumber ||
      sell.evidence?.curve.toLowerCase() !== candidate.launch.curve.toLowerCase() ||
      quoteProblem(sell, clock(), state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS)) return;
  const observation = sellObservation(sell, state.config.MIN_POSITION_USD);
  if (!observation) return;
  (state.liquidityHistory ??= {})[candidate.launchId] = appendLiquidityObservation(history, observation, state.config);
  activity(state, "PRE_ENTRY_LIQUIDITY_OBSERVED", "Minimum-size round trip sampled during inflow confirmation; no entry authorized", clock(), candidate, { observation });
}
export function observeCandidateTraction(state: PaperState, candidate: Candidate, snapshot: LiveSnapshot, clock: () => number): TractionDiagnostics {
  const config = entryPolicyConfig(state.config);
  const historyMap = state.tractionHistory ??= {};
  const key = candidate.launchId;
  const rows = historyMap[key] ??= [];
  const block = candidate.currentBlock, timestamp = candidate.currentTimestamp;
  const market = candidate.launch?.market;
  const sourceEventId = candidate.sourceEventId ?? candidate.launchId;
  if (rows.some(row => row.token.toLowerCase() !== candidate.tokenAddress.toLowerCase() || row.sourceEventId !== sourceEventId)) rows.length = 0;
  let previous = rows.at(-1);
  const sameBlockReorg = previous && block === previous.block && candidate.currentBlockHash && previous.blockHash &&
    candidate.currentBlockHash.toLowerCase() !== previous.blockHash.toLowerCase();
  if (sameBlockReorg) { rows.length = 0; previous = undefined; }
  const verified = block !== null && timestamp !== null && block === snapshot.headBlock &&
    candidate.currentBlockHash !== null && candidate.currentBlockHash !== undefined && market?.status === "VERIFIED" &&
    clock() / 1000 - timestamp >= 0 && clock() / 1000 - timestamp <= state.config.QUOTE_MAX_AGE_MS / 1000;
  if (block !== null && timestamp !== null && (!previous || block > previous.block || sameBlockReorg)) {
    const reserve = verified ? market!.realQuoteReserve : null, progress = verified ? market!.progressBps : null;
    const previousVerified = [...rows].reverse().find(row => row.verificationStatus === "VERIFIED");
    const previousReserve = previousVerified?.reserve ?? null;
    const previousProgress = previousVerified?.curveProgressBps ?? null;
    const delta = previousReserve === null || reserve === null ? null : (BigInt(reserve) - BigInt(previousReserve)).toString();
    const reservePct = delta === null || previousReserve === null || BigInt(previousReserve) === 0n ? null : Number(BigInt(delta)) / Number(BigInt(previousReserve)) * 100;
    rows.push({ token: candidate.tokenAddress, symbol: candidate.symbol, sourceEventId,
      block, blockHash: candidate.currentBlockHash ?? null, timestamp: new Date(timestamp * 1000).toISOString(), reserve, previousReserve, reserveDelta: delta, reserveDeltaPct: reservePct,
      curveProgressBps: progress, previousCurveProgressBps: previousProgress,
      curveProgressDeltaBps: previousProgress === null || progress === null ? null : progress - previousProgress,
      verificationStatus: verified ? "VERIFIED" : "UNAVAILABLE", quoteStatus: candidate.quote.status === "AVAILABLE" ? "AVAILABLE" : candidate.quote.reason });
  }
  const cutoff = (candidate.currentTimestamp ?? Math.floor(clock()/1000)) - config.TRACTION_WINDOW_SECONDS;
  const observations = rows.filter(row => Date.parse(row.timestamp) / 1000 >= cutoff).slice(-100);
  historyMap[key] = observations;
  const recent = observations.filter(row => row.verificationStatus === "VERIFIED");
  const first = recent[0], last = recent.at(-1);
  const enough = recent.length >= config.TRACTION_OBSERVATION_COUNT && !!first && !!last &&
    Date.parse(last.timestamp) - Date.parse(first.timestamp) >= config.TRACTION_OBSERVATION_MIN_MS && last.block > first.block;
  const reserveDelta = enough ? BigInt(last!.reserve!) - BigInt(first!.reserve!) : null;
  const curveDelta = enough ? last!.curveProgressBps! - first!.curveProgressBps! : null;
  const positiveReserveChangeDetected = reserveDelta !== null && reserveDelta > 0n;
  const positiveCurveChangeDetected = curveDelta !== null && curveDelta > 0;
  const tractionPass = enough && positiveReserveChangeDetected && positiveCurveChangeDetected;
  const exactFailureReason = tractionPass ? null : !enough ? "TRACTION_HISTORY_INSUFFICIENT" :
    !positiveReserveChangeDetected && !positiveCurveChangeDetected ? "NO_POSITIVE_RESERVE_OR_CURVE_CHANGE" :
    !positiveReserveChangeDetected ? "NO_POSITIVE_RESERVE_CHANGE" : "NO_POSITIVE_CURVE_PROGRESS_CHANGE";
  const diagnostics: TractionDiagnostics = { observationCount: observations.length, verifiedObservationCount: recent.length, observations,
    tractionWindowSeconds: config.TRACTION_WINDOW_SECONDS, positiveReserveChangeDetected,
    positiveCurveChangeDetected, tractionPass, exactFailureReason };
  candidate.tractionDiagnostics = diagnostics;
  candidate.recentTraction = { ...candidate.recentTraction,
    status: !enough ? "UNKNOWN" : tractionPass ? "VERIFIED" : "WEAK",
    ...(first ? { fromBlock: first.block, fromTimestamp: Date.parse(first.timestamp)/1000 } : {}),
    ...(last ? { toBlock: last.block, toTimestamp: Date.parse(last.timestamp)/1000 } : {}),
    ...(reserveDelta !== null ? { reserveChangeWei: reserveDelta.toString() } : {}),
    ...(curveDelta !== null ? { progressChangeBps: curveDelta } : {}),
    explanation: exactFailureReason ?? "Verified reserve and curve progress both increased across the configured observation window" };
  const ledger = state.researchLedger?.[key];
  if (ledger) { ledger.lastOutcome = tractionPass ? "TRACTION_PASS" : "OBSERVING"; ledger.lastResult = exactFailureReason; }
  return diagnostics;
}
export async function observeSnapshot(state: PaperState, snapshot: LiveSnapshot, now = Date.now(), quotes?: EntryQuoteProvider, clock: () => number = () => now): Promise<void> {
  if (snapshot.fetchedAt === state.lastSnapshotAt) return;
  state.lastSnapshotAt = snapshot.fetchedAt;
  for (const [map, window] of [[state.liquidityHistory, state.config.LIQUIDITY_OBSERVATION_WINDOW_MS],
    [state.tractionHistory, state.config.TRACTION_WINDOW_SECONDS * 1000]] as const) if (map) {
      for (const [id, rows] of Object.entries(map)) if (!rows.length || now - Date.parse(rows.at(-1)!.timestamp) > window) delete map[id];
    }
  const previousHead = state.lastObservedHeadBlock;
  const latest = snapshot.launches[0];
  if (latest) state.latestGate = { stage: "PROFESSOR", outcome: latest.verdict, message: latest.handoffs.at(-1)?.message ?? "" };
  for (const sourceLaunch of [...snapshot.launches].sort((a,b)=>b.blockNumber-a.blockNumber||b.logIndex-a.logIndex)) {
    const chronology = sourceLaunch.chronology ?? unknownLaunchEvidence(sourceLaunch.blockNumber);
    const sourceId = `${sourceLaunch.transactionHash}:${sourceLaunch.logIndex}`;
    const priorLedger = state.researchLedger?.[sourceId];
    const samePreviouslyLiveEvent = priorLedger?.eventMode === "LIVE" && priorLedger.sourceEventId === sourceId;
    const isNewSincePersistedHead = previousHead !== null && sourceLaunch.blockNumber > previousHead &&
      chronology.launchTimestamp !== null && chronology.currentBlock === snapshot.headBlock;
    const launch = isNewSincePersistedHead || samePreviouslyLiveEvent ? { ...sourceLaunch, chronology: { ...chronology,
      eventMode: "LIVE" as const, classificationReason: "EVENT_AFTER_PERSISTED_HEAD" } } : sourceLaunch;
    const candidate = liveCandidate(launch); candidate.paperEngineReceivedAtMs = clock();
    const ledger = state.researchLedger ??= {};
    const observation = ledger[candidate.launchId] ??= { firstObservedAt: iso(candidate.firstObservedAtMs ?? clock()),
      firstObservedAtMs: candidate.firstObservedAtMs ?? clock(), lastObservedAt: iso(clock()), observations: 0, lastResult: null, traded: false };
    if (observation.sourceEventId && candidate.sourceEventId && observation.sourceEventId !== candidate.sourceEventId) {
      candidate.eventMode = "BACKFILL"; candidate.classificationReason = "EVENT_ID_CONFLICT_FOR_LAUNCH_ID";
    }
    if (candidate.sourceEventId !== undefined) observation.sourceEventId ??= candidate.sourceEventId;
    if (candidate.eventOccurredAtMs !== undefined) observation.sourceEventTimestampMs ??= candidate.eventOccurredAtMs;
    observation.eventMode = candidate.eventMode;
    if (candidate.classificationReason !== undefined) observation.classificationReason = candidate.classificationReason;
    if (candidate.eventMode === "LIVE" && candidate.decision === "WATCH") {
      const watchlist = state.tractionWatchlist ??= {};
      watchlist[candidate.launchId] = structuredClone(launch);
    }
    candidate.firstObservedAtMs = observation.firstObservedAtMs ?? Date.parse(observation.firstObservedAt);
    observation.lastObservedAt = iso(clock()); observation.observations++;
    if (candidate.eventMode === "BACKFILL" && observation.observations > 1) continue;
    const traction = observeCandidateTraction(state, candidate, snapshot, clock);
    activity(state, "CANDIDATE_OBSERVATION", candidate.eventMode === "LIVE" ? "LIVE token sampled and retained" : "Candidate chronology classified BACKFILL",
      clock(), candidate, { mint: candidate.tokenAddress, symbol: candidate.symbol, observationCount: traction.observationCount,
        observations: traction.observations, tractionWindowSeconds: traction.tractionWindowSeconds,
        positiveReserveChangeDetected: traction.positiveReserveChangeDetected, positiveCurveChangeDetected: traction.positiveCurveChangeDetected,
        tractionPass: traction.tractionPass, exactFailureReason: traction.exactFailureReason,
        eventMode: candidate.eventMode, sourceEventId: candidate.sourceEventId });
    for (const h of candidate.handoffs) state.events.push({ timestamp: h.timestamp, category: "RESEARCH", stage: h.agent,
      tokenAddress: launch.token, tokenSymbol: candidate.symbol, eventType: h.outcome, message: h.message, metadata: { launchId: candidate.launchId, block: snapshot.headBlock } });
    if (observation.traded) continue;
    if (state.positions.some(p=>p.tokenAddress.toLowerCase()===candidate.tokenAddress.toLowerCase()) || state.trades.some(t=>t.launchId===candidate.launchId)) continue;
    if (candidate.decision === "WATCH" && candidate.evidenceComplete && quotes) {
      const age = clock() - Date.parse(snapshot.fetchedAt);
      if (!Number.isFinite(age) || age < 0 || age > state.config.QUOTE_MAX_AGE_MS) {
        candidate.quote = { status:"NOT_PAPER_TRADABLE",reason:"STALE_RESEARCH",details:[] };
        enterPaper(state, candidate, state.config.MIN_POSITION_USD, clock());
      }
      else {
        await observeEntryLiquidity(state, candidate, quotes, clock);
        await preparePaperTrade(state,candidate,quotes,clock);
      }
    } else if (candidate.decision === "WATCH" && !traction.tractionPass) {
      candidate.quote = { status:"NOT_PAPER_TRADABLE", reason:"INSUFFICIENT_TRACTION", details:[traction.exactFailureReason ?? "TRACTION_HISTORY_INSUFFICIENT"] };
      enterPaper(state,candidate,state.config.MIN_POSITION_USD,clock());
    } else enterPaper(state,candidate,state.config.MIN_POSITION_USD,clock());
    const latestTraction = state.tractionHistory?.[candidate.launchId]?.at(-1);
    const finalQuoteStatus = candidate.quote.status === "AVAILABLE" ? "AVAILABLE" :
      candidate.quote.reason === "INSUFFICIENT_TRACTION" ? "NOT_REQUESTED_TRACTION_GATE" : candidate.quote.reason;
    if (latestTraction) latestTraction.quoteStatus = finalQuoteStatus;
    if (traction.observations.length && traction.observations.at(-1)?.block === latestTraction?.block)
      traction.observations[traction.observations.length - 1]!.quoteStatus = finalQuoteStatus;
    activity(state, "CANDIDATE_TRACTION_EVALUATED", traction.tractionPass ? "Verified traction passed" : "Candidate remains under traction observation",
      clock(), candidate, { mint: candidate.tokenAddress, symbol: candidate.symbol, observationCount: traction.observationCount,
        verifiedObservationCount: traction.verifiedObservationCount, observations: traction.observations,
        tractionWindowSeconds: traction.tractionWindowSeconds, positiveReserveChangeDetected: traction.positiveReserveChangeDetected,
        positiveCurveChangeDetected: traction.positiveCurveChangeDetected, tractionPass: traction.tractionPass,
        exactFailureReason: traction.exactFailureReason, quoteStatus: finalQuoteStatus });
    if (candidate.decision !== "WATCH" || candidate.eventMode !== "LIVE" || state.positions.some(p=>p.launchId===candidate.launchId) || state.trades.some(t=>t.launchId===candidate.launchId)) {
      if (state.tractionWatchlist) delete state.tractionWatchlist[candidate.launchId];
    }
  }
  state.lastObservedHeadBlock = Math.max(state.lastObservedHeadBlock ?? 0, snapshot.headBlock);
  recordEquity(state,now);
}

/** Separate experimental paper policy and sizing; never rewrites the GPTHEIST verdict. */
export async function preparePaperTrade(state: PaperState, candidate: Candidate, quotes: EntryQuoteProvider, clock = Date.now): Promise<void> {
  const policy = getPaperStrategy(state.config, accountCapacity(state, clock()).equityUsd);
  if (!candidate.launch) return;
  if (paperLaunchRejection(candidate, state, clock())) { enterPaper(state, candidate, state.config.MIN_POSITION_USD, clock()); return; }
  if ((candidate.tractionDiagnostics?.tractionPass !== true || candidate.recentTraction.status !== "VERIFIED" || (candidate.recentTraction.progressChangeBps ?? 0) <= 0 ||
      !/^[1-9][0-9]*$/.test(candidate.recentTraction.reserveChangeWei ?? ""))) {
    candidate.quote = { status: "NOT_PAPER_TRADABLE", reason: "INSUFFICIENT_TRACTION", details: [candidate.tractionDiagnostics?.exactFailureReason ?? "TRACTION_HISTORY_INSUFFICIENT", "requires positive verified reserve and curve-progress change"] };
    enterPaper(state, candidate, state.config.MIN_POSITION_USD, clock()); return;
  }
  const regime = entryRegimeRejection(state, clock());
  if (regime) {
    candidate.quote = { status: "NOT_PAPER_TRADABLE", reason: regime, details: [`New entries pause for ${policy.lossStreakPauseMs / 60_000} minutes after ${policy.lossStreakLimit} consecutive v${policy.version} losses; open-position exits continue`] };
    enterPaper(state, candidate, state.config.MIN_POSITION_USD, clock()); return;
  }
  const quality = entryQuality(candidate, undefined, clock(), policy);
  if (!quality.passed) {
    candidate.quote = { status: "NOT_PAPER_TRADABLE", reason: quality.reason!, details: [JSON.stringify(quality)] };
    enterPaper(state, candidate, state.config.MIN_POSITION_USD, clock()); return;
  }
  activity(state, "TRACTION_CONFIRMED", "Positive verified reserve and progress changes", clock(), candidate, { traction: candidate.recentTraction });
  const get = async (size: number, observe = false): Promise<QuoteResult> => {
    try {
      const result = await quotes(candidate.launch!, size);
      const sell = result.status === "AVAILABLE" ? result.quote.roundTrip?.sell : undefined;
      const failedSell = result.diagnostics?.roundTripSell ?? result;
      const observation = sell && !quoteProblem(sell, clock(), state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS) ? sellObservation(sell, size) :
        failedSellObservation(failedSell, candidate.tokenAddress, candidate.launch!.curve, clock(), state.config);
      if (observe && observation) {
        {
          const history = state.liquidityHistory ??= {};
          history[candidate.launchId] = appendLiquidityObservation(history[candidate.launchId] ?? [], observation, state.config);
          activity(state, "PRE_ENTRY_LIQUIDITY_OBSERVED", "Independent pinned full-position SELL observation", clock(), candidate, { observation });
        }
      }
      return result;
    }
    catch { return { status: "NOT_PAPER_TRADABLE", reason: "QUOTE_UNAVAILABLE", details: [] }; }
  };
  const reject = (reason: string, size: number, details: string[] = []): void => {
    candidate.quote = { status: "NOT_PAPER_TRADABLE", reason, details: [...new Set(details)] };
    enterPaper(state, candidate, size, clock());
  };
  const capacity = accountCapacity(state, clock());
  // Quote the allocation we could actually use, rather than a larger account-capacity probe.
  let probeSize = Math.min(capacity.availableCapacityUsd,
    Math.floor(capacity.equityUsd * policy.maxTokenExposurePercent) / 100);
  if (probeSize < state.config.MIN_POSITION_USD) {
    reject("ACCOUNT_TOO_SMALL_FOR_STRATEGY", probeSize, [`strategy_cap_usd=${probeSize}; minimum_trade_usd=${state.config.MIN_POSITION_USD}; strategy_allocation_percent=${policy.maxTokenExposurePercent}; required_equity_before_gas_usd=${state.config.MIN_POSITION_USD * 100 / policy.maxTokenExposurePercent}`]); return;
  }
  if (capacity.availableCapacityUsd < state.config.MIN_POSITION_USD) { reject("INSUFFICIENT_PAPER_CAPACITY", 0); return; }
  candidate.quote = await get(probeSize);
  while (candidate.quote.status !== "AVAILABLE" && ["GRADUATION_FILL_UNSUPPORTED", "INVALID_SIZE", "INSUFFICIENT_LIQUIDITY"].includes(candidate.quote.reason) && probeSize / 2 >= state.config.MIN_POSITION_USD) {
    probeSize = Math.floor(probeSize * 50) / 100; candidate.quote = await get(probeSize);
  }
  if (candidate.quote.status !== "AVAILABLE") { enterPaper(state, candidate, probeSize, clock()); return; }
  const problem = quoteProblem(candidate.quote.quote, clock(), state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS);
  if (problem) { reject(problem, 0); return; }
  activity(state, "QUOTE_VERIFIED", "Fresh sized curve quote and ETH/USD reference", clock(), candidate);
  let plan = proposeTradePlan(state, candidate, candidate.quote.quote, clock());
  let size = Math.min(plan.proposedSizeUsd, probeSize);
  let iterations = 0;
  const attempts: PaperTradePlan["sizingAttempts"] = [];
  while (size >= state.config.MIN_POSITION_USD && iterations++ < 12) {
    candidate.quote = await get(size, true);
    if (candidate.quote.status === "AVAILABLE") {
      const gate = isPaperTradeEligible(candidate, state, size, clock());
      attempts.push({ sizeUsd: size, outcome: gate.reason, impactPercent: candidate.quote.quote.costs.priceImpactPercent });
      if (gate.outcome === "PAPER_ELIGIBLE") {
        // Re-evaluate the risk budget against the approved-size quote, never enlarge it here.
        const refreshed = proposeTradePlan(state, candidate, candidate.quote.quote, clock());
        if (refreshed.proposedSizeUsd + 1e-8 < size) { size = refreshed.proposedSizeUsd; plan = refreshed; continue; }
        plan = { ...refreshed, proposedSizeUsd: plan.proposedSizeUsd, approvedSizeUsd: size, sizingAttempts: attempts };
        activity(state, "PAPER_ELIGIBLE", "WATCH passed separate quote and paper risk policy", clock(), candidate);
        activity(state, "POSITION_SIZE_CALCULATED", `Dynamic size $${size.toFixed(2)}`, clock(), candidate, { riskBudgetUsd: plan.riskBudgetUsd, attempts });
        activity(state, "TRADE_PLAN_CREATED", plan.riskClass, clock(), candidate, { reasoning: plan.reasoning, exitPolicy: plan.exitPolicy });
        // A distinct final read is mandatory after planning; a failed quote never fills.
        candidate.quote = await get(size, true);
        if (candidate.quote.status !== "AVAILABLE") { enterPaper(state, candidate, size, clock()); return; }
        const finalProblem = quoteProblem(candidate.quote.quote, clock(), state.config.QUOTE_MAX_AGE_MS, state.config.ETH_USD_MAX_AGE_MS);
        if (finalProblem) { reject(finalProblem, size); return; }
        const finalPlan = proposeTradePlan(state, candidate, candidate.quote.quote, clock());
        if (finalPlan.proposedSizeUsd + 1e-8 < size) { reject("FINAL_QUOTE_RISK_CHANGED", size); return; }
        plan = { ...finalPlan, proposedSizeUsd: plan.proposedSizeUsd, approvedSizeUsd: size, sizingAttempts: attempts };
        enterPaper(state, candidate, size, clock(), plan); return;
      }
      if (gate.reason === "ENTRY_FRICTION_TOO_HIGH" && policy.version === 4 && (candidate.quote.quote.costs.gasUsd ?? 0) > 0) { enterPaper(state, candidate, size, clock()); return; }
      if (!["PRICE_IMPACT_LIMIT", "INSUFFICIENT_LIQUIDITY", "ENTRY_FRICTION_TOO_HIGH", "EXIT_COVERAGE_TOO_LOW", "REAL_LIQUIDITY_CAP"].includes(gate.reason)) { enterPaper(state, candidate, size, clock()); return; }
    } else {
      attempts.push({ sizeUsd: size, outcome: candidate.quote.reason, impactPercent: null });
      if (!["GRADUATION_FILL_UNSUPPORTED", "INVALID_SIZE", "INSUFFICIENT_LIQUIDITY"].includes(candidate.quote.reason)) { enterPaper(state, candidate, size, clock()); return; }
    }
    size = Math.floor(size * 50) / 100;
  }
  const last = candidate.quote;
  const q = last.status === "AVAILABLE" ? last.quote : null;
  const maxExecutableUsd = q ? Math.min(accountCapacity(state, clock()).availableCapacityUsd,
    q.liquidityUsd * state.config.MAX_REAL_LIQUIDITY_PERCENT / 100) : accountCapacity(state, clock()).availableCapacityUsd;
  const stopCondition = iterations >= 12 ? "iterations>=12" : `size=${size}<MIN_POSITION_USD(${state.config.MIN_POSITION_USD})`;
  reject("SIZE_NOT_EXECUTABLE", size, [...attempts.map(a => JSON.stringify(a)),
    `requested_position_usd=${size}; token_amount=${q?.quantity ?? "UNAVAILABLE"}; token_units=${q?.tokenUnits ?? "UNAVAILABLE"}`,
    `buy_quote_available=${last.status === "AVAILABLE"}; expected_output_raw=${q?.evidence?.amountOut ?? "UNAVAILABLE"}; expected_output=${q?.humanAmountOut ?? "UNAVAILABLE"}`,
    `price_impact=${q?.costs.priceImpactPercent ?? "UNAVAILABLE"}; slippage=${q?.costs.slippageUsd ?? "UNAVAILABLE"}`,
    `available_liquidity_usd=${q?.liquidityUsd ?? "UNAVAILABLE"}; real_exit_reserve_wei=${q?.evidence?.realQuoteReserve ?? "UNAVAILABLE"}; quote_reserve_wei=${q?.evidence?.quoteReserve ?? "UNAVAILABLE"}`,
    `max_executable_usd=${maxExecutableUsd}; quote_source=${q?.source ?? "UNAVAILABLE"}`,
    `exact_SIZE_NOT_EXECUTABLE_condition=${stopCondition}`]);
}

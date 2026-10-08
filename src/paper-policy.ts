import { LiquiditySurvivalGate, AdaptiveProfitExit, type SurvivalResult } from "./paper-v5.js";
import { getPaperStrategy, entryPolicyConfig, PAPER_SCALP_STRATEGY, entryQuality, entryExecutionQuality, roundTripLossPercent, type EntryQuality, type EntryExecutionQuality } from "./paper-strategy.js";
import { sellObservation, ExitLiquiditySafetyGate, type LiquiditySafety } from "./paper-liquidity.js";
import { quoteProblem, type Candidate, type PaperQuote, type PaperState, type Position } from "./paper.js";

export interface ExitPolicy {
  takeProfitPercent?: number;
  profitFloorPercent?: number; stagnationMs?: number;
  downsidePercent: number;
  profitArmPercent: number;
  trailingDrawdownPercent: number;
  maxHoldMs: number;
  reserveDropPercent: number;
  taxIncreaseBps: number;
  maxExitImpactPercent: number;
  graduationProgressBps: number;
  reasons: string[];
}
export interface PaperTradePlan {
  survival?: SurvivalResult; strategyVersion?: number; entryQuality?: EntryQuality; entryExecutionQuality?: EntryExecutionQuality;
  exitLiquiditySafety?: LiquiditySafety;
  version: 1; createdAt: string; experimental: true;
  gptheistVerdict: "WATCH"; paperVerdict: "PAPER_ELIGIBLE";
  riskClass: "ELEVATED" | "HIGH" | "VERY_HIGH"; riskScore: number; riskReasons: string[];
  riskBudgetUsd: number; proposedSizeUsd: number; approvedSizeUsd: number;
  account: { equityUsd: number; cashUsd: number; exposureUsd: number; availableCapacityUsd: number };
  inputs: { palermoScore: number | null; curveProgressBps: number | null; creatorTaxBps: number | null;
    snipeTaxBps: number | null; protocolFeeBps: number | null; impactPercent: number | null;
    realLiquidityUsd: number; quoteReserve: string | null; realQuoteReserve: string | null };
  exitPolicy: ExitPolicy; sizingAttempts: { sizeUsd: number; outcome: string; impactPercent: number | null }[];
  entryQuote: PaperQuote; sources: string[]; reasoning: string[];
}
export const EXIT_REASONS = ["DYNAMIC_RISK_EXIT", "PROFIT_PROTECTION", "TRAILING_EXIT", "MAX_HOLD_EXIT",
  "SIGNAL_DETERIORATION", "TAX_CHANGE", "LIQUIDITY_OR_QUOTE_DETERIORATION", "GRADUATION_TRANSITION", "STAGNATION_EXIT", "SCALP_TAKE_PROFIT", "RESERVE_DRAWDOWN", "RAPID_RESERVE_OUTFLOW", "EXECUTABLE_PRICE_COLLAPSE", "EXIT_COVERAGE_FAILURE", "EXIT_PARTICIPATION_BREACH", "INSUFFICIENT_REAL_EXIT_RESERVE", "SELL_QUOTE_UNAVAILABLE", "SELL_QUOTE_STALE", "ADAPTIVE_PROFIT_EXIT", "MULTIPLE_TRIGGERS"] as const;
export type ExitReason = typeof EXIT_REASONS[number];
export interface ExitDecision { reason: ExitReason; reasoning: string[]; triggeredAt: string }
export interface Management {
  adaptive?: { netLiquidationUsd: number; peakNetLiquidationUsd: number; armed: boolean; strongMomentum: boolean; trailingPercent: number; profitFloorPercent: number };
  liquidity?: LiquiditySafety; exitExecutionStatus?: "EXECUTABLE" | "EXIT_TRIGGERED_BUT_UNEXECUTABLE";
  excursionTrackingSince?: string; entryLiquidationValueUsd?: number; mfePercent?: number; maePercent?: number; state?: "RISK" | "RUNNER" | "PROFIT_PROTECTION";
  peakLiquidationValueUsd: number | null; peakReturnPercent: number | null; peakTimestamp: string | null;
  lastSuccessfulQuote: PaperQuote | null; lastSuccessfulQuoteTimestamp: string | null;
  quoteFailureCount: number; consecutiveQuoteFailures: number; holdReason: string;
  pendingExit: ExitDecision | null;
}
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const cents = (n: number): number => Math.floor(Math.max(0, n) * 100) / 100;
export function accountCapacity(state: PaperState, now = Date.now()) {
  const c = state.config;
  const values = state.positions.map(p => {
    const fresh = p.markStatus === "FRESH" && p.current.side === "SELL" &&
      !quoteProblem(p.current,now,c.QUOTE_MAX_AGE_MS,c.ETH_USD_MAX_AGE_MS);
    return { position: p, fresh, value: fresh ? Math.max(0,p.current.notionalUsd-(p.current.costs.gasUsd??0)) : 0 };
  });
  // Zero is a conservative sizing assumption, never a new position mark or fabricated sell.
  const equityUsd = state.cash + values.reduce((sum,p)=>sum+p.value,0);
  const exposureUsd = values.reduce((sum,p)=>sum+Math.max(p.position.costBasisUsd,p.value),0);
  const unavailablePositions = values.filter(p=>!p.fresh).length;
  const unavailableCostBasisUsd = values.filter(p=>!p.fresh).reduce((sum,p)=>sum+p.position.costBasisUsd,0);
  const allocationPercent = getPaperStrategy(c, equityUsd).maxTokenExposurePercent;
  const maxPositionPercent = c.PAPER_STRATEGY_VERSION === 4 ? Math.max(c.MAX_POSITION_EQUITY_PERCENT, allocationPercent) : c.MAX_POSITION_EQUITY_PERCENT;
  const availableCapacityUsd = cents(Math.min(equityUsd * maxPositionPercent / 100,
    equityUsd * c.MAX_PORTFOLIO_EXPOSURE_PERCENT / 100 - exposureUsd,
    state.cash - equityUsd * c.MIN_CASH_RESERVE_PERCENT / 100));
  return { equityUsd, maxPositionPercent, allocationPercent, cashUsd: state.cash, exposureUsd, availableCapacityUsd, unavailablePositions, unavailableCostBasisUsd };
}

/** Experimental deterministic policy weights, not forecasts or claimed market signals. */
export function proposeTradePlan(state: PaperState, candidate: Candidate, quote: PaperQuote, now: number): PaperTradePlan {
  const account = accountCapacity(state, now), e = quote.evidence;
  const policy = getPaperStrategy(state.config, account.equityUsd), scalp = policy.version === PAPER_SCALP_STRATEGY.version;
  const palermoScore = candidate.launch?.assessment.score ?? null;
  const progress = e?.progressBps ?? null;
  const feePct = e ? (e.feeBps + e.creatorTaxBps + e.snipeTaxBps) / 100 : null;
  const impact = quote.costs.priceImpactPercent;
  const qualityPenalty = palermoScore === null ? 1 : clamp((100 - palermoScore) / 30, 0, 1);
  const stagePenalty = progress === null ? 1 : progress < 2500 ? 1 - progress / 2500 : progress > 8000 ? (progress - 8000) / 2000 : 0;
  const taxPenalty = feePct === null ? 1 : clamp(feePct / 10, 0, 1);
  const impactPenalty = impact === null ? 1 : clamp(impact / state.config.MAX_ENTRY_IMPACT_PERCENT, 0, 1);
  const depthPenalty = clamp(account.equityUsd / Math.max(quote.liquidityUsd, 1), 0, 1);
  const riskScore = clamp(.3 * qualityPenalty + .2 * stagePenalty + .2 * taxPenalty + .2 * impactPenalty + .1 * depthPenalty, 0, 1);
  const riskClass = riskScore >= .6 ? "VERY_HIGH" : riskScore >= .3 ? "HIGH" : "ELEVATED";
  const riskReasons = [
    `GPTHEIST/Palermo score: ${palermoScore ?? "unknown"}; lower scores reduce budget`,
    `Curve progress: ${progress === null ? "unknown" : `${progress / 100}%`}; early and near-graduation curves reduce budget`,
    `Known buy fees/taxes: ${feePct ?? "unknown"}%; quote impact: ${impact ?? "unknown"}%`,
    `Verified real quote liquidity: $${quote.liquidityUsd.toFixed(2)}; no volume, volatility or social inputs`
  ];
  const roundTripLoss = Math.max(0, roundTripLossPercent(quote) ?? 0);
  const downsidePercent = Math.min(state.config.MAX_DOWNSIDE_PERCENT, scalp ? PAPER_SCALP_STRATEGY.maxDownsidePercent : state.config.MAX_DOWNSIDE_PERCENT,
    Math.max(scalp ? 4 : 6 + 10 * (1 - riskScore), roundTripLoss + 2));
  // Returns already include buy/sell friction. Protect NET profits rather than charging fees twice.
  const profitArmPercent = scalp ? PAPER_SCALP_STRATEGY.profitArmPercent : 3 + 3 * (1 - riskScore);
  const exitPolicy: ExitPolicy = {
    downsidePercent, profitArmPercent,
    trailingDrawdownPercent: scalp ? PAPER_SCALP_STRATEGY.trailingDrawdownPercent : 2 + 2 * (1 - riskScore),
    profitFloorPercent: policy.profitFloorPercent, stagnationMs: policy.stagnationMs,
    maxHoldMs: Math.floor(Math.min(state.config.MAX_HOLD_MS, policy.maxHoldMs) * (scalp ? 1 : .5 + .5 * (1 - riskScore))),
    ...(scalp ? { takeProfitPercent: PAPER_SCALP_STRATEGY.takeProfitPercent } : {}),
    reserveDropPercent: scalp ? 6 : 10 + 25 * (1 - riskScore), taxIncreaseBps: Math.round(50 + 150 * (1 - riskScore)),
    maxExitImpactPercent: state.config.MAX_ENTRY_IMPACT_PERCENT * (1.5 + (1 - riskScore)),
    graduationProgressBps: Math.round(9000 + 800 * (1 - riskScore)),
    reasons: [scalp ? "SCALP v4 uses a short fixed holding limit, net profit protection and fee-aware downside" : "Higher assessed risk receives tighter downside, shorter holding time and earlier profit protection",
      "Thresholds are experimental policy choices derived from verified inputs, not estimated volatility",
      "Any exit requires a fresh final full-size sell quote; unavailable liquidity can delay a loss exit"]
  };
  const riskPercent = scalp ? Math.max(state.config.MAX_RISK_EQUITY_PERCENT, Math.min(.5, policy.maxTokenExposurePercent * .1)) : state.config.MAX_RISK_EQUITY_PERCENT;
  const riskBudgetUsd = account.equityUsd * riskPercent / 100 * (1 - .75 * riskScore);
  if(policy.version===5) {
    exitPolicy.downsidePercent=5; exitPolicy.profitArmPercent=2; exitPolicy.trailingDrawdownPercent=3;
    exitPolicy.reserveDropPercent=8; exitPolicy.maxHoldMs=Math.min(state.config.MAX_HOLD_MS,policy.maxHoldMs);
    exitPolicy.reasons.push("V5 adaptive executable-profit trail; 2% equity gap exposure cap; reserve emergencies remain immediate");
  }
  const entryGasUsd = quote.costs.gasUsd ?? 0;
  const proposedSizeUsd = cents(Math.min(account.availableCapacityUsd - entryGasUsd, riskBudgetUsd / (downsidePercent / 100) - entryGasUsd,
    account.equityUsd * policy.maxTokenExposurePercent / 100 - entryGasUsd,
    quote.liquidityUsd * state.config.MAX_REAL_LIQUIDITY_PERCENT / 100,
    quote.liquidityUsd / state.config.MIN_EXIT_COVERAGE_RATIO,
    quote.liquidityUsd * state.config.MAX_EXIT_PARTICIPATION_BPS / 10_000));
  const exitObservation = quote.roundTrip ? sellObservation(quote.roundTrip.sell, quote.notionalUsd) : null;
  return { ...(policy.version===5 ? {survival:LiquiditySurvivalGate(candidate,quote,state,now)} : {}), strategyVersion: policy.version, entryExecutionQuality: entryExecutionQuality(quote, state.liquidityHistory?.[candidate.launchId] ?? [], now, policy), entryQuality: entryQuality(candidate, quote, now, policy), ...(exitObservation ? { exitLiquiditySafety: ExitLiquiditySafetyGate(exitObservation, state.liquidityHistory?.[candidate.launchId] ?? [], entryPolicyConfig(state.config)) } : {}), version: 1, createdAt: new Date(now).toISOString(), experimental: true, gptheistVerdict: "WATCH", paperVerdict: "PAPER_ELIGIBLE",
    riskClass, riskScore, riskReasons, riskBudgetUsd, proposedSizeUsd, approvedSizeUsd: 0, account,
    inputs: { palermoScore, curveProgressBps: progress, creatorTaxBps: e?.creatorTaxBps ?? null,
      snipeTaxBps: e?.snipeTaxBps ?? null, protocolFeeBps: e?.feeBps ?? null, impactPercent: impact,
      realLiquidityUsd: quote.liquidityUsd, quoteReserve: e?.quoteReserve ?? null, realQuoteReserve: e?.realQuoteReserve ?? null },
    exitPolicy, sizingAttempts: [], entryQuote: structuredClone(quote), sources: [...new Set([quote.source, ...(e ? [e.usdSource] : [])])],
    reasoning: [`Size = minimum of account capacity, stop-distance risk budget, ${policy.maxTokenExposurePercent}% equity token gap-risk cap, real-liquidity participation and full-exit coverage caps`,
      ...(scalp ? [`SCALP v4 dynamic sizing: allocation cap ${policy.maxTokenExposurePercent.toFixed(3)}% ($${(account.equityUsd * policy.maxTokenExposurePercent / 100).toFixed(2)}); risk budget cap ${riskPercent.toFixed(3)}% before quality adjustment. Small accounts can allocate up to 5% equity; target ticket $2.50, gas deducted. Experimental.`] : []),
      "Each proposed size must pass a sized quote; excess impact reduces size and triggers another quote",
      "Final entry is separately re-quoted and all account limits are checked again"] };
}

export function initialManagement(): Management {
  return { peakLiquidationValueUsd: null, peakReturnPercent: null, peakTimestamp: null,
    lastSuccessfulQuote: null, lastSuccessfulQuoteTimestamp: null, quoteFailureCount: 0, consecutiveQuoteFailures: 0,
    holdReason: "Awaiting first full-size sell quote", pendingExit: null };
}
export function evaluateExit(position: Position, now: number): ExitDecision | null {
  if(position.plan.strategyVersion===5) return AdaptiveProfitExit(position,now);
  const p = position, policy = p.plan.exitPolicy, q = p.current;
  const value = q.notionalUsd - (q.costs.gasUsd ?? 0);
  const ret = (value / p.costBasisUsd - 1) * 100;
  const peak = p.management.peakLiquidationValueUsd ?? value;
  const peakReturn = p.management.peakReturnPercent ?? ret;
  const dd = peak > 0 ? (peak - value) / peak * 100 : 0;
  const exit = (reason: ExitReason, message: string): ExitDecision => ({ reason, reasoning: [message], triggeredAt: new Date(now).toISOString() });
  if (ret <= -policy.downsidePercent) return exit("DYNAMIC_RISK_EXIT", `Return ${ret.toFixed(3)}% crossed plan downside -${policy.downsidePercent.toFixed(3)}%`);
  if (policy.takeProfitPercent !== undefined && ret >= policy.takeProfitPercent)
    return exit("SCALP_TAKE_PROFIT", `Net executable return ${ret.toFixed(3)}% reached the saved ${policy.takeProfitPercent}% scalp target`);
  if (now - Date.parse(p.enteredAt) >= policy.maxHoldMs) return exit("MAX_HOLD_EXIT", `Position age reached plan limit ${policy.maxHoldMs} ms`);
  if (peakReturn >= policy.profitArmPercent) {
    if (ret <= Math.max(policy.profitFloorPercent ?? 0, peakReturn * (policy.profitFloorPercent === undefined ? .25 : .5))) return exit("PROFIT_PROTECTION", "Armed profit protection: executable return crossed the plan profit floor");
    if (dd >= policy.trailingDrawdownPercent) return exit("TRAILING_EXIT", `Liquidation drawdown ${dd.toFixed(3)}% crossed plan trail ${policy.trailingDrawdownPercent.toFixed(3)}%`);
  }
  if (policy.stagnationMs !== undefined && now - Date.parse(p.enteredAt) >= policy.stagnationMs && peakReturn <= 0 && ret <= 0)
    return exit("STAGNATION_EXIT", "No positive executable return within the plan confirmation period");
  const entry = p.entry.evidence, current = q.evidence;
  if (entry && current) {
    if (current.progressBps >= policy.graduationProgressBps) return exit("GRADUATION_TRANSITION", "Curve is approaching graduation; pool quoting is unavailable");
    const before = Number(entry.realQuoteReserve), after = Number(current.realQuoteReserve);
    if (before > 0 && (before - after) / before * 100 >= policy.reserveDropPercent) return exit("SIGNAL_DETERIORATION", "Verified real quote reserve declined beyond plan threshold");
    if (current.creatorTaxBps + current.feeBps - entry.creatorTaxBps - entry.feeBps >= policy.taxIncreaseBps) return exit("TAX_CHANGE", "Known recurring sell fees increased beyond plan threshold");
  }
  if (q.costs.priceImpactPercent !== null && q.costs.priceImpactPercent >= policy.maxExitImpactPercent) return exit("LIQUIDITY_OR_QUOTE_DETERIORATION", "Full-size sell impact crossed plan threshold");
  p.management.holdReason = `HOLD: return ${ret.toFixed(2)}%; downside -${policy.downsidePercent.toFixed(2)}%; profit arm ${policy.profitArmPercent.toFixed(2)}%; peak drawdown ${dd.toFixed(2)}%`;
  return null;
}

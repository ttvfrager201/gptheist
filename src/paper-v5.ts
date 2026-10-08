import { entryQuality, entryExecutionQuality, getPaperStrategy } from './paper-strategy.js';
import { sellObservation, ExitLiquiditySafetyGate, type LiquidityObservation } from './paper-liquidity.js';
import { quoteProblem, type Candidate, type PaperQuote, type PaperState, type Position } from './paper.js';
import type { ExitDecision, ExitReason } from './paper-policy.js';
export interface SurvivalResult {
  result: 'V5_ENTRY_APPROVED' | 'V5_ENTRY_REJECTED' | 'V5_MORE_EVIDENCE_REQUIRED';
  reasons: string[]; reserveVelocityPercentPerSecond: number | null; reserveAcceleration: number | null;
  peakDrawdownPercent: number | null; observationSpanMs: number; observations: number;
}
export function LiquiditySurvivalGate(candidate: Candidate, q: PaperQuote, state: PaperState, now: number): SurvivalResult {
  const rows = (state.liquidityHistory?.[candidate.launchId] ?? []).slice(-100);
  const result: SurvivalResult = { result: 'V5_ENTRY_REJECTED', reasons: [], reserveVelocityPercentPerSecond: null,
    reserveAcceleration: null, peakDrawdownPercent: null, observationSpanMs: 0, observations: rows.length };
  const policy = getPaperStrategy({ PAPER_STRATEGY_VERSION: 5 });
  const problem = quoteProblem(q,now,state.config.QUOTE_MAX_AGE_MS,state.config.ETH_USD_MAX_AGE_MS);
  if (problem) result.reasons.push(problem);
  const sell = q.roundTrip?.sell;
  if (!sell) result.reasons.push('SELL_QUOTE_UNAVAILABLE');
  else {
    const stale=quoteProblem(sell,now,state.config.QUOTE_MAX_AGE_MS,state.config.ETH_USD_MAX_AGE_MS);
    if(stale) result.reasons.push(stale);
    const observation=sellObservation(sell,q.notionalUsd);
    if (!observation) result.reasons.push('EXIT_EVIDENCE_MISSING');
    else {
      const safety=ExitLiquiditySafetyGate(observation,rows,state.config);
      if(safety.reason) result.reasons.push(safety.reason);
    }
  }
  const quality=entryQuality(candidate,q,now,policy), execution=entryExecutionQuality(q,rows,now,policy);
  if(!quality.passed) result.reasons.push(quality.reason!);
  if(!execution.passed) result.reasons.push(execution.reason!);
  const observed=candidate.tractionDiagnostics?.observations.filter(r=>r.verificationStatus==='VERIFIED') ?? [];
  if(observed.length>=3) {
    const values=observed.map(r=>Number(r.reserve)), last=values.at(-1)!, peak=Math.max(...values);
    result.observationSpanMs=Date.parse(observed.at(-1)!.timestamp)-Date.parse(observed[0]!.timestamp);
    result.peakDrawdownPercent=(peak-last)/peak*100;
    const velocity=(i:number)=> (values[i]!/values[i-1]!-1)*100/((Date.parse(observed[i]!.timestamp)-Date.parse(observed[i-1]!.timestamp))/1000);
    const v=velocity(values.length-1), prior=velocity(values.length-2);
    result.reserveVelocityPercentPerSecond=Number.isFinite(v)?v:null;
    result.reserveAcceleration=Number.isFinite(v-prior)?v-prior:null;
    if(!Number.isFinite(v) || v<0 || last<values.at(-2)!) result.reasons.push('RESERVE_REVERSAL');
  } else result.reasons.push('RESERVE_EVIDENCE_INSUFFICIENT');
  if(q.costs.gasUsd===null || sell?.costs.gasUsd===null) result.reasons.push('GAS_ESTIMATE_UNAVAILABLE');
  if(q.costs.priceImpactPercent===null) result.reasons.push('PRICE_IMPACT_UNAVAILABLE');
  if(candidate.launchTimestamp===null || now/1000-candidate.launchTimestamp>state.config.PAPER_MAX_LAUNCH_AGE_SECONDS) result.reasons.push('LAUNCH_AGE_UNVERIFIED_OR_STALE');
  if(candidate.launch?.assessment.score==null) result.reasons.push('PALERMO_SCORE_UNAVAILABLE');
  result.reasons=[...new Set(result.reasons)];
  result.result=!result.reasons.length?'V5_ENTRY_APPROVED':result.reasons.every(r=>/INSUFFICIENT|UNCONFIRMED|MISSING|UNAVAILABLE/.test(r))?'V5_MORE_EVIDENCE_REQUIRED':'V5_ENTRY_REJECTED';
  return result;
}
export function v5RiskTriggers(p: Position, current: LiquidityObservation, previous?: LiquidityObservation): { reason: ExitReason; predicate: string }[] {
  const safety=p.management.liquidity!, triggers: {reason: ExitReason; predicate:string}[]=[];
  const add=(reason:ExitReason,predicate:string)=>triggers.push({reason,predicate});
  const real=Number(current.realQuoteReserveWei), entry=Number(p.entry.evidence?.realQuoteReserve), rows=safety.observations;
  const peak=Math.max(real,entry,...rows.map(r=>Number(r.realQuoteReserveWei)));
  const dd=peak>0?(peak-real)/peak*100:0;
  if(dd>=p.plan.exitPolicy.reserveDropPercent) add('RESERVE_DRAWDOWN',`peakReserveDrawdownPercent=${dd} >= ${p.plan.exitPolicy.reserveDropPercent}`);
  if(previous) {
    const drop=(1-real/Number(previous.realQuoteReserveWei))*100;
    const span=Date.parse(current.timestamp)-Date.parse(previous.timestamp);
    if(span>0 && span<=10_000 && drop>=5) add('RAPID_RESERVE_OUTFLOW',`reserveDropPercent=${drop}; spanMs=${span}`);
    if(current.executableUsd!==null && previous.executableUsd!==null && previous.executableUsd>0 && current.executableUsd<=previous.executableUsd*.9)
      add('EXECUTABLE_PRICE_COLLAPSE',`executableUsd=${current.executableUsd} <= priorUsd=${previous.executableUsd} * 0.9`);
  }
  if(real<Number(safety.limits.minRealReserveWei) || current.sellResult!=='AVAILABLE') add('INSUFFICIENT_REAL_EXIT_RESERVE',`real=${real}; gross=${current.positionExitWei}; min=${safety.limits.minRealReserveWei}`);
  if(current.exitCoverageRatio<safety.limits.minCoverageRatio) add('EXIT_COVERAGE_FAILURE',`coverage=${current.exitCoverageRatio} < ${safety.limits.minCoverageRatio}`);
  if(current.positionParticipation===null || current.positionParticipation*10000>safety.limits.maxParticipationBps) add('EXIT_PARTICIPATION_BREACH',`participation=${current.positionParticipation}; limitBps=${safety.limits.maxParticipationBps}`);
  return triggers;
}
export function AdaptiveProfitExit(p: Position, now: number): ExitDecision | null {
  const policy=p.plan.exitPolicy, value=p.current.notionalUsd-(p.current.costs.gasUsd??0), ret=(value/p.costBasisUsd-1)*100;
  const peak=p.management.peakLiquidationValueUsd??value, peakReturn=p.management.peakReturnPercent??ret;
  const rows=p.management.liquidity?.observations??[], last=rows.at(-1), prior=rows.at(-2);
  const strong=!!last && !!prior && last.block>prior.block && last.executableUsd!==null && prior.executableUsd!==null && last.executableUsd>prior.executableUsd && BigInt(last.realQuoteReserveWei)>=BigInt(prior.realQuoteReserveWei);
  const trail=strong?Math.max(policy.trailingDrawdownPercent,Math.min(5,peakReturn*.25)):Math.min(1.5,policy.trailingDrawdownPercent);
  const floor=Math.max(policy.profitFloorPercent??.5,peakReturn*(strong?.25:.5));
  p.management.adaptive={ netLiquidationUsd:value, peakNetLiquidationUsd:peak, armed:peakReturn>=policy.profitArmPercent, strongMomentum:strong, trailingPercent:trail, profitFloorPercent:floor };
  const exit=(reason:ExitReason,predicate:string):ExitDecision=>({reason,reasoning:[predicate],triggeredAt:new Date(now).toISOString()});
  const e=p.entry.evidence,c=p.current.evidence;
  if(c && c.progressBps>=policy.graduationProgressBps) return exit('GRADUATION_TRANSITION',`progressBps=${c.progressBps} >= ${policy.graduationProgressBps}`);
  if(e && c && c.creatorTaxBps+c.feeBps-e.creatorTaxBps-e.feeBps>=policy.taxIncreaseBps) return exit('TAX_CHANGE',`recurring sell tax increase >= ${policy.taxIncreaseBps} bps`);
  if(p.current.costs.priceImpactPercent!==null && p.current.costs.priceImpactPercent>=policy.maxExitImpactPercent) return exit('EXIT_PARTICIPATION_BREACH',`sell impact=${p.current.costs.priceImpactPercent} >= ${policy.maxExitImpactPercent}`);
  if(ret<=-policy.downsidePercent) return exit('DYNAMIC_RISK_EXIT',`netReturnPercent=${ret} <= -${policy.downsidePercent}; quoted gap loss may exceed threshold`);
  if(now-Date.parse(p.enteredAt)>=policy.maxHoldMs) return exit('MAX_HOLD_EXIT',`holdMs=${now-Date.parse(p.enteredAt)} >= ${policy.maxHoldMs}`);
  if(peakReturn>=policy.profitArmPercent && (ret<=floor || (peak-value)/peak*100>=trail)) return exit('ADAPTIVE_PROFIT_EXIT',`return=${ret}; floor=${floor}; liquidationDrawdown=${(peak-value)/peak*100}; trail=${trail}; strongMomentum=${strong}`);
  if(now-Date.parse(p.enteredAt)>=(policy.stagnationMs??60_000) && peakReturn<=0 && ret<=0) return exit('STAGNATION_EXIT',`no positive executable return; holdMs=${now-Date.parse(p.enteredAt)}`);
  p.management.holdReason=`V5 HOLD: net=${ret.toFixed(2)}%; momentum=${strong}; trail=${trail.toFixed(2)}%`; return null;
}

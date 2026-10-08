import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./paper-fixtures.js";
import { PAPER_CONFIG, initialPaperState, observeSnapshot, monitorPaper, enterPaper, type PaperState, type QuoteResult } from "../src/paper.js";
import { readPaperQuote } from "../src/paper-quotes.js";
import { getPaperStrategy, PAPER_SCALP_STRATEGY, entryRegimeRejection } from "../src/paper-strategy.js";
import { proposeTradePlan } from "../src/paper-policy.js";
import { researchMetrics } from "../src/paper-research.js";
import { PaperStore } from "../src/paper-store.js";

async function earlyFlow(version: 3 | 4, startingBalance = 1000, gasUsd = 0, liquidityScale = 1) {
  const f = fixture(), state = initialPaperState(f.time, { ...PAPER_CONFIG, STARTING_BALANCE_USD: startingBalance, PAPER_STRATEGY_VERSION: version });
  f.state.fee = 0n;
  const offsets = [0, 5000, 15000], sizes: number[] = [];
  let now = f.time;
  for (let i = 0; i < offsets.length; i++) {
    now = f.time + offsets[i]!;
    const launch = structuredClone(f.launch), block = 100 + i;
    f.state.real = BigInt((20 + i * 5) * liquidityScale) * 10n ** 16n;
    f.state.reserve = 10n ** 18n + f.state.real;
    f.state.headBlock = block; f.state.blockTime = Math.floor(now / 1000);
    f.state.usd.timestamp = new Date(now).toISOString();
    if (launch.market.status !== "VERIFIED") throw new Error("fixture");
    launch.market.realQuoteReserve = f.state.real.toString(); launch.market.quoteReserve = f.state.reserve.toString();
    launch.market.progressBps = 1000 + i * 250;
    launch.chronology = { ...launch.chronology!, currentBlock: block, currentTimestamp: Math.floor(now / 1000),
      tokenAgeSeconds: Math.floor(now / 1000) - launch.chronology!.launchTimestamp!, currentBlockHash: `0x${"b".repeat(64)}` };
    await observeSnapshot(state, { ...f.snapshot, headBlock: block, fetchedAt: new Date(now).toISOString(), launches: [launch] }, now,
      async (l, size) => { sizes.push(size); const result = await readPaperQuote(f.rpc, async () => f.state.usd, l, { side: "BUY", sizeUsd: size }, () => now); if (result.status === "AVAILABLE" && gasUsd > 0) { result.quote.costs.gasUsd = gasUsd; if (result.quote.roundTrip) result.quote.roundTrip.sell.costs.gasUsd = gasUsd; } return result; }, () => now);
    if (i < 2) assert.equal(state.positions.length, 0, "A scalp still needs independently confirmed full SELL liquidity");
  }
  return { f, state, sizes, now };
}

test("scalp opens an early verified opportunity that strict selection cannot enter", async () => {
  const scalp = await earlyFlow(4), strict = await earlyFlow(3);
  assert.equal(strict.state.positions.length, 0);
  assert.equal(scalp.state.positions.length, 1, JSON.stringify(scalp.state.decisions.at(-1)));
  const p = scalp.state.positions[0]!;
  assert.equal(p.plan.strategyVersion, 4); assert.ok(p.sizeUsd <= 2.5);
  assert.ok(p.plan.entryExecutionQuality!.realReserveSharePercent! < 50);
  assert.ok(p.plan.entryExecutionQuality!.realReserveSharePercent! >= 20);
  assert.equal(p.plan.exitLiquiditySafety!.observations.length, 2);
  assert.ok(p.plan.exitLiquiditySafety!.current.exitCoverageRatio >= 100);
  assert.equal(p.plan.exitLiquiditySafety!.limits.minSpanMs, 10000);
  assert.ok(p.plan.entryQuality!.passed && p.plan.entryExecutionQuality!.passed);
  assert.ok(scalp.sizes.filter(size => size === p.sizeUsd).length >= 3);
});

test("scalp rejects costly, mismatched and insufficiently confirmed evidence without changing cash", async () => {
  const s = await earlyFlow(4), p = s.state.positions[0]!;
  for (const mode of ["VETO", "GAS", "UNITS", "HISTORY"] as const) {
    const state = initialPaperState(s.now, { ...PAPER_CONFIG, PAPER_STRATEGY_VERSION: 4 });
    state.liquidityHistory = structuredClone(s.state.liquidityHistory!);
    const candidate = structuredClone(p.candidate);
    if (candidate.quote.status !== "AVAILABLE") throw new Error("fixture");
    if (mode === "VETO") candidate.decision = "VETO";
    if (mode === "GAS") { candidate.quote.quote.costs.gasUsd = .05; candidate.quote.quote.roundTrip!.sell.costs.gasUsd = .05; }
    if (mode === "UNITS") candidate.quote.quote.tokenUnits = "1";
    if (mode === "HISTORY") state.liquidityHistory[p.launchId] = state.liquidityHistory[p.launchId]!.slice(-1);
    const result = enterPaper(state, candidate, p.sizeUsd, s.now, p.plan);
    assert.notEqual(result.outcome, "PAPER_BUY", mode);
    assert.equal(state.cash, 1000, mode); assert.equal(state.positions.length, 0, mode);
    if (mode === "GAS") assert.equal(result.reason, "ENTRY_FRICTION_TOO_HIGH");
    if (mode === "HISTORY") assert.equal(result.reason, "LIQUIDITY_HISTORY_INSUFFICIENT");
  }
});

async function exitQuote(s: Awaited<ReturnType<typeof earlyFlow>>, reserve: bigint): Promise<QuoteResult> {
  const p = s.state.positions[0]!;
  s.f.state.reserve = reserve; s.f.state.real = reserve - 10n ** 18n;
  s.f.state.headBlock++; s.f.state.blockTime = Math.floor(s.now / 1000);
  s.f.state.usd.timestamp = new Date(s.now).toISOString();
  return readPaperQuote(s.f.rpc, async () => s.f.state.usd, p.candidate.launch!,
    { side: "SELL", tokenUnits: p.entry.tokenUnits!, quantity: p.quantity }, () => s.now);
}

test("scalp takes net profit using a distinct full-size final quote and actual cash accounting", async () => {
  const s = await earlyFlow(4), p = structuredClone(s.state.positions[0]!), cash = s.state.cash;
  s.now += 1000; let calls = 0;
  await monitorPaper(s.state, async () => exitQuote(s, ++calls === 1 ? 14n * 10n ** 17n : 138n * 10n ** 16n), () => s.now);
  assert.equal(calls, 2); assert.equal(s.state.positions.length, 0);
  const t = s.state.trades[0]!;
  assert.equal(t.exitReason, "SCALP_TAKE_PROFIT"); assert.ok(t.pnlUsd > 0);
  assert.equal(t.entry.tokenUnits, t.exit.tokenUnits);
  assert.equal(t.pnlUsd, t.exit.notionalUsd - (t.exit.costs.gasUsd ?? 0) - p.costBasisUsd);
  assert.equal(s.state.cash, cash + t.exit.notionalUsd - (t.exit.costs.gasUsd ?? 0));
  assert.notEqual(t.exit.blockNumber, p.entry.blockNumber);
});

test("unavailable final scalp quote cannot book a profit or release the position", async () => {
  const s = await earlyFlow(4), cash = s.state.cash;
  s.now += 1000; let calls = 0;
  await monitorPaper(s.state, async () => ++calls === 1 ? exitQuote(s, 14n * 10n ** 17n) :
    { status: "NOT_PAPER_TRADABLE", reason: "QUOTE_TIMEOUT", details: [] }, () => s.now);
  assert.equal(calls, 2); assert.equal(s.state.trades.length, 0); assert.equal(s.state.cash, cash);
  assert.equal(s.state.positions[0]!.management.pendingExit?.reason, "SCALP_TAKE_PROFIT");
});

test("scalp cuts downside and expires stagnant positions instead of holding for minutes", async () => {
  const loss = await earlyFlow(4); loss.now += 1000;
  assert.ok(loss.state.positions[0]!.plan.exitPolicy.downsidePercent <= 6);
  await monitorPaper(loss.state, () => exitQuote(loss, 122n * 10n ** 16n), () => loss.now);
  assert.equal(loss.state.trades[0]!.exitReason, "LIQUIDITY_OR_QUOTE_DETERIORATION");
  assert.ok(loss.state.trades[0]!.pnlUsd < 0);
  const stagnant = await earlyFlow(4); stagnant.now += 30000;
  await monitorPaper(stagnant.state, () => exitQuote(stagnant, 13n * 10n ** 17n), () => stagnant.now);
  assert.equal(stagnant.state.trades[0]!.exitReason, "STAGNATION_EXIT");
});

test("scalp cooldown and validation use its own cohort while lifetime losses remain visible", async () => {
  const s = await earlyFlow(4), p = s.state.positions[0]!;
  s.state.trades = [1,2,3].map(i => ({ ...structuredClone(p), id: `scalp-loss-${i}`, exit: p.current,
    exitedAt: new Date(s.now - i * 1000).toISOString(), pnlUsd: -1, returnPercent: -40,
    exitReason: "DYNAMIC_RISK_EXIT" as const, exitReasoning: [] }));
  const legacy = { ...structuredClone(s.state.trades[0]!), id: "legacy-loss" };
  legacy.plan.strategyVersion = 3; legacy.pnlUsd = -2;
  s.state.trades.push(legacy);
  assert.equal(entryRegimeRejection(s.state, s.now), "STRATEGY_LOSS_STREAK_PAUSE");
  assert.equal(entryRegimeRejection(s.state, s.now + PAPER_SCALP_STRATEGY.lossStreakPauseMs), null);
  const m = researchMetrics(s.state, s.now);
  assert.equal(m.strategyValidation.version, 4); assert.equal(m.strategyValidation.closedTrades, 3);
  assert.equal(m.strategyValidation.netPnlUsd, -3); assert.equal(m.strategyValidation.targetWinRatePercent, 60);
  assert.equal(m.groups.risk[p.plan.riskClass]!.realizedPnlUsd, -5);
});

test("changing entry mode preserves saved position exits and the account", async () => {
  const s = await earlyFlow(4), p = s.state.positions[0]!;
  const strictState: PaperState = { ...s.state, config: { ...s.state.config, PAPER_STRATEGY_VERSION: 3 } };
  const saved = proposeTradePlan(strictState, p.candidate, p.entry, s.now);
  saved.approvedSizeUsd = p.sizeUsd;
  p.plan = saved;
  const directory = await mkdtemp(join(tmpdir(), "paper-scalp-mode-"));
  const previous = process.env.PAPER_STRATEGY_MODE;
  let store: PaperStore | undefined;
  try {
    delete process.env.PAPER_STRATEGY_MODE;
    store = await PaperStore.open(directory);
    await store.update(state => { Object.assign(state, { ...s.state, config: strictState.config }); });
    await store.close(); store = undefined;
    process.env.PAPER_STRATEGY_MODE = "SCALP";
    store = await PaperStore.open(directory);
    const restored = store.read();
    assert.equal(getPaperStrategy(restored.config).version, 4);
    assert.equal(restored.cash, s.state.cash); assert.equal(restored.positions.length, 1);
    assert.deepEqual(restored.positions[0]!.plan, saved);
    assert.equal(restored.positions[0]!.plan.exitPolicy.takeProfitPercent, undefined);
  } finally {
    await store?.close();
    if (previous === undefined) delete process.env.PAPER_STRATEGY_MODE; else process.env.PAPER_STRATEGY_MODE = previous;
  }
  assert.throws(() => initialPaperState(s.now, { ...PAPER_CONFIG, PAPER_STRATEGY_VERSION: 6 }), /configuration/);
});

test("small scalp account rejects before any bootstrap or entry network quotes", async()=>{
 const s=await earlyFlow(4,10);assert.equal(s.sizes.length,0);assert.equal(s.state.positions.length,0);assert.equal(s.state.cash,10);assert.equal(s.state.decisions.at(-1)?.reason,"ACCOUNT_TOO_SMALL_FOR_STRATEGY");
});

test("scalp sizing adapts to a $50 balance and retains the large-account cap",async()=>{
 const s=await earlyFlow(4,50,.011,4);assert.equal(s.state.positions.length,1,JSON.stringify(s.state.decisions.at(-1)));const p=s.state.positions[0]!;assert.ok(p.sizeUsd>=1&&p.costBasisUsd<=2.5);assert.equal(getPaperStrategy(s.state.config,50).maxTokenExposurePercent,5);assert.equal(getPaperStrategy(s.state.config,1000).maxTokenExposurePercent,.25);assert.equal(getPaperStrategy(s.state.config,2000).maxTokenExposurePercent,.25);assert.equal(getPaperStrategy({...s.state.config,PAPER_STRATEGY_VERSION:3},50).maxTokenExposurePercent,.5);
});

test("gas-heavy scalp rejection does not repeatedly halve the position",async()=>{const s=await earlyFlow(4,50,.05,4);assert.equal(s.state.positions.length,0);assert.equal(s.state.decisions.at(-1)?.reason,"ENTRY_FRICTION_TOO_HIGH");assert.ok(s.sizes.every(size=>size===1||size>=2));assert.equal(s.state.cash,50);});

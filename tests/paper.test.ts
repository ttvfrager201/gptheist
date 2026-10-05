import { enterPaper } from "./liquidity-history-fixture.js";
import { chronology } from "./paper-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AGENTS } from "../src/simulation.js";
import {  PAPER_CONFIG, accountSummary, initialPaperState, isPaperTradeEligible, markPaperPosition, monitorPaper, performance, quoteProblem, type Candidate, type PaperQuote, type QuoteResult  } from "../src/paper.js";
import { PaperStore, validatePaperState } from "../src/paper-store.js";
import { createDeskServer } from "../src/server.js";
import { startPaperEngine } from "../src/paper-runtime.js";

const now = Date.parse("2026-09-25T12:00:00Z");
const token = "0x1111111111111111111111111111111111111111";
// Explicit test fixtures only. Production never imports these approvals or prices.
function quote(price = 1, side: "BUY" | "SELL" = "BUY", quantity = 10): PaperQuote {
  return { tokenAddress: token, side, timestamp: new Date(now).toISOString(), blockTimestamp: new Date(now).toISOString(), source: "TEST FIXTURE ONLY",
    tokenUnits: String(BigInt(quantity) * 10n ** 18n),
    evidence: { model: "PONS_V2_CURVE", chainId: 4663, curve: `0x${"2".repeat(40)}`, blockHash: `0x${"b".repeat(64)}`,
      ethUsd: 2000, usdTimestamp: new Date(now).toISOString(), usdSource: "TEST", tokenDecimals: 18,
      quoteReserve: "1000000000000000000", tokenReserve: "1000000000000000000000", realQuoteReserve: "1000000000000000000",
      feeBps: 0, creatorTaxBps: 0, snipeTaxBps: 0, progressBps: 1000,
      amountIn: side === "SELL" ? String(BigInt(quantity) * 10n ** 18n) : "1",
      amountOut: side === "BUY" ? String(BigInt(quantity) * 10n ** 18n) : "1", quoteAsset: "ETH",
      feeWei: "0", creatorTaxWei: "0", snipeTaxWei: "0", modelSource: "TEST" },
    blockNumber: 1, rawPriceUsd: price, fillPriceUsd: price, quantity, notionalUsd: price * quantity, liquidityUsd: 1000,
    costs: { feesUsd: null, slippageUsd: null, gasUsd: null, priceImpactPercent: 0 } };
}
function candidate(q = quote()): Candidate {
  q.roundTrip = { sell: { ...structuredClone(q), side: "SELL", costs: { ...q.costs, gasUsd: null } }, entryUsd: q.notionalUsd, immediateExitUsd: q.notionalUsd, lossUsd: 0, lossPercent: 0, knownFeesUsd: null };
  q.roundTrip.sell.evidence!.amountOut = q.evidence!.amountIn;
  q.roundTrip.sell.evidence!.amountIn = q.tokenUnits!;
  return { ...chronology(now), tokenAddress: token, name: "TEST ONLY", symbol: "TEST", launchId: "test-launch", decision: "WATCH", evidenceComplete: true,
    handoffs: AGENTS.map((agent, i) => ({ sequence: i + 1, timestamp: new Date(now).toISOString(), agent: agent.name, role: agent.role, outcome: "PASS", message: "TEST ONLY" })),
    quote: { status: "AVAILABLE", quote: q } };
}
const available = (q: PaperQuote): QuoteResult => ({ status: "AVAILABLE", quote: q });
async function closeAt(s: ReturnType<typeof initialPaperState>, price: number, time = now) {
  // Explicit per-position test plan for accounting tests; production selects its own dynamic policy.
  if (price >= 1) s.positions[0]!.plan.exitPolicy.maxHoldMs = 1;
  const target = s.positions[0]!.id;
  await monitorPaper(s, async p => { if (p.id !== target) return missing; const q = quote(price, "SELL", p.quantity); q.tokenAddress = p.tokenAddress; return available(q); }, () => time);
}
const missing: QuoteResult = { status: "NOT_PAPER_TRADABLE", reason: "MISSING_QUOTE", details: [] };

test("paper initializes with centralized $1,000 balance and zero-trade statistics", () => {
  const s = initialPaperState(now), a = accountSummary(s), p = performance(s);
  assert.equal(a.equity, 1000); assert.equal(a.availableCash, 1000); assert.equal(a.totalPnl, 0);
  assert.equal(p.totalTrades, 0); assert.equal(p.winRate, 0); assert.equal(p.profitFactor, null); assert.equal(p.expectancy, null);
  assert.equal(p.maximumDrawdown, 0); assert.equal(s.config.MAX_POSITION_EQUITY_PERCENT, 2);
});
test("paper entry debits cash, preserves raw/effective fills, and does not change equity absent known costs", () => {
  const s = initialPaperState(now), c = candidate();
  assert.equal(enterPaper(s, c, 10, now).outcome, "PAPER_BUY");
  assert.equal(s.cash, 990); assert.equal(s.positions.length, 1); assert.equal(s.positions[0]?.execution, "SIMULATED");
  assert.equal(accountSummary(s).equity, 1000); assert.equal(s.positions[0]?.entry.rawPriceUsd, 1);
  c.name = "mutated"; assert.equal(s.positions[0]?.candidate.name, "TEST ONLY");
});
test("final eligibility checks include entry gas in exposure and both gas charges in downside", () => {
  const s = initialPaperState(now), q = quote();
  q.costs.gasUsd = 11;
  assert.equal(enterPaper(s, candidate(q), 10, now).reason, "MAX_POSITION_EXPOSURE");
  const c = candidate();
  if (c.quote.status !== "AVAILABLE") throw Error("fixture");
  c.quote.quote.roundTrip!.sell.costs.gasUsd = 5;
  assert.equal(enterPaper(s, c, 10, now).reason, "ROUND_TRIP_COST_TOO_HIGH");
  assert.equal(s.cash, 1000); assert.equal(s.positions.length, 0);
});
test("fresh price update calculates unrealized P&L and equity", () => {
  const s = initialPaperState(now); enterPaper(s, candidate(), 10, now);
  markPaperPosition(s, s.positions[0]!.id, available(quote(1.1, "SELL")), now);
  assert.equal(accountSummary(s).unrealizedPnl, 1); assert.equal(accountSummary(s).equity, 1001);
  assert.equal(accountSummary(s).realizedPnl, 0); assert.equal(s.positions.length, 1);
});
for (const [price, reason, pnl] of [[1.3, "TAKE_PROFIT", 3], [.8, "STOP_LOSS", -2]] as const) {
  test(`${reason} fixture simulates a ${pnl > 0 ? "winning" : "losing"} exit and realized accounting`, async () => {
    const s = initialPaperState(now); enterPaper(s, candidate(), 10, now);
    await closeAt(s, price, now + 1000);
    assert.equal(s.positions.length, 0); assert.equal(s.trades.length, 1); assert.equal(s.trades[0]?.exitReason, price < 1 ? "DYNAMIC_RISK_EXIT" : "MAX_HOLD_EXIT");
    assert.equal(s.trades[0]?.pnlUsd, pnl); assert.equal(accountSummary(s).realizedPnl, pnl); assert.equal(s.cash, 1000 + pnl);
    assert.equal(accountSummary(s).unrealizedPnl, 0); validatePaperState(s);
  });
}
test("costs included in fill are not double charged; known gas debits cash; unknown costs remain null", () => {
  const s = initialPaperState(now), q = quote(); q.rawPriceUsd = .98; q.costs.feesUsd = .1; q.costs.gasUsd = .01;
  enterPaper(s, candidate(q), 10, now); assert.equal(s.cash, 989.99);
  assert.equal(s.positions[0]?.costBasisUsd, 10.01); assert.equal(performance(s).estimatedFees.knownUsd, .1);
  assert.equal(performance(s).estimatedSlippage.unknownFills, 1); validatePaperState(s);
});
test("insufficient cash and maximum position size reject entry", () => {
  const s = initialPaperState(now, { ...PAPER_CONFIG, STARTING_BALANCE_USD: 5 });
  assert.equal(enterPaper(s, candidate(), 10, now).reason, "MAX_POSITION_EXPOSURE");
  assert.equal(enterPaper(initialPaperState(now), candidate(), 21, now).reason, "MAX_POSITION_EXPOSURE");
});
test("duplicate addresses and maximum open positions are blocked", () => {
  const s = initialPaperState(now); enterPaper(s, candidate(), 10, now);
  assert.equal(enterPaper(s, candidate(), 10, now).reason, "DUPLICATE_POSITION");
  for (let i = 2; i <= 6; i++) {
    const q = quote(); q.tokenAddress = `0x${String(i).repeat(40)}`;
    const c = candidate(q); c.tokenAddress = q.tokenAddress;
    assert.equal(enterPaper(s, c, 10, now).reason, i === 6 ? "MAX_OPEN_POSITIONS" : "ALL_PAPER_GATES_CLEARED");
  }
  assert.equal(s.positions.length, 5);
});
test("daily realized loss is gross losses in UTC, blocks entries but resets next day", async () => {
  const s = initialPaperState(now);
  // Legacy trades isolate the daily account limit from the versioned strategy cooldown.
  for (let i = 0; i < 6; i++) {
    const c = candidate(); c.launchId = `loss-${i}`;
    assert.equal(enterPaper(s, c, 10, now).outcome, "PAPER_BUY");
    delete s.positions[0]!.plan.strategyVersion;
    await closeAt(s, .1);
  }
  assert.equal(enterPaper(s, candidate(), 10, now).reason, "DAILY_LOSS_LIMIT");
  const q = quote(); q.timestamp = q.blockTimestamp = new Date(now + 86_400_000).toISOString(); q.evidence!.usdTimestamp = q.timestamp;
  assert.equal(enterPaper(s, { ...candidate(q), ...chronology(now + 86_400_000) }, 10, now + 86_400_000).outcome, "PAPER_BUY");
});
for (const price of [0, -1, NaN, Infinity]) {
  test(`invalid quote price ${price} cannot enter or cause zero exit`, () => {
    const s = initialPaperState(now); assert.equal(enterPaper(s, candidate(quote(price)), 10, now).outcome, "NOT_TRADABLE");
    enterPaper(s, candidate(), 10, now); markPaperPosition(s, s.positions[0]!.id, available(quote(price, "SELL")), now);
    assert.equal(s.positions.length, 1); assert.equal(s.trades.length, 0); assert.equal(accountSummary(s).equity, 1000);
  });
}
test("stale block, stale quote, future timestamp and malformed date cannot enter", () => {
  for (const field of ["timestamp", "blockTimestamp"] as const) for (const date of [new Date(now-30_001).toISOString(), new Date(now+1).toISOString(), "invalid"]) {
    const q = quote(); q[field] = date;
    assert.equal(quoteProblem(q, now, 30_000), "QUOTE_STALE");
    assert.equal(enterPaper(initialPaperState(now), candidate(q), 10, now).outcome, "NOT_TRADABLE");
  }
});
test("missing quote, RPC failure and stale exit preserve positions and last-known valuation", async () => {
  const s = initialPaperState(now); const c = candidate(); c.quote = missing;
  assert.equal(enterPaper(s, c, 10, now).outcome, "PAPER_REJECT");
  enterPaper(s, candidate(), 10, now);
  await monitorPaper(s, async () => { throw new Error("RPC failure"); }, () => now);
  assert.equal(s.positions[0]?.markReason, "QUOTE_UNAVAILABLE");
  await monitorPaper(s, async () => missing, () => now);
  await monitorPaper(s, async () => available(quote(.1, "SELL")), () => now + 60_000);
  assert.equal(s.positions.length, 1); assert.equal(s.trades.length, 0); assert.equal(accountSummary(s).equity, 1000);
  assert.equal(s.positions[0]?.markReason, "QUOTE_STALE");
});
test("WATCH needs the completed chain and quote; VETO or incomplete evidence cannot enter", () => {
  const s = initialPaperState(now);
  const veto = candidate(); veto.decision = "VETO";
  assert.equal(enterPaper(s, veto, 10, now).outcome, "VETO");
  const c = candidate(); c.evidenceComplete = false; assert.equal(isPaperTradeEligible(c, s, 10, now).reason, "INCOMPLETE_GPTHEIST_WATCH");
  c.evidenceComplete = true; c.handoffs = []; assert.equal(enterPaper(s, c, 10, now).reason, "INCOMPLETE_GPTHEIST_WATCH");
  c.handoffs = candidate().handoffs; c.handoffs[8]!.outcome = "VETO"; assert.equal(enterPaper(s, c, 10, now).outcome, "VETO");
  assert.equal(s.positions.length, 0); assert.equal(s.decisions.length, 3);
});
test("mismatched quote direction, address, size and exit quantity are rejected", () => {
  const s = initialPaperState(now); const q = quote(); q.side = "SELL";
  q.evidence!.amountIn = q.tokenUnits!;
  assert.equal(enterPaper(s, candidate(q), 10, now).reason, "QUOTE_MISMATCH");
  q.side = "BUY"; q.tokenAddress = `0x${"a".repeat(40)}`;
  assert.equal(enterPaper(s, candidate(q), 10, now).reason, "QUOTE_MISMATCH");
  assert.equal(enterPaper(s, candidate(quote(1, "BUY", 9)), 10, now).reason, "QUOTE_SIZE_MISMATCH");
  enterPaper(s, candidate(), 10, now); markPaperPosition(s, s.positions[0]!.id, available(quote(.1, "SELL", 9)), now);
  assert.equal(s.trades.length, 0);
});
test("statistics count losing trades and equity drawdown including unrealized declines", async () => {
  const s = initialPaperState(now);
  for (const price of [1.3, .8]) { const c = candidate(); c.launchId = `stats-${price}`; enterPaper(s, c, 10, now); await closeAt(s, price, now + 1000); }
  const p = performance(s); assert.equal(p.totalTrades, 2); assert.equal(p.wins, 1); assert.equal(p.losses, 1); assert.equal(p.winRate, 50);
  assert.equal(p.grossProfit, 3); assert.equal(p.grossLoss, 2); assert.equal(p.netPnl, 1); assert.equal(p.averageWin, 3); assert.equal(p.averageLoss, -2);
  assert.equal(p.profitFactor, 1.5); assert.equal(p.expectancy, .5); assert.equal(p.averageHoldingTime, 1000);
  assert.equal(p.maximumDrawdownUsd, 2); assert.equal(p.maximumDrawdown, 2/1003*100);
  enterPaper(s, candidate(), 10, now); markPaperPosition(s, s.positions[0]!.id, available(quote(.95, "SELL")), now);
  assert.equal(performance(s).maximumDrawdownUsd, 2.5);
});
test("persistent state survives restart, refuses concurrent writers, and reset only changes paper data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-test-"));
  let store = await PaperStore.open(join(directory, "paper"));
  await writeFile(join(directory, "research.jsonl"), "research");
  await store.update(s => { enterPaper(s, candidate(), 10, now); });
  await assert.rejects(PaperStore.open(join(directory, "paper")), /owned/);
  const storeModule = new URL("../src/paper-store.js", import.meta.url).href;
  const childResult = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { PaperStore } from ${JSON.stringify(storeModule)}; try { await PaperStore.open(process.argv[1]); console.log("unexpected writer opened"); } catch (error) { console.log(error.message); }`,
    join(directory, "paper")], { encoding: "utf8" });
  assert.equal(childResult.trim(), "Paper account already owned by a running process");
  await store.close(); store = await PaperStore.open(join(directory, "paper"));
  assert.equal(store.read().positions.length, 1); assert.equal(store.read().cash, 990);
  await store.update(async s => { await closeAt(s, .8); });
  await store.close(); store = await PaperStore.open(join(directory, "paper"));
  assert.equal(store.read().trades[0]?.pnlUsd, -2);
  await store.reset(); assert.equal(store.read().cash, 1000); assert.equal(store.read().trades.length, 0);
  assert.equal(await readFile(join(directory, "research.jsonl"), "utf8"), "research"); await store.close();
});
test("stale writer locks recover only after proving their PID owner is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-stale-lock-"));
  const previous = await PaperStore.open(directory);
  await previous.close();
  const lock = join(directory, "writer.lock");
  await writeFile(lock, String(process.pid));
  await assert.rejects(PaperStore.open(directory), /already owned/);
  await utimes(lock, new Date(0), new Date(0));
  const legacyRecovery = await PaperStore.open(directory);
  assert.equal(legacyRecovery.read().cash, 1000);
  await legacyRecovery.close();
  await writeFile(lock, JSON.stringify({ pid: process.pid, startTicks: "0" }));
  const recovered = await PaperStore.open(directory);
  assert.equal(recovered.read().cash, 1000);
  await recovered.close();
});
test("corrupt storage fails closed, and failed transactions do not alter the account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-test-"));
  const store = await PaperStore.open(directory);
  await assert.rejects(store.update(s => { s.cash = NaN; })); assert.equal(store.read().cash, 1000); await store.close();
  await writeFile(join(directory, "state.json"), "{}"); await assert.rejects(PaperStore.open(directory), /Invalid paper state/);
});
test("PAPER route serializes the persisted account and the base account endpoint stays read-only", async t => {
  const directory = await mkdtemp(join(tmpdir(), "paper-api-"));
  const seed = await PaperStore.open(directory);
  await seed.update(state => {
    state.config.STARTING_BALANCE_USD = 50;
    state.cash = 50;
    state.history = [{ timestamp: new Date(now).toISOString(), equity: 50, stalePositions: 0 }];
  });
  await seed.close();
  const paper = await startPaperEngine({ directory, usdFetch: (async () => { throw new Error("offline USD test"); }) as typeof fetch,
    rpc: async () => { throw new Error("offline test"); } });
  const server = createDeskServer({ paper });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  t.after(async () => { await paper.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const html = await (await fetch(`${base}/paper`)).text();
  for (const label of ["PAPER MODE", "SIMULATED EXECUTION", "NO REAL MONEY", "BALANCE HISTORY", "RESET ACCOUNT \\+ CLEAR HISTORY", "MAXIMUM OPEN TRADES"]) assert.match(html, new RegExp(label));
  const data = await (await fetch(`${base}/api/paper`)).json() as { mode: string; account: { equity: number; startingBalance: number }; trades: unknown[]; history: unknown[] };
  assert.equal(data.mode, "PAPER"); assert.equal(data.account.equity, 50); assert.equal(data.account.startingBalance, 50);
  assert.equal(data.trades.length, 0); assert.equal(data.history.length, 1);
  assert.equal((await fetch(`${base}/api/paper`, { method: "POST" })).status, 405);
});

test("paper controls update the open-trade limit and reset visible account history to chosen equity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "paper-controls-"));
  const seeded = await PaperStore.open(directory);
  await seeded.update(state => {
    enterPaper(state, candidate(), 10, now);
    state.history.push({ timestamp: new Date(now + 1000).toISOString(), equity: 1000, stalePositions: 0 });
    state.events.push({ timestamp: new Date(now).toISOString(), category: "PAPER", stage: "PAPER", tokenAddress: token,
      tokenSymbol: "TEST", eventType: "TEST_HISTORY", message: "test only", metadata: {} });
  });
  await seeded.close();
  const paper = await startPaperEngine({ directory, usdFetch: (async () => { throw new Error("offline USD test"); }) as typeof fetch,
    rpc: async () => { throw new Error("offline test"); } });
  const server = createDeskServer({ paper });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  t.after(async () => { await paper.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const update = (path: string, body: unknown, origin = base) => fetch(`${base}${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body)
  });
  assert.equal((await update("/api/paper/settings", { maxOpenTrades: 4 }, "http://attacker.invalid")).status, 403);
  const settings = await update("/api/paper/settings", { maxOpenTrades: 4 });
  assert.equal(settings.status, 200);
  const configured = await settings.json() as { config: { MAX_OPEN_POSITIONS: number }; positions: unknown[] };
  assert.equal(configured.config.MAX_OPEN_POSITIONS, 4);
  assert.equal(configured.positions.length, 1);
  const reset = await update("/api/paper/reset", { startingBalanceUsd: 2500 });
  assert.equal(reset.status, 200);
  const cleared = await reset.json() as { account: { equity: number; startingBalance: number }; config: { MAX_OPEN_POSITIONS: number }; positions: unknown[]; trades: unknown[]; history: unknown[] };
  assert.equal(cleared.account.equity, 2500);
  assert.equal(cleared.account.startingBalance, 2500);
  assert.equal(cleared.config.MAX_OPEN_POSITIONS, 4);
  assert.equal(cleared.positions.length, 0);
  assert.equal(cleared.trades.length, 0);
  assert.equal(cleared.history.length, 1);
});

test("malformed quote shape is rejected without throwing", () => {
  assert.equal(quoteProblem({} as PaperQuote, now, 30000), "INVALID_QUOTE");
});
test("invalid rejected quote can be persisted without NaN becoming a price", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-invalid-"));
  const store = await PaperStore.open(directory);
  await store.update(s => { enterPaper(s, candidate(quote(NaN)), 10, now); });
  assert.equal(store.read().decisions[0]?.candidate.quote.status, "NOT_PAPER_TRADABLE");
  assert.equal(store.read().positions.length, 0); await store.close();
});
test("recovered paper monitor can still exit while daily entry loss gate is reached", async () => {
  const s = initialPaperState(now, { ...PAPER_CONFIG, MAX_DAILY_LOSS_USD: 1 });
  enterPaper(s, candidate(), 10, now);
  const q = quote(); q.tokenAddress = `0x${"2".repeat(40)}`; const c = candidate(q); c.tokenAddress = q.tokenAddress;
  enterPaper(s, c, 10, now);
  await closeAt(s, .8);
  const newCandidate = candidate(); newCandidate.launchId = "new-launch";
  assert.equal(enterPaper(s, newCandidate, 10, now).reason, "DAILY_LOSS_LIMIT");
  s.positions[0]!.plan.exitPolicy.maxHoldMs = 1;
  await monitorPaper(s, async p => { const exit = quote(1.3, "SELL"); exit.tokenAddress = p.tokenAddress; return available(exit); }, () => now + 1000);
  assert.equal(s.positions.length, 0); assert.equal(s.trades.length, 2);
});
test("HTTP RPC adapter refuses non-read methods before network access", async () => {
  const { createHttpRpcCaller } = await import("../src/server.js");
  const rpc = createHttpRpcCaller("https://example.invalid", { fetch: (() => { throw new Error("must not fetch"); }) as typeof fetch });
  await assert.rejects(rpc("eth_sendRawTransaction", []), /read-only allowlist/);
});

test("live adapter preserves WATCH semantics and never fabricates an executable quote", async () => {
  const { liveCandidate, observeSnapshot } = await import("../src/paper.js");
  const { readPaperExitQuote } = await import("../src/paper-quotes.js");
  const launch: import("../src/live.js").LiveLaunchDecision = {
    token, curve: `0x${"2".repeat(40)}`, deployer: `0x${"3".repeat(40)}`, pairToken: `0x${"0".repeat(40)}`,
    launchConfigId: "0", graduationThreshold: "4200000000000000000", blockNumber: 1,
    transactionHash: `0x${"a".repeat(64)}`, logIndex: 0, verdict: "WATCH", pairLabel: "ETH",
    market: { status: "UNAVAILABLE", reason: "TEST missing data" }, metadata: { status: "UNAVAILABLE", reason: "TEST missing data" },
    assessment: { verdict: "WATCH", score: 70, reasons: [], blockers: [], unknowns: ["social", "slippage"] },
    handoffs: candidate().handoffs, deployerResearch: { windowBlocks: 100, priorLaunches: 0, priorGraduations: 0 }
  };
  const c = liveCandidate(launch), state = initialPaperState(now);
  assert.equal(c.decision, "WATCH"); assert.equal(c.evidenceComplete, false); assert.equal(c.quote.status, "NOT_PAPER_TRADABLE");
  const snapshot: import("../src/live.js").LiveSnapshot = { chainId: 4663, headBlock: 2, fetchedAt: new Date(now).toISOString(), source: "Robinhood Chain RPC", mode: "read-only", historyWindowBlocks: 100, launches: [launch] };
  await observeSnapshot(state, snapshot, now); await observeSnapshot(state, snapshot, now);
  assert.equal(state.positions.length, 0); assert.equal(state.decisions.length, 1); assert.equal(state.latestGate?.outcome, "PAPER_REJECT");
  assert.equal(state.events.filter(e => e.category === "RESEARCH").length, 10);
  const positioned = initialPaperState(now); enterPaper(positioned, candidate(), 10, now);
  positioned.positions[0]!.candidate.launch = launch;
  delete positioned.positions[0]!.entry.tokenUnits;
  const result = await readPaperExitQuote(async () => { throw new Error("must not read without exact quantity"); }, positioned.positions[0]!);
  assert.equal(result.status, "NOT_PAPER_TRADABLE");
  if (result.status === "NOT_PAPER_TRADABLE") assert.equal(result.reason, "MISSING_EXACT_TOKEN_UNITS");
  markPaperPosition(positioned, positioned.positions[0]!.id, result, now); assert.equal(positioned.trades.length, 0);
});

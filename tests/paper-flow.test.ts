import { seedLiquidityHistory, seedTractionHistory } from "./liquidity-history-fixture.js";
import { enterPaper, observeSnapshot } from "./liquidity-history-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LiveLaunchDecision } from "../src/live.js";
import {  accountSummary, initialPaperState, liveCandidate, quoteProblem  } from "../src/paper.js";
import { createEthUsdProvider, readPaperQuote } from "../src/paper-quotes.js";
import { PaperService } from "../src/paper-service.js";
import { PaperStore } from "../src/paper-store.js";

import { fixture } from "./paper-fixtures.js";
const eth = 10n ** 18n;

test("full WATCH chain → verified sized quote → risk checks → PAPER_ELIGIBLE → simulated buy", async () => {
  const f = fixture(), s = initialPaperState(f.time);
  await observeSnapshot(s, f.snapshot, f.time, (_launch, size) => f.buy(size));
  assert.equal(s.positions.length, 1); assert.equal(s.cash, 1000 - s.positions[0]!.sizeUsd);
  assert.equal(s.positions[0]!.candidate.decision, "WATCH");
  assert.equal(s.decisions[0]!.outcome, "PAPER_ELIGIBLE");
  for (const event of ["QUOTE_VERIFIED", "PAPER_ELIGIBLE", "POSITION_SIZE_CALCULATED", "TRADE_PLAN_CREATED", "PAPER_BUY"]) assert.ok(s.events.some(e => e.eventType === event));
  assert.equal(s.events.filter(e => e.category === "RESEARCH").length, 10);
  const q = s.positions[0]!.entry;
  assert.ok(BigInt(q.tokenUnits!) > 0n);
  assert.ok(q.costs.feesUsd! > 0);
  assert.equal(s.positions[0]!.plan.approvedSizeUsd, s.positions[0]!.sizeUsd);
  assert.equal(q.evidence?.ethUsd, 2000); assert.equal(q.evidence?.model, "PONS_V2_CURVE");
  assert.ok(q.fillPriceUsd > q.rawPriceUsd); assert.ok(q.costs.priceImpactPercent! > 0);
  assert.equal(q.costs.gasUsd, null); assert.equal(q.costs.slippageUsd, null);
  await observeSnapshot(s, f.snapshot, f.time, (_launch, size) => f.buy(size));
  assert.equal(s.positions.length, 1); assert.equal(s.decisions.length, 1);
});

test("entry requires all ten stages in order, a WATCH verdict, and no agent veto", async () => {
  for (const mutate of [
    (l: LiveLaunchDecision) => { l.handoffs.pop(); },
    (l: LiveLaunchDecision) => { l.handoffs.reverse(); },
    (l: LiveLaunchDecision) => { l.handoffs[3]!.outcome = "VETO"; },
    (l: LiveLaunchDecision) => { l.verdict = "VETO"; }
  ]) {
    const f = fixture(), s = initialPaperState(f.time); mutate(f.launch);
    await observeSnapshot(s, f.snapshot, f.time, async () => { assert.fail("Incomplete/vetoed chain must not request a quote"); });
    assert.equal(s.positions.length, 0);
  }
});

test("stale research and stale USD evidence never create eligibility", async () => {
  const f = fixture(), s = initialPaperState(f.time);
  f.snapshot.fetchedAt = new Date(f.time - 31_000).toISOString();
  await observeSnapshot(s, f.snapshot, f.time, async () => { assert.fail("Stale research must not request quotes"); });
  assert.equal(s.decisions[0]!.reason, "STALE_RESEARCH");
  const q = await f.buy(); assert.equal(q.status, "AVAILABLE");
  if (q.status === "AVAILABLE") {
    q.quote.evidence!.usdTimestamp = new Date(f.time - 31_000).toISOString();
    assert.equal(quoteProblem(q.quote, f.time, 30_000), "ETH_USD_STALE");
  }
});

for (const [label, mutate] of [
  ["wrong chain", (f: ReturnType<typeof fixture>) => { f.state.chain = "0x1"; }],
  ["stale block", (f: ReturnType<typeof fixture>) => { f.state.blockTime -= 31; }],
  ["stale USD", (f: ReturnType<typeof fixture>) => { f.state.usd.timestamp = new Date(f.time - 31_000).toISOString(); }],
  ["future USD", (f: ReturnType<typeof fixture>) => { f.state.usd.timestamp = new Date(f.time + 1).toISOString(); }],
  ["invalid USD", (f: ReturnType<typeof fixture>) => { f.state.usd.ask = NaN; }],
  ["wrong token", (f: ReturnType<typeof fixture>) => { f.state.identity = f.launch.deployer; }],
  ["graduated pool", (f: ReturnType<typeof fixture>) => { f.state.phase = 2; }],
  ["ready to graduate", (f: ReturnType<typeof fixture>) => { f.state.ready = true; }],
  ["partial fill", (f: ReturnType<typeof fixture>) => { f.state.sellable = 1n; }],
  ["fee bounds", (f: ReturnType<typeof fixture>) => { f.state.fee = 2001n; }],
  ["reorg", (f: ReturnType<typeof fixture>) => { f.state.reorg = true; }],
  ["RPC outage", (f: ReturnType<typeof fixture>) => { f.state.fail = true; }]
] as const) test(`quote rejects ${label}`, async () => {
  const f = fixture(); mutate(f);
  assert.equal((await f.buy()).status, "NOT_PAPER_TRADABLE");
});

test("buy includes current opening tax; sell does not charge that tax", async () => {
  const f = fixture(); f.state.snipe = 100n;
  const q = await f.buy(); assert.equal(q.status, "AVAILABLE");
  if (q.status !== "AVAILABLE") return;
  assert.equal(q.quote.costs.feesUsd, .3);
  const exit = await readPaperQuote(f.rpc, async () => f.state.usd, f.launch,
    { side: "SELL", tokenUnits: q.quote.tokenUnits!, quantity: q.quote.quantity }, () => f.time);
  assert.equal(exit.status, "AVAILABLE");
  if (exit.status === "AVAILABLE") assert.equal(exit.quote.evidence?.snipeTaxBps, 0);
});

test("high impact and missing quote provenance block buys", async () => {
  const f = fixture(), s = initialPaperState(f.time), c = liveCandidate(f.launch);
  c.quote = await f.buy(); assert.equal(c.quote.status, "AVAILABLE");
  if (c.quote.status !== "AVAILABLE") return;
  c.quote.quote.costs.priceImpactPercent = 5.1;
  assert.equal(enterPaper(s, c, 10, f.time).reason, "PRICE_IMPACT_LIMIT");
  c.quote.quote.costs.priceImpactPercent = 0;
  delete c.quote.quote.evidence;
  assert.equal(enterPaper(s, c, 10, f.time).reason, "MISSING_QUOTE_PROVENANCE");
  assert.equal(s.positions.length, 0);
});

for (const [reserve, reason] of [[3n, "TRAILING_EXIT"], [1n, "DYNAMIC_RISK_EXIT"]] as const) {
  test(`background service persists entry, tracks prices and exits at ${reason} across restart`, async () => {
    const f = fixture(), directory = await mkdtemp(join(tmpdir(), "paper-flow-"));
    let store = await PaperStore.open(directory);
    const entry = (_launch: LiveLaunchDecision, sizeUsd: number) => readPaperQuote(f.rpc, async () => f.state.usd, f.launch, { side: "BUY", sizeUsd });
    const exit = (p: import("../src/paper.js").Position) => readPaperQuote(f.rpc, async () => f.state.usd, f.launch,
      { side: "SELL", tokenUnits: p.entry.tokenUnits!, quantity: p.quantity });
    const initialQuote = await f.buy();
    if (initialQuote.status !== "AVAILABLE") throw new Error("fixture");
    await store.update(state => { const candidate = liveCandidate(f.launch); seedTractionHistory(state, candidate); seedLiquidityHistory(state, candidate, initialQuote.quote); });
    let retryTime = Date.now();
    let service = new PaperService(store, async () => f.snapshot, exit, entry, undefined, () => retryTime);
    try { await service.tick(); assert.equal(store.read().positions.length, 1); }
    finally { await service.close(); }
    store = await PaperStore.open(directory);
    service = new PaperService(store, async () => f.snapshot, exit, entry, undefined, () => retryTime);
    try {
      f.state.reserve = 21n * eth / 10n;
      await service.tick(); assert.equal(store.read().positions.length, 1);
      assert.notEqual(accountSummary(store.read()).unrealizedPnl, 0);
      const mark = store.read().positions[0]!.current.fillPriceUsd;
      f.state.fail = true; await service.tick();
      assert.equal(store.read().positions[0]!.current.fillPriceUsd, mark);
      assert.equal(store.read().positions[0]!.markStatus, "UNAVAILABLE");
      const callsBeforeCooldown = f.methods.length;
      await service.monitor(); assert.equal(f.methods.length, callsBeforeCooldown, "RPC backoff prevents immediate repeated requests");
      retryTime += 60_001;
      f.state.fail = false; f.state.reserve = reserve * eth;
      await service.tick();
      if (reserve === 3n) { f.state.reserve = 26n * eth / 10n; await service.tick(); }
      assert.equal(store.read().positions.length, 0);
      assert.equal(store.read().trades[0]!.exitReason, reason);
      f.snapshot.fetchedAt = new Date(Date.now()).toISOString();
      await service.tick(); assert.equal(store.read().positions.length, 0, "Never re-enter a completed launch");
      assert.equal(store.read().trades.length, 1);
      assert.ok(f.methods.every(m => ["eth_chainId", "eth_blockNumber", "eth_call", "eth_getBlockByNumber"].includes(m)));
    } finally { await service.close(); }
  });
}

test("USD provider validates source timestamps, coalesces requests and never falls back after failure", async () => {
  const now = Date.now(); let calls = 0, clock = now, fail = false;
  const provider = createEthUsdProvider((async (url: string) => {
    assert.equal(url, "https://api.exchange.coinbase.com/products/ETH-USD/ticker"); calls++;
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify({ bid: "2000", ask: "2001", time: new Date(now).toISOString() }));
  }) as typeof fetch, () => clock);
  const [a, b] = await Promise.all([provider(), provider()]); assert.deepEqual(a, b); assert.equal(calls, 1);
  await provider(); assert.equal(calls, 1);
  clock += 31_000; await assert.rejects(provider(), /ETH_USD_STALE/);
  fail = true; await assert.rejects(provider(), /ETH_USD_UNAVAILABLE/);
});

test("monitor refreshes while discovery is blocked and preserves the underlying failure in the view", async () => {
  const f = fixture(), store = await PaperStore.open(await mkdtemp(join(tmpdir(), "paper-monitor-")));
  await store.update(state => observeSnapshot(state, f.snapshot, f.time, (_launch, size) => f.buy(size)));
  let release!: (s: typeof f.snapshot) => void;
  const stalled = new Promise<typeof f.snapshot>(resolve => { release = resolve; });
  let calls = 0;
  const service = new PaperService(store, () => stalled, async () => {
    calls++;
    return { status: "NOT_PAPER_TRADABLE", reason: "INSUFFICIENT_EXIT_LIQUIDITY", details: ["Real reserve is 1 wei"] };
  });
  const tick = service.tick();
  try {
    await service.monitor();
    const before = calls;
    await service.monitor();
    assert.ok(calls > before, "Discovery must not hold the monitor/account lock");
    await store.update(state => { const q = state.positions[0]!.current; q.timestamp = q.blockTimestamp = new Date(f.time - 60_000).toISOString(); if (q.evidence) q.evidence.usdTimestamp = q.timestamp; });
    const p = service.view().positions[0]!;
    assert.equal(p.markReason, "INSUFFICIENT_EXIT_LIQUIDITY");
    assert.equal(p.markStatus, "UNAVAILABLE");
    assert.ok(p.lastQuoteAttempt);
    assert.equal(p.management.lastSuccessfulQuote?.side, "SELL");
    assert.deepEqual(p.quoteFailureDetails, ["Real reserve is 1 wei"]);
  } finally { release(f.snapshot); await tick; await service.close(); }
});

test("failed liquidity quotes retain exact inputs, raw responses, and validated launch time", async () => {
  const f = fixture(), buy = await f.buy();
  assert.equal(buy.status, "AVAILABLE"); if (buy.status !== "AVAILABLE") return;
  f.state.real = 1n;
  const launchTime = f.time - 120_000;
  const rpc: typeof f.rpc = async (method, params) => method === "eth_getBlockByNumber" && params?.[0] === "0x1"
    ? { number: "0x1", hash: `0x${"a".repeat(64)}`, timestamp: `0x${Math.floor(launchTime / 1000).toString(16)}` }
    : f.rpc(method, params);
  const result = await readPaperQuote(rpc, async () => f.state.usd, f.launch,
    { side: "SELL", tokenUnits: buy.quote.tokenUnits!, quantity: buy.quote.quantity }, () => f.time);
  assert.equal(result.status, "NOT_PAPER_TRADABLE");
  assert.equal(result.diagnostics?.failure, "INSUFFICIENT_EXIT_LIQUIDITY");
  assert.equal(result.diagnostics?.input.tokenUnits, buy.quote.tokenUnits);
  assert.equal(result.diagnostics?.calculation?.realQuoteReserveWei, "1");
  assert.equal(result.diagnostics?.launchTimestamp, new Date(Math.floor(launchTime / 1000) * 1000).toISOString());
  assert.equal(result.diagnostics?.rpc.filter(r => r.method === "eth_call" && typeof r.response === "string").length, 2);
});


test("entry stores explicitly derived curve FDV from pinned spot price and decimal-normalized supply", async () => {
  const f = fixture(), state = initialPaperState(f.time);
  await observeSnapshot(state, f.snapshot, f.time, (_launch, size) => f.buy(size));
  const position = state.positions[0]!;
  assert.equal(position.entry.totalSupplyTokens, "1000000000");
  assert.equal(position.entry.derivedFdvUsd, position.entry.rawPriceUsd * 1_000_000_000);
  assert.equal(position.entry.totalSupplyRaw, "1000000000000000000000000000");
  assert.equal(position.entry.valuationBasis, "TOTAL_SUPPLY_X_CURVE_SPOT");
  assert.equal(position.entry.marketCapUsd, undefined);
  const savedCap = position.entry.derivedFdvUsd;
  f.state.reserve *= 2n; f.state.supply = 2_000_000_000n * eth;
  const newQuote = await f.buy(); assert.equal(newQuote.status, "AVAILABLE");
  if (newQuote.status === "AVAILABLE") assert.notEqual(newQuote.quote.derivedFdvUsd, savedCap);
  assert.equal(position.entry.derivedFdvUsd, savedCap);
});

test("missing total supply leaves derived FDV unknown without rejecting executable quotes", async () => {
  const f = fixture(); f.state.supply = null;
  const result = await f.buy(); assert.equal(result.status, "AVAILABLE");
  if (result.status === "AVAILABLE") {
    assert.equal(result.quote.derivedFdvUsd, undefined);
    assert.equal(result.quote.totalSupplyTokens, undefined);
  }
});

test("discovery starts while a position quote is stalled and committed activity is printed", async () => {
  const f = fixture(), store = await PaperStore.open(await mkdtemp(join(tmpdir(), "paper-fast-discovery-")));
  await store.update(state => observeSnapshot(state, f.snapshot, f.time, (_launch, size) => f.buy(size)));
  let release!: (result: import("../src/paper.js").QuoteResult) => void;
  const stalled = new Promise<import("../src/paper.js").QuoteResult>(resolve => { release = resolve; });
  let discovered = false;
  const messages: string[] = [];
  const service = new PaperService(store, async () => { discovered = true; return { ...f.snapshot, fetchedAt: new Date(f.time + 1).toISOString() }; }, () => stalled,
    undefined, undefined, Date.now, undefined, { log: message => messages.push(message) });
  const tick = service.tick();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(discovered, true, "A stalled sell quote must not delay launch discovery");
    release({ status: "NOT_PAPER_TRADABLE", reason: "QUOTE_UNAVAILABLE", details: [] });
    await tick;
    assert.ok(messages.some(message => message.includes("PAPER scan:")));
    assert.ok(messages.some(message => message.includes("QUOTE_UNAVAILABLE")));
  } finally {
    release({ status: "NOT_PAPER_TRADABLE", reason: "QUOTE_UNAVAILABLE", details: [] });
    await tick;
    await service.close();
  }
});

test("cached snapshots do not repeat entry work or whole-account discovery writes", async () => {
  const f = fixture(), store = await PaperStore.open(await mkdtemp(join(tmpdir(), "paper-cached-scan-")));
  const service = new PaperService(store, async () => f.snapshot,
    async () => ({ status: "NOT_PAPER_TRADABLE", reason: "TEST", details: [] }));
  try {
    await service.tick();
    const before = store.read();
    await service.tick();
    assert.deepEqual(store.read(), before);
    assert.equal(before.events.filter(e => e.eventType === "PAPER_LAB_FRAME").length, 0);
    const researchFiles=await readdir(join(store.directory,"research"));
    assert.equal(researchFiles.length,1,"Raw research frame uses bounded separate tape");
    const frames=(await readFile(join(store.directory,"research",researchFiles[0]!),"utf8")).trim().split("\n");
    assert.equal(frames.length,1,"Cached snapshots do not record duplicate frames");
    assert.equal(service.view().connection, "LIVE");
  } finally { await service.close(); }
});

import { withRpcPriority, runtimeLimits, WorkLimiter } from "./runtime-limits.js";
import { PaperGasCounter } from "./paper-gas.js";
import { readV4SellQuote } from "./uniswap-v4.js";
import { curveAmountOut, uint256 } from "./paper-math.js";
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID, PONS_FACTORY, type LiveLaunchDecision, type RpcCaller } from "./live.js";
import { MULTICALL3, assessPonsLaunch, readPonsLaunchResearch } from "./market.js";
import { PAPER_CONFIG, quoteProblem, type PaperConfig, type PaperQuote, type Position, type QuoteResult, type QuoteDiagnostics } from "./paper.js";

const USD_URL = "https://api.exchange.coinbase.com/products/ETH-USD/ticker";
const BPS = 10_000n;
/** Exact rational conversion. Numbers are serialized first; no float division enters base units. */
export function usdToWei(usd: string, ethUsd: string): bigint {
  const rational = (value: string): [bigint, bigint] => {
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new QuoteDataError("INVALID_SIZE");
    const [whole, fraction = ""] = value.split(".");
    return [BigInt(whole! + fraction), 10n ** BigInt(fraction.length)];
  };
  const [a, b] = rational(usd), [c, d] = rational(ethUsd);
  if (a <= 0n || c <= 0n) throw new QuoteDataError("INVALID_SIZE");
  return a * d * 10n ** 18n / (b * c);
}
const ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function token() view returns (address)",
  "function factory() view returns (address)",
  "function pairToken() view returns (address)",
  "function decimals() view returns (uint8)"
]);
const MULTICALL_ABI = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"
]);
export interface UsdRate { bid: number; ask: number; timestamp: string; source: string }
export type UsdRateProvider = () => Promise<UsdRate>;
const unavailable = (reason: string, details: string[] = []): QuoteResult => ({ status: "NOT_PAPER_TRADABLE", reason, details });
const fresh = (timestamp: string, now: number, maxAge: number = PAPER_CONFIG.ETH_USD_MAX_AGE_MS): boolean => {
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= 0 && age <= maxAge;
};

/** Timestamp comes from the source trade, never from the local fetch time. No fallback price. */
export class QuoteDataError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export function classifyQuoteError(error: unknown): string {
  if (error instanceof QuoteDataError) return error.reason;
  const message = String(error);
  if (/429|rate.limit/i.test(message)) return "RPC_RATE_LIMIT";
  if (/timeout|abort/i.test(message)) return "RPC_TIMEOUT";
  if (/revert/i.test(message)) return "CONTRACT_REVERT";
  if (/UINT256_OVERFLOW|INVALID_CURVE_INPUT|INSUFFICIENT_OUTPUT_AMOUNT/.test(message)) return "INVALID_TOKEN_AMOUNT";
  return "RPC_ERROR";
}
export function createEthUsdProvider(fetcher: typeof fetch = fetch, clock = Date.now, maxAge: number = PAPER_CONFIG.ETH_USD_MAX_AGE_MS): UsdRateProvider {
  let cached: UsdRate | undefined;
  let fetchedAt = 0;
  let pending: Promise<UsdRate> | undefined;
  return async () => {
    if (cached && clock() - fetchedAt < 5_000 && fresh(cached.timestamp, clock(), maxAge)) return cached;
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetcher(USD_URL, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`ETH/USD HTTP ${response.status}`);
        const data = await response.json() as { bid?: unknown; ask?: unknown; time?: unknown };
        const bid = Number(data.bid), ask = Number(data.ask);
        if (typeof data.bid !== "string" || typeof data.ask !== "string" || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid || ask / bid > 1.05 ||
            typeof data.time !== "string") throw new QuoteDataError("ETH_USD_UNAVAILABLE");
        if (!fresh(data.time, clock(), maxAge)) throw new QuoteDataError("ETH_USD_STALE");
        cached = { bid, ask, timestamp: data.time, source: USD_URL }; fetchedAt = clock(); return cached;
      } catch (error) { throw error instanceof QuoteDataError ? error : new QuoteDataError("ETH_USD_UNAVAILABLE"); }
      finally { clearTimeout(timeout); }
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

interface Header { number: string; hash: string; timestamp: string }
function header(value: unknown, block: string): Header {
  const h = value as Header | null;
  if (!h || h.number !== block || !/^0x[0-9a-f]{64}$/i.test(h.hash) || !/^0x[0-9a-f]+$/i.test(h.timestamp)) throw new Error("Invalid quote block");
  return h;
}

/** Pons documented integer pricing: https://docs.ponsfamily.com/v2#getting-a-quote.
 * Reads only. Real reserves bound sell liquidity; virtual reserves price the sized trade.
 * Curve completion and partial/graduation fills are deliberately unsupported.
 */
async function calculatePaperQuote(
  rpc: RpcCaller, usd: UsdRateProvider, launch: LiveLaunchDecision,
  order: { side: "BUY"; sizeUsd: number } | { side: "SELL"; tokenUnits: string; quantity: number; tokenDecimals?: number },
  clock = Date.now, config: PaperConfig = PAPER_CONFIG, diagnostics?: QuoteDiagnostics
): Promise<QuoteResult> {
  try {
    if (launch.pairToken !== `0x${"0".repeat(40)}`) return unavailable("UNSUPPORTED_PAIR");
    const [chain, block] = await Promise.all([rpc("eth_chainId"), rpc("eth_blockNumber")]);
    if (chain !== `0x${ROBINHOOD_CHAIN_ID.toString(16)}`) return unavailable("WRONG_CHAIN");
    if (typeof block !== "string" || !/^0x[0-9a-f]+$/i.test(block) || !Number.isSafeInteger(Number(BigInt(block)))) return unavailable("INVALID_BLOCK");
    if (diagnostics) diagnostics.currentBlock = Number(BigInt(block));
    const requiredNames = ["feeBps", "sellableTokens", "graduated", "readyToGraduate", "token", "factory", "pairToken", "decimals"] as const;
    const names = order.side === "BUY" ? [...requiredNames, "totalSupply" as const] : requiredNames;
    const calls = names.map(functionName => ({ target: (functionName === "decimals" || functionName === "totalSupply" ? launch.token : launch.curve) as Hex,
      allowFailure: true, callData: encodeFunctionData({ abi: ABI, functionName }) }));
    const [research, raw, rate, rawHeader] = await Promise.all([
      readPonsLaunchResearch(rpc, [launch], block),
      rpc("eth_call", [{ to: MULTICALL3, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [calls] }) }, block]),
      usd(),
      rpc("eth_getBlockByNumber", [block, false])
    ]);
    const h = header(rawHeader, block);
    const blockTimestamp = new Date(Number(BigInt(h.timestamp)) * 1000).toISOString();
    if (diagnostics) diagnostics.blockTimestamp = blockTimestamp;
    if (!fresh(blockTimestamp, clock(), config.QUOTE_MAX_AGE_MS)) return unavailable("QUOTE_STALE");

    const market = research[0]?.market;
    if (diagnostics) diagnostics.market = market;
    if (!market || market.status !== "VERIFIED") {
      const failedRead = diagnostics?.rpc.find(r => r.error && r.method === "eth_call");
      return unavailable(failedRead ? classifyQuoteError(failedRead.error) : "CURVE_STATE_UNAVAILABLE", [market?.reason ?? "Missing market evidence"]);
    }
    if (market.phase !== "CURVE") return unavailable(market.phase === "POOL" || market.phase === "SWEPT" ? "TOKEN_GRADUATED" : "INACTIVE_CURVE", [market.phase, "Graduated pool quoting is not supported; retain last known mark"]);
    if (order.side === "BUY" && assessPonsLaunch("ETH", market).verdict !== "WATCH") return unavailable("MARKET_NO_LONGER_WATCH");
    if (typeof raw !== "string" || !/^0x[0-9a-f]*$/i.test(raw)) return unavailable("INVALID_CURVE_READS");
    const results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: raw as Hex });
    if (!results[7]?.success) return unavailable("TOKEN_UNITS_UNVERIFIED");
    if (results.length !== names.length || results.slice(0, requiredNames.length).some(r => !r.success)) return unavailable("CURVE_READ_UNAVAILABLE");
    const values = requiredNames.map((functionName, index) => decodeFunctionResult({ abi: ABI, functionName, data: results[index]!.returnData }));
    const [fee, sellable, graduated, ready, token, factory, pair, decimals] = values;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return unavailable("TOKEN_UNITS_UNVERIFIED");
    if (typeof fee !== "bigint" || typeof sellable !== "bigint" || typeof decimals !== "number" || decimals > 36 ||
        typeof token !== "string" || token.toLowerCase() !== launch.token.toLowerCase() ||
        typeof factory !== "string" || factory.toLowerCase() !== PONS_FACTORY ||
        typeof pair !== "string" || pair.toLowerCase() !== launch.pairToken.toLowerCase()) return unavailable("CURVE_IDENTITY_MISMATCH");
    if (graduated !== false || ready !== false) return unavailable("TOKEN_GRADUATED");
    if (sellable <= 0n) return unavailable("CURVE_CLOSED");
    // Validate denomination BEFORE any liquidity computation, including on failed quotes.
    if (order.side === "SELL") {
      if (order.tokenDecimals !== undefined && order.tokenDecimals !== decimals) return unavailable("TOKEN_DECIMALS_MISMATCH");
      if (!/^[1-9][0-9]*$/.test(order.tokenUnits) || !Number.isFinite(order.quantity) || order.quantity <= 0) return unavailable("INVALID_TOKEN_AMOUNT");
      const human = Number(formatUnits(BigInt(order.tokenUnits), decimals));
      if (!Number.isFinite(human) || Math.abs(human - order.quantity) > order.quantity * 1e-10) return unavailable("TOKEN_QUANTITY_MISMATCH");
    }
    const qr = BigInt(market.quoteReserve), tr = BigInt(market.tokenReserve), real = BigInt(market.realQuoteReserve);
    const tax = BigInt(market.creatorTaxBps);
    if (fee < 0n || fee + tax > 2_000n || sellable >= tr || real > qr) return unavailable("INVALID_CURVE_STATE");
    const cap = BPS - fee - tax - 100n;
    const rawSnipe = BigInt(market.currentSnipeTaxBps);
    const snipe = order.side === "BUY" ? (rawSnipe < cap ? rawSnipe : cap) : 0n;
    const ethUsd = order.side === "BUY" ? rate.ask : rate.bid;
    if (!Number.isFinite(rate.bid) || !Number.isFinite(rate.ask) || rate.bid <= 0 || rate.ask < rate.bid || rate.ask / rate.bid > 1.05 ||
        !rate.source) return unavailable("ETH_USD_UNAVAILABLE");
    if (!fresh(rate.timestamp, clock(), config.ETH_USD_MAX_AGE_MS)) return unavailable("ETH_USD_STALE");
    // Ensure all pinned reads still refer to the canonical block before using them.
    if (header(await rpc("eth_getBlockByNumber", [block, false]), block).hash !== h.hash) return unavailable("QUOTE_BLOCK_REORG");
    const toUsd = (wei: bigint): number => Number(formatUnits(wei, 18)) * ethUsd;
    let units: bigint, notionalUsd: number, fees: bigint, impact: number;
    let feeWei: bigint, creatorTaxWei: bigint, snipeTaxWei = 0n, amountIn: bigint, amountOut: bigint;
    if (order.side === "BUY") {
      if (!Number.isFinite(order.sizeUsd) || order.sizeUsd <= 0) return unavailable("INVALID_SIZE");
      const input = usdToWei(String(order.sizeUsd), String(ethUsd));
      feeWei = uint256(input * fee) / BPS; creatorTaxWei = uint256(input * tax) / BPS; snipeTaxWei = uint256(input * snipe) / BPS;
      fees = feeWei + creatorTaxWei + snipeTaxWei;
      const net = input - fees;
      if (net <= 0n) return unavailable("INVALID_SIZE");
      units = curveAmountOut(net, qr, tr);
      if (units >= sellable) return unavailable("GRADUATION_FILL_UNSUPPORTED");
      amountIn = input; amountOut = units;
      notionalUsd = toUsd(input);
      impact = Number(net) / Number(qr + net) * 100;
    } else {
      if (!/^[1-9][0-9]*$/.test(order.tokenUnits)) return unavailable("MISSING_EXACT_TOKEN_UNITS");
      units = BigInt(order.tokenUnits);
      const gross = curveAmountOut(units, tr, qr);
      feeWei = uint256(gross * fee) / BPS; creatorTaxWei = uint256(gross * tax) / BPS;
      fees = feeWei + creatorTaxWei;
      if (diagnostics) diagnostics.calculation = { tokenUnits: units.toString(), grossWei: gross.toString(), feeWei: feeWei.toString(), creatorTaxWei: creatorTaxWei.toString(), ethOutWei: (gross - fees).toString(), realQuoteReserveWei: real.toString(), decimals: String(decimals) };
      if (gross > real) return unavailable("INSUFFICIENT_EXIT_LIQUIDITY", [
        `block=${Number(BigInt(block))}; curve=${launch.curve}`,
        `requestedTokenAmount=${units}; tokenReserve=${tr}; pricingQuoteReserveWei=${qr}`,
        `grossEthOutputWei=${gross}; availableEthWei=${real}; condition: ${gross} > ${real} = true`,
        `feeWei=${feeWei}; creatorTaxWei=${creatorTaxWei}; netEthOutputWei=${gross - fees} (not executable)`
      ]);
      amountIn = units; amountOut = gross - fees;
      notionalUsd = toUsd(amountOut);
      impact = Number(units) / Number(tr + units) * 100;
    }
    const quantity = Number(formatUnits(units, decimals));
    if (order.side === "SELL" && Math.abs(quantity - order.quantity) > order.quantity * 1e-10) return unavailable("TOKEN_QUANTITY_MISMATCH");
    // Optional entry context must never decide whether a sell is executable.
    let entryContext: Pick<PaperQuote, "derivedFdvUsd" | "valuationBasis" | "totalSupplyRaw" | "totalSupplyTokens"> = {};
    if (order.side === "BUY" && results[8]?.success) {
      try {
        const supply = decodeFunctionResult({ abi: ABI, functionName: "totalSupply", data: results[8].returnData });
        const totalSupplyTokens = formatUnits(supply, decimals);
        const derivedFdvUsd = Number(totalSupplyTokens) * (toUsd(qr) / Number(formatUnits(tr, decimals)));
        if (supply > 0n && Number.isFinite(derivedFdvUsd) && derivedFdvUsd > 0) entryContext = { totalSupplyTokens, totalSupplyRaw: supply.toString(), derivedFdvUsd, valuationBasis: "TOTAL_SUPPLY_X_CURVE_SPOT" };
      } catch { /* Supply unavailable: leave derived FDV unknown. */ }
    }
    const quote: PaperQuote = {
      ...entryContext,
      quoteRequestedAt: diagnostics?.attemptedAt ?? new Date(clock()).toISOString(), quoteMethod: "PINNED_PONS_V2_INTEGER_MODEL",
      humanAmountIn: formatUnits(amountIn, order.side === "BUY" ? 18 : decimals), humanAmountOut: formatUnits(amountOut, order.side === "BUY" ? decimals : 18),
      quoteAssetDecimals: 18, graduationState: "CURVE",
      tokenAddress: launch.token, side: order.side, timestamp: new Date(clock()).toISOString(), blockTimestamp,
      source: "Pons v2 sized curve model + Coinbase ETH/USD", blockNumber: Number(BigInt(block)),
      rawPriceUsd: toUsd(qr) / Number(formatUnits(tr, decimals)), fillPriceUsd: notionalUsd / quantity,
      quantity, tokenUnits: units.toString(), notionalUsd, liquidityUsd: toUsd(real),
      costs: { feesUsd: toUsd(fees), priceImpactPercent: impact, slippageUsd: null, gasUsd: null },
      evidence: { model: "PONS_V2_CURVE", chainId: ROBINHOOD_CHAIN_ID, curve: launch.curve, blockHash: h.hash,
        ethUsd, usdTimestamp: rate.timestamp, usdSource: rate.source, tokenDecimals: decimals,
        quoteReserve: qr.toString(), tokenReserve: tr.toString(), realQuoteReserve: real.toString(),
        feeBps: Number(fee), creatorTaxBps: Number(tax), snipeTaxBps: Number(snipe), currentSnipeTaxBps: Number(rawSnipe), progressBps: market.progressBps,
        amountIn: amountIn.toString(), amountOut: amountOut.toString(), quoteAsset: "ETH", feeWei: feeWei.toString(),
        creatorTaxWei: creatorTaxWei.toString(), snipeTaxWei: snipeTaxWei.toString(), modelSource: "https://docs.ponsfamily.com/v2#getting-a-quote" }
    };
    const problem = quoteProblem(quote, clock(), config.QUOTE_MAX_AGE_MS, config.ETH_USD_MAX_AGE_MS);
    return problem ? unavailable(problem) : { status: "AVAILABLE", quote };
  } catch (error) {
    return unavailable(classifyQuoteError(error), [error instanceof Error ? error.message.slice(0, 160) : "Quote read failed"]);
  }
}

const launchHeaders = new WeakMap<RpcCaller, Map<number, { value?: { launchTimestamp: string; launchBlockHash: string }; pending?: Promise<void> }>>();

/** Every attempt retains the actual read-only inputs and responses, including failed reads. */
export async function readPaperQuote(
  rpc: RpcCaller, usd: UsdRateProvider, launch: LiveLaunchDecision,
  order: { side: "BUY"; sizeUsd: number } | { side: "SELL"; tokenUnits: string; quantity: number; tokenDecimals?: number },
  clock = Date.now, config: PaperConfig = PAPER_CONFIG
): Promise<QuoteResult> {
  const diagnostics: QuoteDiagnostics = { attemptedAt: new Date(clock()).toISOString(), input: { ...order }, rpc: [] };
  const traced: RpcCaller = async (method, params = []) => {
    const item: QuoteDiagnostics["rpc"][number] = { method, params }; diagnostics.rpc.push(item);
    try { const response = await rpc(method, params); item.response = response; return response; }
    catch (error) { item.error = error instanceof Error ? error.message : String(error); throw error; }
  };
  const rate = async () => {
    try { const value = await usd(); diagnostics.ethUsd = { status: "AVAILABLE", ...value }; return value; }
    catch (error) { diagnostics.ethUsd = { status: error instanceof Error ? error.message : "UNAVAILABLE" }; throw error; }
  };
  // Launch age comes only from a validated header at the event's launch block.
  let launchInfo: { value?: { launchTimestamp: string; launchBlockHash: string }; pending?: Promise<void> } | undefined;
  if (order.side === "SELL") {
    let cache = launchHeaders.get(rpc);
    if (!cache) { cache = new Map(); launchHeaders.set(rpc, cache); }
    if (cache.size >= 512 && !cache.has(launch.blockNumber)) cache.delete(cache.keys().next().value!);
    launchInfo = cache.get(launch.blockNumber);
    if (!launchInfo) { launchInfo = {}; cache.set(launch.blockNumber, launchInfo); }
    const info = launchInfo;
    if (!info.value && !info.pending) info.pending = (async () => {
      try {
        const block = `0x${launch.blockNumber.toString(16)}`;
        const h = header(await traced("eth_getBlockByNumber", [block, false]), block);
        const time = Number(BigInt(h.timestamp)) * 1000;
        if (time <= clock() && time > 0) info.value = { launchTimestamp: new Date(time).toISOString(), launchBlockHash: h.hash };
      } catch { /* Unknown launch age is retried, never inferred from entry. */ }
      finally { delete info.pending; }
    })();
  }
  const result = await calculatePaperQuote(traced, rate, launch, order, clock, config, diagnostics);
  // Historical age lookup must never delay an executable quote. Publish it once verified.
  if (launchInfo?.value) Object.assign(diagnostics, launchInfo.value);
  diagnostics.completedAt = new Date(clock()).toISOString();
  if (result.status !== "AVAILABLE") diagnostics.failure = result.reason;
  if (order.side === "BUY" && result.status === "AVAILABLE") {
    const buy = result.quote;
    const sell = await readPaperQuote(rpc, usd, launch, { side: "SELL", tokenUnits: buy.tokenUnits!, quantity: buy.quantity, tokenDecimals: buy.evidence!.tokenDecimals }, clock, config);
    if (sell.status !== "AVAILABLE") return { ...sell, details: [...sell.details, "Pre-entry full-quantity SELL validation failed"], diagnostics: { ...diagnostics, failure: sell.reason, roundTripSell: sell } };
    const problem = quoteProblem(buy, clock(), config.QUOTE_MAX_AGE_MS, config.ETH_USD_MAX_AGE_MS);
    if (problem) return { ...unavailable(problem), diagnostics };
    buy.roundTrip = { sell: sell.quote, entryUsd: buy.notionalUsd, immediateExitUsd: sell.quote.notionalUsd,
      lossUsd: buy.notionalUsd - sell.quote.notionalUsd, lossPercent: (1 - sell.quote.notionalUsd / buy.notionalUsd) * 100,
      knownFeesUsd: [buy, sell.quote].reduce((sum, q) => sum + Number(formatUnits(BigInt(q.evidence!.feeWei), 18)) * q.evidence!.ethUsd, 0),
      knownTaxesUsd: [buy, sell.quote].reduce((sum, q) => sum + Number(formatUnits(BigInt(q.evidence!.creatorTaxWei) + BigInt(q.evidence!.snipeTaxWei), 18)) * q.evidence!.ethUsd, 0) };
    diagnostics.roundTripSell = sell;
  }
  return { ...result, diagnostics: structuredClone(diagnostics) };
}

const defaultUsd = createEthUsdProvider();
export function readPaperEntryQuote(rpc: RpcCaller, launch: LiveLaunchDecision, sizeUsd: number, usd = defaultUsd): Promise<QuoteResult> {
  return readPaperQuote(rpc, usd, launch, { side: "BUY", sizeUsd });
}
export async function readPaperExitQuote(rpc: RpcCaller, position: Position, usd = defaultUsd, clock = Date.now, config: PaperConfig = PAPER_CONFIG): Promise<QuoteResult> {
  const launch = position.candidate.launch;
  if (!launch) return unavailable("MISSING_LAUNCH_PROVENANCE");
  if (!position.entry.tokenUnits) return unavailable("MISSING_EXACT_TOKEN_UNITS");
  const order = { side: "SELL" as const, tokenUnits: position.entry.tokenUnits, quantity: position.quantity,
    ...(position.entry.evidence ? { tokenDecimals: position.entry.evidence.tokenDecimals } : {}) };
  const original = position.executionRoute?.market === "UNISWAP_V4" ? undefined : await readPaperQuote(rpc, usd, launch, order, clock, config);
  if (original?.status === "AVAILABLE") return original;
  const diagnostics: QuoteDiagnostics = { attemptedAt: new Date(clock()).toISOString(), input: order, rpc: [] };
  const traced: RpcCaller = async (method, params = []) => {
    const item: QuoteDiagnostics["rpc"][number] = { method, params }; diagnostics.rpc.push(item);
    try { return item.response = await rpc(method, params); }
    catch (error) { item.error = String(error); throw error; }
  };
  const migrated = await readV4SellQuote(traced, usd, launch, order, clock, config);
  diagnostics.completedAt = new Date(clock()).toISOString();
  if (migrated.status === "AVAILABLE") {
    diagnostics.currentBlock = migrated.quote.blockNumber; diagnostics.blockTimestamp = migrated.quote.blockTimestamp;
    return { ...migrated, diagnostics };
  }
  diagnostics.failure = migrated.reason;
  // Keep the original failure classification and its reserve evidence, with discovery failures attached.
  return original ? { ...original, details: [...original.details, ...migrated.details], diagnostics: { ...original.diagnostics!, migration: diagnostics } } : { ...migrated, diagnostics };
}

/** Owns source health for the UI; success is never inferred from research availability. */
export class PaperQuoteService {
  private readonly pendingQuotes = new Map<string, Promise<QuoteResult>>();
  private readonly tokenTails = new Map<string, Promise<void>>();
  private readonly entryLane = new WorkLimiter(1,32);
  private readonly exitLane = new WorkLimiter(2,32);
  private async limited(key: string, work: () => Promise<QuoteResult>): Promise<QuoteResult> {
    const pending = this.pendingQuotes.get(key);
    if (pending) return pending;
    if(this.pendingQuotes.size>=runtimeLimits.pendingRpc) return {status:"NOT_PAPER_TRADABLE",reason:"RPC_BACKPRESSURE",details:["Bounded quote admission"]};
    const token = key.split(":")[1]!;
    const prior = this.tokenTails.get(token);
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tokenTails.set(token, tail);
    const job = (async () => {
      if (prior) await prior;
      const exit=key.startsWith("SELL");
      return (exit?this.exitLane:this.entryLane).run(()=>withRpcPriority(exit?0:2,work),exit?0:2);
    })().finally(() => {
      this.pendingQuotes.delete(key); release();
      if (this.tokenTails.get(token) === tail) this.tokenTails.delete(token);
    });
    this.pendingQuotes.set(key, job);
    return job;
  }
  private lastUsd: UsdRate | null = null;
  private usdError: string | null = null;
  private lastQuote: PaperQuote | null = null;
  private lastAttempt: { timestamp: string; reason: string | null } | null = null;
  private readonly usd: UsdRateProvider;
  private readonly gas: PaperGasCounter;
  constructor(private readonly rpc: RpcCaller, private readonly config: PaperConfig, fetcher: typeof fetch = fetch, private readonly clock = Date.now) {
    this.gas = new PaperGasCounter(rpc, fetcher, clock);
    const source = createEthUsdProvider(fetcher, clock, config.ETH_USD_MAX_AGE_MS);
    this.usd = async () => {
      try { const rate = await source(); this.lastUsd = rate; this.usdError = null; return rate; }
      catch (error) { this.usdError = error instanceof QuoteDataError ? error.reason : "ETH_USD_UNAVAILABLE"; throw error; }
    };
  }
  async refreshUsd(): Promise<void> { try { await Promise.all([this.usd(), this.gas.refresh()]); } catch { /* Status captures failure; positions retain their marks. */ } }
  private record(result: QuoteResult): QuoteResult {
    this.lastAttempt = { timestamp: new Date(this.clock()).toISOString(), reason: result.status === "AVAILABLE" ? null : result.reason };
    if (result.status === "AVAILABLE") { this.gas.apply(result.quote); this.lastQuote = result.quote; }
    return result;
  }
  async buy(launch: LiveLaunchDecision, sizeUsd: number): Promise<QuoteResult> {
    return this.limited(`BUY:${launch.token}:${sizeUsd}`, async () => this.record(await readPaperQuote(this.rpc, this.usd, launch, { side: "BUY", sizeUsd }, this.clock, this.config)));
  }
  async sell(position: Position): Promise<QuoteResult> {
    if (!position.candidate.launch || !position.entry.tokenUnits) return this.record(unavailable("MISSING_EXACT_TOKEN_UNITS"));
    return this.limited(`SELL:${position.tokenAddress}:${position.entry.tokenUnits}`, async () =>
      this.record(await readPaperExitQuote(this.rpc, position, this.usd, this.clock, this.config)));
  }
  status() {
    const usdStatus = this.usdError ?? (!this.lastUsd ? "ETH_USD_UNAVAILABLE" : fresh(this.lastUsd.timestamp, this.clock(), this.config.ETH_USD_MAX_AGE_MS) ? "LIVE" : "ETH_USD_STALE");
    const quoteFresh = this.lastQuote && !quoteProblem(this.lastQuote, this.clock(), this.config.QUOTE_MAX_AGE_MS, this.config.ETH_USD_MAX_AGE_MS);
    return { pendingRequests: this.pendingQuotes.size, lanes:{entry:this.entryLane.status(),exit:this.exitLane.status()}, status: quoteFresh && usdStatus === "LIVE" && this.lastAttempt?.reason === null ? "LIVE" : "DEGRADED",
      gas: this.gas.status(usdStatus === "LIVE" ? this.lastUsd?.ask ?? null : null),
      quoteSource: this.lastQuote?.source ?? "Pons curve / awaiting verified quote", lastAttempt: this.lastAttempt,
      lastQuoteTimestamp: this.lastQuote?.timestamp ?? null,
      ethUsd: { status: usdStatus, bid: this.lastUsd?.bid ?? null, ask: this.lastUsd?.ask ?? null,
        ageMs: this.lastUsd ? this.clock() - Date.parse(this.lastUsd.timestamp) : null, timestamp: this.lastUsd?.timestamp ?? null, source: this.lastUsd?.source ?? USD_URL } };
  }
}

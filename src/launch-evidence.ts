import type { LiveLaunch, RpcCaller } from "./live.js";
import type { PonsMarketState } from "./market.js";

export interface LaunchEvidence {
  launchBlock: number; launchTimestamp: number | null;
  sourceEventId?: string; eventOccurredAtMs?: number | null; firstObservedAtMs?: number | null;
  eventAgeAtFirstObservationSeconds?: number | null; classificationReason?: string;
  source?: string; discoveredAtMs?: number | null; normalizedAtMs?: number | null; ingestedAtMs?: number | null;
  currentBlock: number | null; currentTimestamp: number | null; tokenAgeSeconds: number | null;
  firstBlockSeenByProcess: number | null; eventMode: "LIVE" | "BACKFILL";
  launchBlockHash: string | null; currentBlockHash: string | null;
  recentTraction: { status: "VERIFIED" | "WEAK" | "UNKNOWN"; fromBlock?: number; toBlock?: number;
    fromTimestamp?: number; toTimestamp?: number; progressChangeBps?: number; reserveChangeWei?: string;
    creatorTaxChangeBps?: number; snipeTaxChangeBps?: number; lastVerifiedActivityTime: null;
    explanation: string };
}
interface Observation { launchBlock: number; eventMode: "LIVE" | "BACKFILL"; first: number; firstObservedAtMs: number; classificationReason: string; market: PonsMarketState; block: number; timestamp: number | null }
interface Session { head: number; observations: Map<string, Observation>; headers: Map<number, NonNullable<Awaited<ReturnType<typeof readHeader>>>> }
const sessions = new WeakMap<RpcCaller, Session>();
export const RECENT_TRACTION_WINDOW_SECONDS = 300;
export function normalizeTimestampMs(value: unknown): number | null {
  let numeric: number;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) numeric = Number.parseInt(value.slice(2), 16);
  else if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) numeric = Number(value);
  else if (typeof value === "string") numeric = Date.parse(value);
  else return null;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  return Number.isSafeInteger(milliseconds) && milliseconds <= 8.64e15 ? milliseconds : null;
}
export async function readHeader(rpc: RpcCaller, block: number): Promise<{ timestamp: number; timestampMs: number; hash: string } | null> {
  try {
    const h = await rpc("eth_getBlockByNumber", [`0x${block.toString(16)}`, false]) as Record<string, unknown>;
    if (!h || typeof h.number !== "string" || !/^0x[0-9a-f]+$/i.test(h.number) || Number(h.number) !== block ||
        typeof h.timestamp !== "string" || !/^0x[0-9a-f]+$/i.test(h.timestamp) ||
        typeof h.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(h.hash)) return null;
    const timestampMs = normalizeTimestampMs(h.timestamp);
    return timestampMs !== null ? { timestamp: timestampMs / 1000, timestampMs, hash: h.hash } : null;
  } catch { return null; }
}
/** Startup is a chronology boundary, never a synthetic launch time. Replays fail closed. */
  export async function launchEvidence(rpc: RpcCaller, head: number, launches: LiveLaunch[], markets: PonsMarketState[], discoveredAtMs = Date.now(), normalizedAtMs = discoveredAtMs, ingestedAtMs = normalizedAtMs): Promise<LaunchEvidence[]> {
  const previous = sessions.get(rpc);
  const session = previous ?? { head, observations: new Map<string, Observation>(), headers: new Map() };
  const current = await readHeader(rpc, head);
  const headers = new Map<number, Awaited<ReturnType<typeof readHeader>>>();
  await Promise.all([...new Set(launches.map(l => l.blockNumber))].map(async block => {
    const cached = session.headers.get(block);
    // Reuse only when every current source log attests the same immutable block hash.
    const matches = cached && launches.filter(l => l.blockNumber === block)
      .every(l => l.blockHash?.toLowerCase() === cached.hash.toLowerCase());
    const header = block === head ? current : matches ? cached : await readHeader(rpc, block);
    headers.set(block, header);
    if (header) session.headers.set(block, header);
    else session.headers.delete(block);
  }));
  const evidence = launches.map((launch, i): LaunchEvidence => {
    const header = headers.get(launch.blockNumber), old = session.observations.get(launch.token), market = markets[i]!;
    const valid = header && current && launch.blockNumber <= head && header.timestamp <= current.timestamp &&
      (!launch.blockHash || launch.blockHash.toLowerCase() === header.hash.toLowerCase());
    const recentTraction: LaunchEvidence["recentTraction"] = { status: "UNKNOWN", lastVerifiedActivityTime: null,
      explanation: "No comparable recent verified state pair; last activity time is unknown" };
    if (current && old?.timestamp && old.block < head && current.timestamp > old.timestamp &&
        current.timestamp - old.timestamp <= RECENT_TRACTION_WINDOW_SECONDS && old.market.status === "VERIFIED" && market.status === "VERIFIED") {
      const delta = BigInt(market.realQuoteReserve) - BigInt(old.market.realQuoteReserve);
      Object.assign(recentTraction, { status: delta !== 0n || market.progressBps !== old.market.progressBps ? "VERIFIED" : "WEAK",
        fromBlock: old.block, toBlock: head, fromTimestamp: old.timestamp, toTimestamp: current.timestamp,
        progressChangeBps: market.progressBps - old.market.progressBps, reserveChangeWei: delta.toString(),
        creatorTaxChangeBps: market.creatorTaxBps - old.market.creatorTaxBps,
        snipeTaxChangeBps: market.currentSnipeTaxBps - old.market.currentSnipeTaxBps,
        explanation: "Pinned state delta only; direction is not momentum. Unchanged endpoints do not prove inactivity. Exact last activity time unknown." });
    }
    const eventMode = old?.eventMode ?? (previous && launch.blockNumber > previous.head && valid ? "LIVE" : "BACKFILL");
    const classificationReason = old?.classificationReason ?? (!valid ? "SOURCE_EVENT_TIME_OR_BLOCK_UNVERIFIED" : !previous ?
      "INITIAL_SCAN_HAS_NO_PRIOR_CHRONOLOGY_BOUNDARY" : launch.blockNumber <= previous.head ? "EVENT_NOT_AFTER_PREVIOUS_HEAD" : "EVENT_AFTER_PREVIOUS_HEAD");
    const firstObservedAtMs = old?.firstObservedAtMs ?? discoveredAtMs;
    const eventOccurredAtMs = valid ? header.timestampMs : null;
    session.observations.set(launch.token, { launchBlock: launch.blockNumber, eventMode, first: old?.first ?? head, firstObservedAtMs, classificationReason,
      market: structuredClone(market), block: head, timestamp: current?.timestamp ?? null });
    return { launchBlock: launch.blockNumber, launchTimestamp: valid ? header.timestamp : null,
      sourceEventId: `${launch.transactionHash}:${launch.logIndex}`, eventOccurredAtMs, firstObservedAtMs,
      eventAgeAtFirstObservationSeconds: eventOccurredAtMs === null ? null : (firstObservedAtMs - eventOccurredAtMs) / 1000,
      classificationReason, source: "Robinhood Chain RPC eth_getLogs", discoveredAtMs, normalizedAtMs, ingestedAtMs,
      currentBlock: head, currentTimestamp: current?.timestamp ?? null, tokenAgeSeconds: valid ? current.timestamp - header.timestamp : null,
      firstBlockSeenByProcess: old?.first ?? head, eventMode,
      launchBlockHash: valid ? header.hash : null, currentBlockHash: current?.hash ?? null, recentTraction };
  });
  session.head = Math.max(session.head, head);
  for (const [token, observation] of session.observations) if (observation.launchBlock < head - 25_000) session.observations.delete(token);
  for (const block of session.headers.keys()) if (block < head - 25_000) session.headers.delete(block);
  while(session.observations.size>1024) session.observations.delete(session.observations.keys().next().value!);
  while(session.headers.size>512) session.headers.delete(session.headers.keys().next().value!);
  sessions.set(rpc, session);
  return evidence;
}

export function unknownLaunchEvidence(launchBlock: number): LaunchEvidence {
  return { launchBlock, launchTimestamp: null, currentBlock: null, currentTimestamp: null,
    sourceEventId: "UNKNOWN", eventOccurredAtMs: null, firstObservedAtMs: null, eventAgeAtFirstObservationSeconds: null,
    classificationReason: "SOURCE_EVENT_TIME_OR_BLOCK_UNVERIFIED", source: "UNKNOWN", discoveredAtMs: null, normalizedAtMs: null, ingestedAtMs: null,
    tokenAgeSeconds: null, firstBlockSeenByProcess: null, eventMode: "BACKFILL",
    launchBlockHash: null, currentBlockHash: null,
    recentTraction: { status: "UNKNOWN", lastVerifiedActivityTime: null, explanation: "No recorded verified chronology" } };
}

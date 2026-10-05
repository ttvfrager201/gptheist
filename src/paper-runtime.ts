import { createLiveDiscoveryCache, fetchLiveSnapshot, type LiveSnapshot, type RpcCaller } from "./live.js";
import { PaperQuoteService } from "./paper-quotes.js";
import { PaperService } from "./paper-service.js";
import { PaperStore } from "./paper-store.js";

export interface PaperEngineOptions {
  directory: string;
  rpc: RpcCaller;
  discoveryIntervalMs?: number;
  log?: (message: string) => void;
  usdFetch?: typeof fetch;
}

export async function startPaperEngine(options: PaperEngineOptions): Promise<PaperService> {
  let store: PaperStore | undefined;
  try {
    store = await PaperStore.open(options.directory);
    const quotes = new PaperQuoteService(options.rpc, store.read().config, options.usdFetch);
    const discoveryCache = createLiveDiscoveryCache();
    let cached: { at: number; value: LiveSnapshot } | undefined;
    let pending: Promise<LiveSnapshot> | undefined;
    const snapshot = (): Promise<LiveSnapshot> => {
      if (cached && Date.now() - cached.at < (options.discoveryIntervalMs ?? 4000)) return Promise.resolve(cached.value);
      if (!pending) {
        pending = fetchLiveSnapshot(options.rpc, { discoveryCache }).then(value => {
          cached = { at: Date.now(), value };
          return value;
        }).finally(() => { pending = undefined; });
      }
      return pending;
    };
    const engine = new PaperService(store, snapshot, position => quotes.sell(position),
      (launch, sizeUsd) => quotes.buy(launch, sizeUsd), quotes, Date.now, options.rpc,
      { discoveryIntervalMs: options.discoveryIntervalMs, log: options.log });
    engine.start();
    return engine;
  } catch (error) {
    if (store) await store.close();
    try { options.log?.(`PAPER startup error: ${error instanceof Error ? error.message : "Paper storage unavailable"}`); } catch { /* Logging must not change startup failure handling. */ }
    throw error;
  }
}
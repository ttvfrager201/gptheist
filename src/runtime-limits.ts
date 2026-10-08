import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const priorityContext = new AsyncLocalStorage<number>();
export const withRpcPriority = <T>(priority: number, work: () => Promise<T>): Promise<T> => priorityContext.run(priority, work);
export class WorkLimiter {
  private active = 0;
  private nonCritical = 0;
  private queue: { priority: number; start: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  constructor(readonly concurrency = 6, readonly maxPending = 128, readonly waitMs = 15_000, readonly reserved = 0) {}
  status() { return { active: this.active, pending: this.queue.length }; }
  run<T>(work: () => Promise<T>, priority = priorityContext.getStore() ?? 3): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => { this.active++; if(priority>1)this.nonCritical++; void Promise.resolve().then(work).then(resolve,reject).finally(() => {
        this.active--; if(priority>1)this.nonCritical--;
        while(this.active<this.concurrency) {
          const index=this.queue.findIndex(item=>item.priority<=1 || this.nonCritical<this.concurrency-this.reserved);
          if(index<0)break;
          const next=this.queue.splice(index,1)[0]!;clearTimeout(next.timer);next.start();
        }
      }); };
      if (this.active < this.concurrency && (priority<=1 || this.nonCritical<this.concurrency-this.reserved)) { start(); return; }
      if (this.queue.length >= this.maxPending) {
        const worst = this.queue.at(-1)!;
        if (priority >= worst.priority) { reject(new Error('RPC_BACKPRESSURE')); return; }
        this.queue.pop(); clearTimeout(worst.timer); worst.reject(new Error('RPC_BACKPRESSURE'));
      }
      const item = { priority, start, reject, timer: setTimeout(() => {
        const index = this.queue.indexOf(item); if (index >= 0) this.queue.splice(index,1);
        reject(new Error('RPC_QUEUE_TIMEOUT'));
      },this.waitMs) };
      this.queue.push(item); this.queue.sort((a,b)=>a.priority-b.priority);
    });
  }
}
function limit(name:string, fallback:number, minimum:number, maximum:number) {
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<minimum||value>maximum) throw new Error(`Invalid ${name}`);
  return value;
}
export const runtimeLimits = { candidates: limit('PAPER_MAX_CANDIDATES',128,24,512), observations:limit('PAPER_MAX_OBSERVATIONS',100,10,100),
  rejections:limit('PAPER_MAX_REJECTIONS',100,25,200), quoteSamples:limit('PAPER_MAX_QUOTE_SAMPLES',128,10,256),
  rpcConcurrency:limit('PAPER_RPC_CONCURRENCY',6,2,16), pendingRpc:limit('PAPER_MAX_PENDING_RPC',128,16,256) };
const rpcLimiters=new WeakMap<Function,WorkLimiter>();
export function registerRpcLimiter(caller:Function,limiter:WorkLimiter) { rpcLimiters.set(caller,limiter); }
export function rpcWorkStatus(caller:Function|undefined) { return caller ? rpcLimiters.get(caller)?.status()??null : null; }
export class MemoryHealth {
  private delay = monitorEventLoopDelay({ resolution: 20 });
  constructor() { this.delay.enable(); }
  sample() {
    const m = process.memoryUsage();
    const pressure = m.rss >= 850*1048576 ? 'CRITICAL' : m.rss >= 700*1048576 ? 'WARNING' : 'NORMAL';
    const eventLoopDelayMs = Number.isFinite(this.delay.mean) ? this.delay.mean/1e6 : 0;
    this.delay.reset(); return { ...m, pressure, eventLoopDelayMs };
  }
  close() { this.delay.disable(); }
}

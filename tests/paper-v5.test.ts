import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './paper-fixtures.js';
import { seedEntryQuality, seedLiquidityHistory } from './liquidity-history-fixture.js';
import { initialPaperState, liveCandidate, enterPaper, markPaperPosition, PAPER_CONFIG, activity, accountSummary } from '../src/paper.js';
import { LiquiditySurvivalGate, AdaptiveProfitExit } from '../src/paper-v5.js';
import { getPaperStrategy } from '../src/paper-strategy.js';
import { WorkLimiter } from '../src/runtime-limits.js';
import { retainPaperState } from '../src/paper-retention.js';
import { PaperStore } from '../src/paper-store.js';
async function setup() {
  const f=fixture(); f.state.fee=0n; f.launch.market.status==='VERIFIED' && (f.launch.market.creatorTaxBps=0);
  const result=await f.buy(1); assert.equal(result.status,'AVAILABLE'); if(result.status!=='AVAILABLE') throw Error();
  const q=result.quote; q.costs.gasUsd=0; q.roundTrip!.sell.costs.gasUsd=0;
  const state=initialPaperState(f.time,{...PAPER_CONFIG,PAPER_STRATEGY_VERSION:5});
  const c=liveCandidate(f.launch); c.quote=result; seedLiquidityHistory(state,c,q); seedEntryQuality(state,c,q);
  state.config.MIN_EXIT_COVERAGE_RATIO=100;state.config.MAX_EXIT_PARTICIPATION_BPS=100;
  return {f,q,c,state};
}
test('one selectable V5, default STRICT and unchanged V4 fixed profit target',()=>{
  assert.equal(PAPER_CONFIG.PAPER_STRATEGY_VERSION,3);assert.equal(getPaperStrategy({PAPER_STRATEGY_VERSION:5}).version,5);
  assert.equal(getPaperStrategy({PAPER_STRATEGY_VERSION:4}).maxHoldMs,90000);
});
test('V5 verified entry, reversal and missing quote evidence',async()=>{
  const {f,c,q,state}=await setup();
  assert.equal(LiquiditySurvivalGate(c,q,state,f.time).result,'V5_ENTRY_APPROVED');
  const rows=c.tractionDiagnostics!.observations;rows.at(-1)!.reserve=String(BigInt(rows.at(-2)!.reserve!)*9n/10n);
  assert.equal(LiquiditySurvivalGate(c,q,state,f.time).result,'V5_ENTRY_REJECTED');
  delete q.roundTrip;assert.ok(LiquiditySurvivalGate(c,q,state,f.time).reasons.includes('SELL_QUOTE_UNAVAILABLE'));
});
test('V5 strong winner continues, weak trail exits, gap and maximum hold predicates',async()=>{
  const {f,c,state}=await setup();assert.equal(enterPaper(state,c,1,f.time).outcome,'PAPER_BUY');
  const p=state.positions[0]!,q=structuredClone(p.current);q.notionalUsd=p.costBasisUsd*1.12;
  p.current=q;p.management.peakLiquidationValueUsd=q.notionalUsd;p.management.peakReturnPercent=12;
  assert.equal(AdaptiveProfitExit(p,f.time+1000),null);
  p.current.notionalUsd=p.costBasisUsd*1.08;
  assert.equal(AdaptiveProfitExit(p,f.time+2000)?.reason,'ADAPTIVE_PROFIT_EXIT');
  p.current.notionalUsd=p.costBasisUsd*.4;assert.equal(AdaptiveProfitExit(p,f.time+3000)?.reason,'DYNAMIC_RISK_EXIT');
  p.current.notionalUsd=p.costBasisUsd*1.12;assert.equal(AdaptiveProfitExit(p,f.time+180001)?.reason,'MAX_HOLD_EXIT');
});
test('V5 high coverage cannot mask reserve emergency; missing sell never fabricates fill',async()=>{
  const {f,c,state}=await setup();assert.equal(enterPaper(state,c,1,f.time).outcome,'PAPER_BUY');
  const p=state.positions[0]!,q=structuredClone(p.current);
  q.evidence!.realQuoteReserve=String(BigInt(q.evidence!.realQuoteReserve)*88n/100n);
  q.blockNumber++;q.timestamp=new Date(f.time+1000).toISOString();q.blockTimestamp=q.timestamp;
  assert.equal(markPaperPosition(state,p.id,{status:'AVAILABLE',quote:q},f.time+1000),true);
  assert.ok(p.management.pendingExit?.reason==='RESERVE_DRAWDOWN' || p.management.pendingExit?.reason==='MULTIPLE_TRIGGERS');
  const cash=state.cash;markPaperPosition(state,p.id,{status:'NOT_PAPER_TRADABLE',reason:'RPC_TIMEOUT',details:[]},f.time+2000);
  assert.equal(state.cash,cash);assert.equal(state.positions.length,1);
});
test('rejection aggregation bounded retention and position protection',async()=>{
  const {f,c,state}=await setup();enterPaper(state,c,1,f.time);
  for(let i=0;i<10000;i++) activity(state,'PAPER_REJECT','STALE_LAUNCH',f.time+i,c);
  assert.equal(state.events.filter(e=>e.eventType==='PAPER_REJECT').length,1);
  assert.equal(state.events.at(-1)!.metadata.occurrences,10000);
  const before=structuredClone(state.positions);retainPaperState(state,f.time+1e9);assert.deepEqual(state.positions,before);
});
test('bounded concurrent work, queue timeout and priority',async()=>{
  const limiter=new WorkLimiter(1,2,20);let release!:()=>void;
  const first=limiter.run(()=>new Promise<void>(r=>{release=r;}));await new Promise(r=>setImmediate(r));
  const order:number[]=[];
  const low=limiter.run(async()=>{order.push(3);},3);
  const high=limiter.run(async()=>{order.push(0);},0);
  await assert.rejects(limiter.run(async()=>{},4),/BACKPRESSURE/);release();await Promise.all([first,low,high]);assert.deepEqual(order,[0,3]);
  const stuck=limiter.run(()=>new Promise<void>(r=>{release=r;}));await new Promise(r=>setImmediate(r));
  await assert.rejects(limiter.run(async()=>{}),/QUEUE_TIMEOUT/);release();await stuck;
});
test('V5 durable restart, authenticated-export records, writer ownership and corruption',async()=>{
  const {f,c,state}=await setup();enterPaper(state,c,1,f.time);
  const directory=await mkdtemp(join(tmpdir(),'v5-durable-'));let store=await PaperStore.open(directory,()=>f.time);
  try {
    await store.update(s=>{Object.assign(s,state);});await assert.rejects(PaperStore.open(directory),/owned/);
    const before=accountSummary(store.read()),records=[];for await(const row of store.exportRecords())records.push(row);
    assert.equal(records[0]!.name,'state.json');await store.close();store=await PaperStore.open(directory,()=>f.time);
    assert.deepEqual(accountSummary(store.read()),before);assert.equal(store.read().positions.length,1);
    await store.close();await writeFile(join(directory,'state.json'),'broken');await assert.rejects(PaperStore.open(directory));
  } finally {await store.close();await rm(directory,{recursive:true,force:true});}
});
test('memory pressure sheds optional candidates and preserves active position state',async()=>{
  const {PaperService}=await import('../src/paper-service.js');
  const {f,c,state}=await setup();enterPaper(state,c,1,f.time);
  const directory=await mkdtemp(join(tmpdir(),'v5-pressure-')),store=await PaperStore.open(directory,()=>f.time);
  await store.update(s=>{Object.assign(s,state);s.tractionWatchlist={optional:structuredClone(f.launch)};});
  const service=new PaperService(store,async()=>f.snapshot,async()=>({status:'NOT_PAPER_TRADABLE',reason:'TEST',details:[]}));
  const internal=service as unknown as {memoryHealth:{sample:()=>{rss:number;pressure:string}},reportMemory:()=>Promise<void>};
  const original=internal.memoryHealth.sample;
  try {
    const before=structuredClone(store.read().positions);
    internal.memoryHealth.sample=()=>({rss:900*1048576,pressure:'CRITICAL'});
    await internal.reportMemory();assert.deepEqual(store.read().positions,before);assert.equal(Object.keys(store.read().tractionWatchlist??{}).length,0);
  } finally {internal.memoryHealth.sample=original;await service.close();await rm(directory,{recursive:true,force:true});}
});
test('explicit new account initialization refuses missing data instead of resetting',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'v5-init-')),previous=process.env.PAPER_REQUIRE_EXPLICIT_INIT;
  try { process.env.PAPER_REQUIRE_EXPLICIT_INIT='true';await assert.rejects(PaperStore.open(directory),/refusing silent reset/); }
  finally { if(previous===undefined)delete process.env.PAPER_REQUIRE_EXPLICIT_INIT;else process.env.PAPER_REQUIRE_EXPLICIT_INIT=previous;await rm(directory,{recursive:true,force:true}); }
});
test('reserved RPC slots let active exits start despite saturated discovery',async()=>{
  const limiter=new WorkLimiter(3,8,1000,1);let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});const low=[limiter.run(()=>wait,3),limiter.run(()=>wait,3)];
  await new Promise(r=>setImmediate(r));const queued=limiter.run(async()=>{},3);
  assert.equal(limiter.status().pending,1);let exited=false;await limiter.run(async()=>{exited=true;},0);
  assert.equal(exited,true);release();await Promise.all([...low,queued]);
});
test('authenticated export refuses anonymous requests and streams account records',async()=>{
  const {startDeskServer,stopDeskServer}=await import('../src/server.js');
  const f=fixture(),directory=await mkdtemp(join(tmpdir(),'v5-export-')),previous=process.env.PAPER_EXPORT_TOKEN;
  process.env.PAPER_EXPORT_TOKEN='test-only-export-token';
  const server=await startDeskServer({host:'127.0.0.1',port:0,paperDirectory:directory,rpc:f.rpc});
  try {
    const address=server.address();if(!address||typeof address==='string')throw Error();
    const url=`http://127.0.0.1:${address.port}/api/paper/export`;
    assert.equal((await fetch(url)).status,403);
    const result=await fetch(url,{headers:{authorization:'Bearer test-only-export-token'}});assert.equal(result.status,200);
    const records=(await result.text()).trim().split('\n').map(line=>JSON.parse(line));assert.equal(records[0].name,'state.json');
  } finally {await stopDeskServer(server);if(previous===undefined)delete process.env.PAPER_EXPORT_TOKEN;else process.env.PAPER_EXPORT_TOKEN=previous;await rm(directory,{recursive:true,force:true});}
});
test('forward research recording bounds disk bytes and records gaps without touching trades',async()=>{
  const {ForwardRecorder}=await import('../src/paper-forward.js');
  const {readdir,stat}=await import('node:fs/promises');
  const f=fixture(),directory=await mkdtemp(join(tmpdir(),'v5-forward-')),recorder=new ForwardRecorder(directory,20000,1000);
  try {
    for(let i=0;i<30;i++)await recorder.record({sequence:i,completedAt:new Date(f.time+i*3600000).toISOString(),snapshot:f.snapshot,buys:[],sells:[]});
    await recorder.close();const files=await readdir(directory);let bytes=0;for(const name of files)bytes+=(await stat(join(directory,name))).size;
    assert.ok(bytes<=20000);assert.equal(files.length,1);assert.equal(recorder.status().written,30);
  }finally{await rm(directory,{recursive:true,force:true});}
});

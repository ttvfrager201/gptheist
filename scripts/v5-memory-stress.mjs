// Synthetic infrastructure load only. Never use these observations for profitability.
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from '../dist/tests/paper-fixtures.js';
import {seedLiquidityHistory,seedEntryQuality} from '../dist/tests/liquidity-history-fixture.js';
import {initialPaperState,liveCandidate,enterPaper,markPaperPosition,activity,accountSummary} from '../dist/src/paper.js';
import {retainPaperState,collectionCounts} from '../dist/src/paper-retention.js';
import {WorkLimiter,MemoryHealth,runtimeLimits} from '../dist/src/runtime-limits.js';
import {PaperStore} from '../dist/src/paper-store.js';
const seconds=Number(process.env.STRESS_SECONDS??60),output=process.argv[2]??'reports/v5-memory-stress.json';
const f=fixture(),state=initialPaperState(f.time),q=await f.buy(1);
if(q.status!=='AVAILABLE')throw Error('fixture');
const base=liveCandidate(f.launch);base.quote=q;
for(let i=0;i<5;i++){
 const c=structuredClone(base),address=`0x${(i+10).toString(16).padStart(40,'0')}`;
 c.tokenAddress=address;c.launchId=`stress-position-${i}`;
 for(const quote of [c.quote.quote,c.quote.quote.roundTrip.sell])quote.tokenAddress=address;
 seedLiquidityHistory(state,c,c.quote.quote);seedEntryQuality(state,c,c.quote.quote);
 if(enterPaper(state,c,1,f.time).outcome!=='PAPER_BUY')throw Error('Synthetic position admission');
}
// Populate the resident historical page as well as active positions.
state.trades=Array.from({length:100},(_,i)=>{
 const p=structuredClone(state.positions[i%5]),exit=structuredClone(p.current),pnlUsd=exit.notionalUsd-(exit.costs.gasUsd??0)-p.costBasisUsd;
 return {...p,id:`stress-closed-${i}`,launchId:`stress-closed-launch-${i}`,exit,exitedAt:new Date(f.time).toISOString(),pnlUsd,returnPercent:pnlUsd/p.costBasisUsd*100,exitReason:'MAX_HOLD_EXIT',exitReasoning:['Synthetic infrastructure history only']};
});
state.cash+=state.trades.reduce((n,t)=>n+t.pnlUsd,0);
const directory=await mkdtemp(join(tmpdir(),'v5-stress-'));let store=await PaperStore.open(directory,()=>f.time);
const limiter=new WorkLimiter(6,32,10),health=new MemoryHealth(),samples=[];
let cycles=0,launches=0,failures=0,restarts=0,peakPending=0,peakCandidates=0;
const start=Date.now(),initial=process.memoryUsage();
try{
 while(Date.now()-start<seconds*1000){
  for(let j=0;j<20;j++){
   const now=f.time+cycles*4000;
   for(let k=0;k<12;k++){
    const id=`candidate-${launches++}`,c=structuredClone(base);
    state.tractionWatchlist??={};state.researchLedger??={};state.tractionHistory??={};
    state.tractionWatchlist[id]=structuredClone(f.launch);
    state.tractionWatchlist[id].chronology.launchTimestamp=now/1000;
    state.researchLedger[id]={firstObservedAt:new Date(now).toISOString(),lastObservedAt:new Date(now).toISOString(),observations:1,lastResult:'OBSERVING',traded:false,eventMode:'LIVE',sourceEventTimestampMs:now};
    state.tractionHistory[id]=Array.from({length:150},()=>({timestamp:new Date(now).toISOString(),reserve:'100',token:c.tokenAddress,verificationStatus:'VERIFIED'}));
    for(let n=0;n<10;n++)activity(state,'PAPER_REJECT','STALE_LAUNCH',now,c);
   }
   for(const p of state.positions){
    const quote=structuredClone(p.current),stamp=new Date(now).toISOString();quote.timestamp=stamp;quote.blockTimestamp=stamp;quote.blockNumber=cycles+100;
    quote.evidence.usdTimestamp=stamp;markPaperPosition(state,p.id,{status:'AVAILABLE',quote},now);
   }
   retainPaperState(state,now);peakCandidates=Math.max(peakCandidates,collectionCounts(state).activeCandidates);cycles++;
  }
  const jobs=Array.from({length:48},(_,i)=>limiter.run(async()=>{await delay(1);if(i%7===0){failures++;throw Error('SYNTHETIC_NETWORK_FAILURE');}},i%4));
  peakPending=Math.max(peakPending,limiter.status().pending); await Promise.allSettled(jobs);
  peakPending=Math.max(peakPending,limiter.status().pending);
  await store.update(s=>{Object.assign(s,structuredClone(state));});
  for(let i=0;i<20;i++)JSON.stringify(store.read()); // bounded dashboard request serialization
  if(cycles%400===0){const before=accountSummary(store.read());await store.close();store=await PaperStore.open(directory,()=>f.time+cycles*4000);if(JSON.stringify(accountSummary(store.read()))!==JSON.stringify(before))throw Error('Recovery mismatch');restarts++;}
  samples.push({...health.sample(),elapsedMs:Date.now()-start,counts:collectionCounts(state)});
  if(state.positions.length!==5)throw Error('Lost active exit state');
 }
 const rss=samples.map(s=>s.rss),last=samples.slice(-Math.max(1,Math.floor(samples.length/3)));
 const report={syntheticInfrastructureOnly:true,containerLimitEnforced:false,cgroupMemoryMax:await readFile('/sys/fs/cgroup/memory.max','utf8').catch(()=> 'unavailable'),nodeHeapLimitMiB:384,durationMs:Date.now()-start,cycles,launches,networkFailures:failures,restarts,initial,peakRss:Math.max(...rss),sustainedRss:last.reduce((n,s)=>n+s.rss,0)/last.length,final:samples.at(-1),peakPending,peakCandidates,limits:runtimeLimits,samples:samples.filter((_,i)=>i%10===0),acceptance:{rssBelow500MiB:Math.max(...rss)<500*1048576,sustainedBelow650MiB:last.every(s=>s.rss<650*1048576),activePositionsPreserved:state.positions.length===5,queueDrained:limiter.status().pending===0}};
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,samples:undefined},null,2));
}finally{health.close();await store.close();await rm(directory,{recursive:true,force:true});}

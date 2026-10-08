// Exact two-strategy replay of chronological JSONL PaperMarketFrames. Offline only.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {initialPaperState,PAPER_CONFIG,monitorPaper,observeSnapshot,performance} from '../dist/src/paper.js';
import {retainPaperState} from '../dist/src/paper-retention.js';
const [input,output='reports/v5-replay.json']=process.argv.slice(2);
if(!input)throw Error('Supply chronological JSONL market frames, not a closed-trade summary');
if(resolve(input)===resolve(output)||resolve(output).includes('/runs/paper/'))throw Error('Output must be separate from account/evidence');
const portfolios={},missing={SCALP:{buys:0,sells:0},V5:{buys:0,sells:0}};let frames=0,recordingSkippedFrames=0,last=-Infinity;
for await(const line of createInterface({input:createReadStream(input),crlfDelay:Infinity})){
 if(!line.trim())continue;const frame=JSON.parse(line); recordingSkippedFrames=Math.max(recordingSkippedFrames,frame.recordingSkippedFrames??0);const now=Date.parse(frame.completedAt);
 if(!Number.isFinite(now)||now<=last||Date.parse(frame.snapshot.fetchedAt)>now)throw Error('NON_CHRONOLOGICAL_FRAME');last=now;
 for(const item of [...frame.buys,...frame.sells])if(item.result.status==='AVAILABLE'){
  const q=item.result.quote;if([q.timestamp,q.blockTimestamp,q.roundTrip?.sell.timestamp].filter(Boolean).some(t=>Date.parse(t)>now))throw Error('FUTURE_QUOTE');
 }
 for(const [name,version] of [['SCALP',4],['V5',5]]){
  const state=portfolios[name]??=initialPaperState(now,{...PAPER_CONFIG,PAPER_STRATEGY_VERSION:version,STARTING_BALANCE_USD:Number(process.env.REPLAY_STARTING_EQUITY??50)});
  const sells=structuredClone(frame.sells),buys=structuredClone(frame.buys);
  const unavailable=(side)=>{missing[name][side]++;return {status:'NOT_PAPER_TRADABLE',reason:'REPLAY_EXACT_QUOTE_MISSING',details:['No price or fill inferred']};};
  await monitorPaper(state,async p=>{
   const index=sells.findIndex(q=>q.token.toLowerCase()===p.tokenAddress.toLowerCase()&&q.tokenUnits===p.entry.tokenUnits);
   return index<0?unavailable('sells'):sells.splice(index,1)[0].result;
  },()=>now);
  await observeSnapshot(state,structuredClone(frame.snapshot),now,async(launch,size)=>{
   const index=buys.findIndex(q=>q.token.toLowerCase()===launch.token.toLowerCase()&&Math.abs(q.sizeUsd-size)<1e-8);
   return index<0?unavailable('buys'):buys.splice(index,1)[0].result;
  },()=>now);
  retainPaperState(state,now);
 }
 frames++;
}
const results=Object.fromEntries(Object.entries(portfolios).map(([name,state])=>[name,{...performance(state),openPositions:state.positions.length,missing:missing[name],incomplete:state.positions.length>0||missing[name].buys>0||missing[name].sells>0}]));
const report={frames,recordingSkippedFrames,incomplete:recordingSkippedFrames>0||Object.values(results).some(r=>r.incomplete),method:'Chronological frame-resolution replay; independent account cash/concurrency, saved position versions, exact sizes and two fresh SELL reads. No interpolation. Missing alternative sizes and post-exit quotes invalidate profitability comparison.',results,profitableClaim:false};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

"use strict";
const $ = id => document.getElementById(id);
const money = n => Number.isFinite(n) ? `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}` : "N/A";
const pct = n => Number.isFinite(n) ? `${n.toFixed(2)}%` : "N/A";
const price = n => Number.isFinite(n) ? `$${n.toLocaleString("en-US",{maximumSignificantDigits:7})}` : "N/A";
const duration = ms => { const seconds=Math.max(0,Math.floor(ms/1000));return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,"0")).join(":"); };
const node = (tag,text,cls) => { const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e; };
const tone = (element,value) => { element.classList.toggle("negative",value<0);element.classList.toggle("positive",value>0); };
const reducedMotion=window.matchMedia("(prefers-reduced-motion: reduce)");
const counterValues=new WeakMap(),counterFrames=new WeakMap();
function animateMoney(id,value,prefix=""){
 const element=$(id),previous=counterValues.get(element);counterValues.set(element,value);
 if(previous===value&&element.dataset.prefix===prefix)return;
 element.dataset.prefix=prefix;
 cancelAnimationFrame(counterFrames.get(element));
 if(!Number.isFinite(value)||!Number.isFinite(previous)||reducedMotion.matches||prefix){element.textContent=prefix+money(value);return;}
 const start=performance.now();
 const step=now=>{const t=Math.min(1,(now-start)/450),eased=1-Math.pow(1-t,3);element.textContent=money(previous+(value-previous)*eased);if(t<1)counterFrames.set(element,requestAnimationFrame(step));};
 counterFrames.set(element,requestAnimationFrame(step));
 element.classList.remove("value-updated");void element.offsetWidth;element.classList.add("value-updated");
}
let startedAt=null,lastState=null,chartSignature="";
const revealObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){entry.target.classList.add("revealed");revealObserver.unobserve(entry.target);}}},{threshold:0.04});
for(const [i,element] of [...document.querySelectorAll(".paper-title,.paper-stats article,.scalp-summary,.gas-panel,.paper-panel")].entries()){
 element.classList.add("reveal");element.style.setProperty("--reveal-delay",`${Math.min(i,5)*55}ms`);revealObserver.observe(element);
}
function table(id,rows,columns){ const body=$(id);body.replaceChildren();if(!rows.length){const row=node("tr"),cell=node("td",id==="trades"?"No closed paper trades.":id==="positions"?"No open paper positions.":"No candidates observed yet.","empty");cell.colSpan=columns;row.append(cell);body.append(row);return;}for(const cells of rows){const row=node("tr");for(const value of cells){const cell=node("td");if(value instanceof Node)cell.append(value);else cell.textContent=String(value);row.append(cell);}body.append(row);} }

function tokenActions(p){
  const cell=node("span",undefined,"token-actions"),address=p.tokenAddress;
  if(!/^0x[0-9a-f]{40}$/i.test(address??""))return node("span",p.symbol);
  const link=node("a",p.symbol);link.href=`https://www.ponsfamily.com/launchpad/${address}`;link.target="_blank";link.rel="noopener noreferrer";link.title=`View ${p.symbol} on Pons · ${address}`;
  const copy=node("button","COPY","copy-address");copy.type="button";copy.title=address;copy.setAttribute("aria-label",`Copy ${p.symbol} token address`);
  const status=node("span","","copy-status");status.setAttribute("role","status");
  copy.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(address);status.textContent="Copied";setTimeout(()=>{status.textContent="";},2000);}catch{window.prompt("Copy token address",address);}});
  cell.append(link,copy,status);return cell;
}
function entryFdv(p){const value=p.entry.derivedFdvUsd??p.entry.marketCapUsd;const cell=node("span",money(value));cell.title=Number.isFinite(value)?"Derived curve FDV at entry: total supply × pre-buy reserve-ratio price, including virtual reserves. Pons displayed market cap is unverified.":"Derived curve FDV was not recorded.";return cell;}

function facts(id,items){$(id).replaceChildren(...items.map(([label,value])=>{const e=node("div");e.append(node("span",label),node("b",value));return e;}));}
let chartMode="equity",chartRange="all",chartRows=[],chartInspect=null;
function chart(history){
 const canvasWidth=Math.max(320,Math.round($("equity-chart").clientWidth)),canvasHeight=window.innerWidth<=760?240:320;
 const signature=JSON.stringify([history,canvasWidth,canvasHeight,chartMode,chartRange,chartRange==="all"?0:Math.floor(Date.now()/60000)]);if(signature===chartSignature)return;
 const firstDraw=!chartSignature;chartSignature=signature;
 const svg=$("equity-chart"),ns="http://www.w3.org/2000/svg";svg.setAttribute("viewBox",`0 0 ${canvasWidth} ${canvasHeight}`);svg.replaceChildren();chartInspect=null;
 const sorted=history.filter(h=>Number.isFinite(h.equity)&&Number.isFinite(Date.parse(h.timestamp))).slice().sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
 const windows={"1h":3600000,"24h":86400000,"7d":604800000};
 chartRows=chartRange==="all"?sorted:sorted.filter(h=>Date.parse(h.timestamp)>=Date.now()-windows[chartRange]);
 const baseline=lastState?.account.startingBalance??sorted[0]?.equity??0;
 const valuationNote=h=>h.stalePositions>0?" · Includes last-known position values":"";
 const value=h=>chartMode==="pnl"?h.equity-baseline:h.equity;
 $("chart-empty").hidden=chartRows.length>0;
 const add=(tag,attrs,text,parent=svg)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;parent.append(e);return e;};
 if(!chartRows.length){$("chart-value").textContent="—";$("chart-reading-label").textContent="No observations in selected period";$("chart-times").replaceChildren();return;}
 const values=chartRows.map(value),lo=values.reduce((a,b)=>Math.min(a,b),Infinity),hi=values.reduce((a,b)=>Math.max(a,b),-Infinity),padding=Math.max((hi-lo)*.18,.5),min=lo-padding,max=hi+padding;
 const start=Date.parse(chartRows[0].timestamp),end=Date.parse(chartRows.at(-1).timestamp),left=76,right=canvasWidth-22,top=16,bottom=canvasHeight-28;
 const x=h=>start===end?(left+right)/2:left+(Date.parse(h.timestamp)-start)/(end-start)*(right-left),y=v=>bottom-(v-min)/(max-min)*(bottom-top);
 for(let i=0;i<5;i++){const v=min+(max-min)*i/4;add("line",{x1:left,x2:right,y1:y(v),y2:y(v),class:"chart-grid"});add("text",{x:8,y:y(v)+4,class:"chart-label"},money(v));}
 if(chartMode==="pnl"&&min<=0&&max>=0)add("line",{x1:left,x2:right,y1:y(0),y2:y(0),class:"chart-zero"});
 const defs=add("defs",{}),gradient=add("linearGradient",{id:"equity-fill",x1:0,y1:0,x2:0,y2:1},undefined,defs);
 add("stop",{offset:"0%","stop-color":"#ffffff","stop-opacity":.13},undefined,gradient);add("stop",{offset:"100%","stop-color":"#ffffff","stop-opacity":0},undefined,gradient);
 const points=chartRows.map(h=>`${x(h)},${y(value(h))}`);
 if(points.length>1){add("polygon",{points:`${x(chartRows[0])},${bottom} ${points.join(" ")} ${x(chartRows.at(-1))},${bottom}`,fill:"url(#equity-fill)"});const line=add("polyline",{points:points.join(" "),class:"equity-line"});if(firstDraw&&!reducedMotion.matches){const length=line.getTotalLength();line.animate([{strokeDasharray:String(length),strokeDashoffset:length},{strokeDasharray:String(length),strokeDashoffset:0}],{duration:1000,easing:"ease-out"});}}
 const latest=chartRows.at(-1);add("circle",{cx:x(latest),cy:y(value(latest)),r:4,class:"equity-tip"});
 const cursor=add("g",{class:"chart-cursor",visibility:"hidden"});const rule=add("line",{y1:top,y2:bottom,class:"chart-crosshair"},undefined,cursor),dot=add("circle",{r:5,class:"chart-selected"},undefined,cursor);
 const display=index=>{const h=chartRows[index];$("chart-value").textContent=money(value(h));$("chart-reading-label").textContent=`${new Date(h.timestamp).toLocaleString()} · ${chartMode==="pnl"?"P&L from starting balance":"Recorded equity"}${valuationNote(h)}`;rule.setAttribute("x1",x(h));rule.setAttribute("x2",x(h));dot.setAttribute("cx",x(h));dot.setAttribute("cy",y(value(h)));cursor.setAttribute("visibility","visible");};
 const reset=()=>{cursor.setAttribute("visibility","hidden");$("chart-value").textContent=money(value(latest));$("chart-reading-label").textContent=`Latest recorded ${chartMode==="pnl"?"P&L":"equity"} · ${new Date(latest.timestamp).toLocaleString()}${valuationNote(latest)}`;};
 let selected=chartRows.length-1;
 chartInspect={pointer:position=>{let low=0,high=chartRows.length-1;while(low<high){const mid=Math.floor((low+high)/2);if(x(chartRows[mid])<position)low=mid+1;else high=mid;}selected=low>0&&Math.abs(x(chartRows[low-1])-position)<Math.abs(x(chartRows[low])-position)?low-1:low;display(selected);},key:direction=>{selected=Math.max(0,Math.min(chartRows.length-1,selected+direction));display(selected);},reset};reset();
 $("chart-times").replaceChildren(node("span",new Date(start).toLocaleString()),node("span",`${chartRows.length} observations · hover or use ← →`),node("span",new Date(end).toLocaleString()));
}
$("equity-chart").addEventListener("pointermove",event=>{const rect=event.currentTarget.getBoundingClientRect();chartInspect?.pointer((event.clientX-rect.left)/rect.width*event.currentTarget.viewBox.baseVal.width);});
$("equity-chart").addEventListener("pointerleave",()=>chartInspect?.reset());
$("equity-chart").addEventListener("blur",()=>chartInspect?.reset());
$("equity-chart").addEventListener("keydown",event=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();chartInspect?.key(event.key==="ArrowLeft"?-1:1);}});
for(const button of document.querySelectorAll("[data-chart-mode],[data-chart-range]"))button.addEventListener("click",()=>{
 if(button.dataset.chartMode)chartMode=button.dataset.chartMode;else chartRange=button.dataset.chartRange;
 for(const peer of document.querySelectorAll("[data-chart-mode],[data-chart-range]")){const active=peer.dataset.chartMode?peer.dataset.chartMode===chartMode:peer.dataset.chartRange===chartRange;peer.classList.toggle("active",active);peer.setAttribute("aria-pressed",String(active));}
 if(lastState)chart(lastState.history);
});

function render(s){lastState=s;for(const p of s.positions){const q=p.management?.lastSuccessfulQuote;const expired=q&&([q.timestamp,q.blockTimestamp].some(t=>Date.now()-Date.parse(t)>s.config.QUOTE_MAX_AGE_MS)||(q.evidence&&Date.now()-Date.parse(q.evidence.usdTimestamp)>s.config.ETH_USD_MAX_AGE_MS));if(expired){p.markStatus="UNAVAILABLE";p.markReason??="QUOTE_STALE";}}startedAt=Date.parse(s.startedAt);const a=s.account,p=s.performance;$("connection").textContent=`● ${s.connection}`;animateMoney("equity",a.equity,s.positions.some(p=>p.markStatus!=="FRESH")?"LAST KNOWN · ":"");$("cash").textContent=`AVAILABLE CASH ${money(a.availableCash)}`;animateMoney("pnl",a.totalPnl,s.positions.some(p=>p.markStatus!=="FRESH")?"STALE · ":"");tone($("pnl"),a.totalPnl);$("return").textContent=pct(a.totalReturnPercent);$("gate").textContent=({PAPER_REJECT:"OBSERVING",PAPER_ELIGIBLE:"READY",PAPER_ENTER:"ENTERED",PAPER_EXIT:"EXITED",NOT_TRADABLE:"WAITING"})[s.latestGate?.outcome]??s.latestGate?.outcome?.replaceAll("_"," ")??"STANDBY";$("gate-stage").textContent=s.latestGate?.stage??"AWAITING GPTHEIST";$("gate").title=s.latestGate?.message??"";
if(document.activeElement!==$("starting-equity"))$("starting-equity").value=String(a.startingBalance);if(document.activeElement!==$("max-open-trades"))$("max-open-trades").value=String(s.config.MAX_OPEN_POSITIONS);
const lifetimeRate=p.totalTrades?p.wins/p.totalTrades*100:0;
$("analytics-winrate").textContent=p.totalTrades?pct(p.winRate):"—";
$("win-ring").style.strokeDasharray=`${lifetimeRate} ${100-lifetimeRate}`;
facts("analytics-facts",[["Profit factor",p.profitFactor===null?"—":p.profitFactor.toFixed(2)],["Average win",money(p.averageWin)],["Average loss",money(p.averageLoss)],["Max drawdown",pct(p.maximumDrawdown)],["Expectancy / trade",money(p.expectancy)],["Average hold",p.averageHoldingTime===null?"—":duration(p.averageHoldingTime)]]);
$("outcome-wins").textContent=`${p.wins} wins`;$("outcome-losses").textContent=`${p.losses} losses`;
$("outcome-win-bar").style.width=`${lifetimeRate}%`;
const health=s.quoteHealth,usd=health?.ethUsd;
const strategy=s.research?.strategyValidation,gas=health?.gas;
$("strategy-label").textContent=`${s.entryDiagnostics?.strategyMode??"STRICT"} V${strategy?.version??3} / CURRENT STRATEGY`;
animateMoney("scalp-pnl",strategy?.netPnlUsd);tone($("scalp-pnl"),strategy?.netPnlUsd??0);
$("scalp-results").textContent=`${strategy?.closedTrades??0} closed trades · ${strategy?.wins??0} wins · ${pct(strategy?.winRatePercent)} win rate`;
facts("scalp-metrics",[["OPEN POSITIONS",s.positions.length],["ALLOCATION CAP / INCL. GAS",money(s.entryDiagnostics?.allocationCapUsd)],["VALIDATION",strategy?.status==="VALIDATED"?"VALIDATED":"COLLECTING EVIDENCE"],["LAST SCAN",s.entryDiagnostics?.lastCycleMs!=null?`${(s.entryDiagnostics.lastCycleMs/1000).toFixed(1)}s`:"WARMING UP"]]);
const gasText=rate=>rate?`${rate.gwei.toLocaleString("en-US",{maximumFractionDigits:6})} Gwei`:"UNAVAILABLE";
const gasMoney=n=>Number.isFinite(n)?`$${n.toLocaleString("en-US",{minimumFractionDigits:4,maximumFractionDigits:6})}`:"UNKNOWN";
const liveGas=gas?.chain&&Date.now()-Date.parse(gas.chain.timestamp)<=30000;
const liveEthereum=gas?.ethereum&&Date.now()-Date.parse(gas.ethereum.timestamp)<=30000;
$("gas-status").textContent=liveGas?"LIVE ESTIMATE":"UNAVAILABLE";
$("chain-gas").textContent=gasText(liveGas?gas.chain:null);
$("ethereum-gas").textContent=gasText(liveEthereum?gas.ethereum:null);
$("chain-gas-usd").textContent=`${gasMoney(liveGas?gas.estimatedSwapUsd:null)} / estimated swap`;
$("ethereum-gas-usd").textContent=`${gasMoney(liveEthereum?gas.ethereumReferenceSwapUsd:null)} / reference swap`;
$("gas-model").textContent=`${(gas?.assumedGasUnits??200000).toLocaleString()} assumed gas units per swap · new curve fills deduct the chain estimate. Historical unknown gas stays unknown. Approvals and additional chain fees excluded.`;
$("paper-status").textContent=`PAPER QUOTES ${health?.status??"DEGRADED"} · ETH/USD ${usd?.status==="LIVE"?money(usd.ask):usd?.status??"UNAVAILABLE"} · ${health?.quoteSource??"AWAITING QUOTE"} · ${s.positions.length} OPEN · ${s.performance.totalTrades} CLOSED${s.error?` · RESEARCH UNAVAILABLE: ${s.error}`:""}${health?.lastAttempt?.reason?` · ${health.lastAttempt.reason}`:""}${s.positions.some(p=>p.markStatus!=="FRESH")?" · VALUATION INCLUDES LAST-KNOWN MARKS":""}`;
if(s.entryDiagnostics){const d=s.entryDiagnostics;$("paper-status").textContent+=` · ${d.strategyMode??"STRICT"} V${d.strategyVersion??3} · ${d.liveCandidates} LIVE CANDIDATES · SCAN ${d.lastCycleMs===null?"WARMING UP":duration(d.lastCycleMs)}${d.blockers.length?` · ENTRY BLOCKERS: ${d.blockers.slice(0,3).map(b=>`${b.reason} (${b.count})`).join(", ")}`:""}`;}
if(s.systemHealth){const h=s.systemHealth;$("paper-status").textContent+=` · RSS ${(h.memory.rss/1048576).toFixed(0)} MiB · HEAP ${(h.memory.heapUsed/1048576).toFixed(0)} MiB · ${h.memory.pressure} · ${h.collections.activeCandidates} CANDIDATES · ${s.quoteHealth?.pendingRequests??0} PENDING QUOTES · DURABLE ${h.persistence.lastSuccessfulWrite??"UNAVAILABLE"}${h.persistence.error?" · STORAGE ERROR":""}`;}
if(s.entryDiagnostics?.accountSizingBlocked)$("paper-status").textContent+=` · ACCOUNT SIZING BLOCKED: ${money(s.entryDiagnostics.allocationCapUsd)} allocation cap is below ${money(s.entryDiagnostics.minimumTradeUsd)} minimum trade`;
$("recent-rejections").replaceChildren(...(s.recentRejections??[]).slice(-25).reverse().map(d=>node("p",`${d.candidate.symbol} · ${d.reason}`)));
chart(s.history);facts("history-stats",[["STARTING BALANCE",money(a.startingBalance)],[s.positions.some(p=>p.markStatus!=="FRESH")?"LAST-KNOWN ACCOUNT VALUE":"CURRENT EQUITY",money(a.equity)],["PEAK EQUITY",money(p.peakEquity)],["MAX DRAWDOWN",pct(p.maximumDrawdown)]]);
$("activity").replaceChildren(...s.events.slice().reverse().map(e=>{const item=node("li");item.append(node("time",new Date(e.timestamp).toLocaleTimeString()),node("b",e.stage),node("span",e.eventType),node("p",`${e.tokenSymbol?e.tokenSymbol+" / ":""}${e.message}`));return item;}));if(!s.events.length)$("activity").append(node("li","No activity recorded yet."));
$("position-count").textContent=`${s.positions.length} / ${s.config.MAX_OPEN_POSITIONS}`;
table("positions",s.positions.map(p=>{const q=p.management?.lastSuccessfulQuote,stale=p.markStatus!=="FRESH",value=q?q.notionalUsd-(q.costs.gasUsd??0):null,pnl=value===null?null:value-p.costBasisUsd,label=stale?"STALE · ":"";return [p.name,tokenActions(p),entryFdv(p),money(p.costBasisUsd),q?`${stale?"LAST VALUE: ":""}${money(value)}`:"NO SELL VALUE",money(p.sizeUsd),!stale&&q?money(pnl):"UNAVAILABLE",!stale&&q?pct(pnl/p.costBasisUsd*100):"UNAVAILABLE",pct(p.management?.peakReturnPercent),pct(p.management?.mfePercent),pct(p.management?.maePercent),p.plan?.riskClass??"N/A",p.management?.exitExecutionStatus==="EXIT_TRIGGERED_BUT_UNEXECUTABLE"?"EXIT_TRIGGERED_BUT_UNEXECUTABLE":p.management?.pendingExit?"EXIT_PENDING_QUOTE":p.management?.state??"RISK",p.launchTimestamp?duration(Date.now()-Date.parse(p.launchTimestamp)):"UNKNOWN",duration(Date.now()-Date.parse(p.enteredAt)),q?duration(Date.now()-Date.parse(q.timestamp)):"NEVER",p.management?.pendingExit?`EXIT_PENDING_QUOTE · ${p.markReason??"refreshing"}`:stale?`STALE · ${p.markReason??"AWAITING SELL QUOTE"}`:"LIVE"]; }),17);
renderPlans(s.positions,s.trades);
table("trades",s.trades.slice().reverse().map(t=>[t.name,tokenActions(t),entryFdv(t),price(t.entry.fillPriceUsd),price(t.exit.fillPriceUsd),money(t.pnlUsd),pct(t.returnPercent),t.entry.costs.gasUsd!==null&&t.exit.costs.gasUsd!==null?gasMoney(t.entry.costs.gasUsd+t.exit.costs.gasUsd):"UNKNOWN",t.exitReason,duration(Date.parse(t.exitedAt)-Date.parse(t.enteredAt))]),10);
const cost=c=>`${money(c.knownUsd)}${c.unknownFills?` + ${c.unknownFills} unknown`:""}`;
const v2=s.research?.strategyValidation,version=`V${v2?.version??3}`;
facts("performance",[[`${version} WIN RATE / ${v2?.targetWinRatePercent??50}% TARGET`,pct(v2?.winRatePercent)],[`${version} NET REALIZED P&L`,money(v2?.netPnlUsd)],[`${version} CLOSED TRADES`,v2?.closedTrades??0],[`${version} VALIDATION`,v2?.status??"COLLECTING_EVIDENCE"],[`${version} NET WITH OPEN POSITIONS`,money(v2?.netLiquidationPnlUsd)],["CONSERVATIVE SIZING EQUITY",money(s.riskCapacity?.equityUsd)],["UNAVAILABLE HOLDINGS",s.riskCapacity?.unavailablePositions??0],["TOTAL TRADES",p.totalTrades],["WINS",p.wins],["LOSSES",p.losses],["WIN RATE",pct(p.winRate)],["GROSS PROFIT",money(p.grossProfit)],["GROSS LOSS",money(p.grossLoss)],["NET REALIZED P&L",money(p.netPnl)],["AVERAGE WIN",money(p.averageWin)],["AVERAGE LOSS",money(p.averageLoss)],["PROFIT FACTOR",p.profitFactor===null?"N/A":p.profitFactor.toFixed(2)],["EXPECTANCY",money(p.expectancy)],["MAXIMUM DRAWDOWN",pct(p.maximumDrawdown)],["AVERAGE HOLDING TIME",p.averageHoldingTime===null?"N/A":duration(p.averageHoldingTime)],["ESTIMATED FEES",cost(p.estimatedFees)],["ESTIMATED SLIPPAGE",cost(p.estimatedSlippage)],["ESTIMATED GAS COSTS",cost(p.estimatedGasCosts)],["REALIZED P&L",money(a.realizedPnl)],["UNREALIZED P&L",(s.positions.some(p=>p.markStatus!=="FRESH")?"STALE · ":"")+money(a.unrealizedPnl)]]);
table("candidates",s.decisions.slice().reverse().map(d=>{const q=d.candidate.quote, evidence=q.status==="AVAILABLE"?q.quote.evidence:null;const palermo=d.candidate.handoffs.find(h=>h.agent==="PALERMO");return [d.candidate.symbol,d.candidate.tokenAgeSeconds == null ? "UNKNOWN" : `${d.candidate.tokenAgeSeconds}s`,d.candidate.eventMode??"UNKNOWN",d.candidate.recentTraction?.status??"UNKNOWN",d.gptheistVerdict??d.candidate.decision,`${palermo?.outcome??"N/A"} ${d.candidate.launch?.assessment.score??"N/A"}/100`,q.status==="AVAILABLE"?`VERIFIED AT ${new Date(q.quote.timestamp).toLocaleTimeString()} · ${price(q.quote.fillPriceUsd)}`:q.reason==="QUOTE_NOT_REQUESTED"?"N/A":"FAILED",q.status==="AVAILABLE"&&q.quote.roundTrip?`${money(q.quote.roundTrip.immediateExitUsd)} · COST ${pct(q.quote.roundTrip.lossPercent)}`:"UNAVAILABLE",evidence?`${money(evidence.ethUsd)} AT ${new Date(evidence.usdTimestamp).toLocaleTimeString()}`:usd?.status??"N/A",d.paperVerdict??d.outcome,[...new Set([d.reason,...d.details,...(q.details??[])])].join(" · ")];}),11);$("updated").textContent=s.lastSuccess?`RPC ${new Date(s.lastSuccess).toLocaleString()}`:"NO LIVE SNAPSHOT YET";}
function renderPlans(positions,trades){
  const container=$("trade-plans");const opened=new Set([...container.querySelectorAll("details[open]")].map(e=>e.dataset.id));
  container.replaceChildren();
  for(const p of [...positions,...trades.slice(-10).reverse()]){
    const plan=p.plan;if(!plan)continue;
    const details=node("details"),summary=node("summary",`${p.symbol} · ${money(p.sizeUsd)} · ${plan.riskClass} · ${p.exitReason??"OPEN"}`);
    details.dataset.id=p.id;details.open=opened.has(p.id);details.append(summary);
    for(const [label,value] of [
      ["WHY ENTERED",`${plan.gptheistVerdict} → ${plan.paperVerdict}. ${plan.riskReasons.join(" · ")}`],
      ["WHY THIS SIZE",`${plan.reasoning.join(" · ")} Proposed ${money(plan.proposedSizeUsd)}, approved ${money(plan.approvedSizeUsd)}, risk budget ${money(plan.riskBudgetUsd)}. Equity ${money(plan.account.equityUsd)}, cash ${money(plan.account.cashUsd)}, exposure ${money(plan.account.exposureUsd)}.`],
      ["EXIT POLICY",`Downside ${pct(-plan.exitPolicy.downsidePercent)}; profit arm ${pct(plan.exitPolicy.profitArmPercent)}; trail ${pct(plan.exitPolicy.trailingDrawdownPercent)} from peak; max hold ${duration(plan.exitPolicy.maxHoldMs)}. ${plan.exitPolicy.reasons.join(" · ")}`],
      ["CURRENT MANAGEMENT",p.exitReason?`${p.exitReason}: ${(p.exitReasoning??[]).join(" · ")}`:p.management?.pendingExit?`EXIT PENDING: ${p.management.pendingExit.reason}; waiting for a fresh final quote`:p.management?.holdReason??"N/A"],
      ["PEAK / QUOTES",`Peak liquidation ${money(p.management?.peakLiquidationValueUsd)}, return ${pct(p.management?.peakReturnPercent)} at ${p.management?.peakTimestamp??"N/A"}. Last successful sell quote ${p.management?.lastSuccessfulQuoteTimestamp??"N/A"}; failures ${p.management?.quoteFailureCount??0}.`],
      ["REAL EXIT RESERVE",`${p.management?.liquidity?.current.realQuoteReserveWei??"UNKNOWN"} wei (observed ${p.management?.liquidity?.current.timestamp??"UNKNOWN"}; ${p.markStatus==="FRESH"?"LIVE":"NOT CURRENT EXECUTABLE EVIDENCE"})`],
      ["FULL POSITION EXIT REQUIREMENT",`${p.management?.liquidity?.current.positionExitWei??"UNKNOWN"} wei gross, including fees`],
      ["EXIT COVERAGE RATIO",`${p.management?.liquidity?.current.exitCoverageRatio??"UNKNOWN"}×; behavior ${p.management?.liquidity?.behavior??"UNKNOWN"}`],
      ["V5 SURVIVAL",JSON.stringify(plan.survival??null)],
      ["V5 ADAPTIVE PROFIT",JSON.stringify(p.management?.adaptive??null)],
      ["ENTRY LIQUIDITY SAFETY",JSON.stringify(plan.exitLiquiditySafety??null)],
      ["QUOTE DIAGNOSTICS",JSON.stringify({address:p.tokenAddress,quantity:p.quantity,tokenUnits:p.entry.tokenUnits,lastAttempt:p.lastQuoteAttempt,consecutiveFailures:p.management?.consecutiveQuoteFailures,lastSuccessfulBlock:p.management?.lastSuccessfulQuote?.blockNumber,details:p.quoteFailureDetails,attempt:p.quoteDiagnostics})],
      ["SOURCES",plan.sources.join(" · ")]
    ]){const row=node("p");row.append(node("b",`${label}: `),node("span",value));details.append(row);}
    container.append(details);
  }
  if(!container.childNodes.length)container.append(node("p","No paper trade plans yet.","empty"));
}
async function sync(){try{const response=await fetch("/api/paper",{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error??`HTTP ${response.status}`);render(data);}catch(error){if(lastState){for(const p of lastState.positions){p.markStatus="UNAVAILABLE";p.markReason??="MONITOR_CONNECTION_UNAVAILABLE";}render(lastState);}$("connection").textContent="● UNAVAILABLE";$("paper-status").textContent=`PAPER DATA UNAVAILABLE · ${error.message} · Display may be stale.`;}finally{setTimeout(sync,5000);}}
async function updatePaper(path,payload){const status=$("account-control-status");status.textContent="Saving…";try{const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error??`HTTP ${response.status}`);render(data);status.textContent=path.endsWith("/reset")?"Paper account reset. Visible paper history cleared; recovery backup retained.":"Maximum open trades updated.";}catch(error){status.textContent=`Not saved: ${error.message}`;}}
$("trade-limit-form").addEventListener("submit",event=>{event.preventDefault();const maxOpenTrades=Number($("max-open-trades").value);if(!Number.isInteger(maxOpenTrades)||maxOpenTrades<1||maxOpenTrades>100){$("account-control-status").textContent="Maximum open trades must be an integer from 1 to 100.";return;}void updatePaper("/api/paper/settings",{maxOpenTrades});});
$("equity-reset-form").addEventListener("submit",event=>{event.preventDefault();const startingBalanceUsd=Number($("starting-equity").value);if(!Number.isFinite(startingBalanceUsd)||startingBalanceUsd<1||startingBalanceUsd>1_000_000_000){$("account-control-status").textContent="Starting equity must be between $1 and $1,000,000,000.";return;}if(!window.confirm("Reset the paper account to the selected equity? This removes all open positions and visible paper history. A recovery backup will be retained."))return;void updatePaper("/api/paper/reset",{startingBalanceUsd});});
setInterval(()=>{if(startedAt!==null)$("clock").textContent=duration(Date.now()-startedAt);if(lastState)render(lastState);},1000);sync();

for(const link of document.querySelectorAll(".terminal-sidebar nav a"))link.addEventListener("click",()=>{for(const peer of document.querySelectorAll(".terminal-sidebar nav a"))peer.classList.toggle("selected",peer===link);});

new ResizeObserver(()=>{if(lastState)chart(lastState.history);}).observe($("equity-chart"));

let archiveCursor=null,archiveStarted=false;
$("older-trades").addEventListener("click",async()=>{
 const button=$("older-trades");button.disabled=true;
 try {
  const response=await fetch("/api/paper/trades"+(archiveStarted&&archiveCursor?"?cursor="+encodeURIComponent(archiveCursor):""));
  const page=await response.json();if(!response.ok)throw new Error(page.error??"History unavailable");
  archiveStarted=true;archiveCursor=page.next;
  $("archived-trades").replaceChildren(node("h3","ARCHIVED PAPER TRADES"),...page.trades.slice().reverse().map(t=>node("p",`${new Date(t.exitedAt).toLocaleString()} · ${t.symbol} · ${money(t.pnlUsd)} · ${t.exitReason}`)));
  button.textContent=page.next?"OLDER TRADES":"END OF HISTORY";
 } catch(error) {$("archived-trades").textContent=error.message;}
 finally {button.disabled=archiveStarted&&!archiveCursor;}
});

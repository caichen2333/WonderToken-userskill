#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import { cli, isMain, readJson } from './local.mjs';
import { callTool } from './client.mjs';
import { reconcileOfflineProgress } from './progress-workflow.mjs';
import { CONTRACT_FINGERPRINT } from './progress-contract.generated.mjs';

const dataOf=result=>result?.data??result;
const RUN_USAGE='progress-run.mjs run --source source.json [--input proposal.json] --output run.json | resume --context run.json --output run.json [--wait true] | enrich --context run.json --input proposal.json --output enriched.json | control --context run.json --action pause|resume|cancel --output run.json';
export const formatTravelDays=value=>{
  const days=Number(value);
  if(!Number.isFinite(days))return String(value);
  return Number.isInteger(days)?String(days):days.toFixed(1).replace(/\.0$/u,'');
};
export const renderDelivery=({presentation,itinerary,route,images})=>
  `📮 ${presentation.content}\n\n${itinerary ? `🧭 行程摘要：${itinerary}\n\n` : ""}${presentation.rescue ? '🛟 救援记录' : '🗺️ 实际路线'}：${route}\n\n🪙 原始费用：${presentation.originalCost} 玩途币；💸 实际扣费：${presentation.charged} 玩途币；👛 余额：${presentation.balance} 玩途币。\n\n🗓️ 旅行日：${formatTravelDays(presentation.travelDays)} 个旅行日。\n\n${images ? `📸 旅行纪念照\n${images}\n` : ''}`;
async function writeJson(path,value) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600});await rename(temp,path);
}
export async function runProgress(argv=process.argv.slice(2)) {
  const command=argv.shift()??'run', options={};
  if(['help','--help','-h'].includes(command)){console.log(JSON.stringify({usage:RUN_USAGE}));return;}
  const allowed=new Set(['--source','--input','--output','--context','--wait','--action']);
  while(argv.length) { const key=argv.shift(); if(!allowed.has(key)||!argv.length||options[key]!==undefined)throw new Error(`INVALID_RUN_ARGUMENTS; USAGE: ${RUN_USAGE}`); options[key]=argv.shift(); }
  if(!['run','resume','enrich','control'].includes(command))throw new Error(`UNKNOWN_RUN_COMMAND; USAGE: ${RUN_USAGE}`);
  if(command==='run'&&!options['--source'])throw new Error('PROGRESS_SOURCE_REQUIRED');
  if(!options['--output'])throw new Error('RUN_OUTPUT_REQUIRED');
  const output=resolve(options['--output']);
  const previous=options['--context']?dataOf(await readJson(options['--context'])):undefined;
  const input=options['--input']?await readJson(options['--input']):undefined;
  const execute=async(name,args)=>{
    const request={operationId:randomUUID(),...args};
    const saved=await readJson(`${output}.request.json`);
    if(saved?.tool===name&&!await readJson(`${output}.${saved.operationId}.result.json`)&&JSON.stringify(saved.args)===JSON.stringify(args))request.operationId=saved.operationId;
    await writeJson(`${output}.request.json`,{tool:name,args,operationId:request.operationId});
    await writeJson(`${output}.${request.operationId}.request.json`,request);
    const result=await callTool(name,request);
    await writeJson(`${output}.${request.operationId}.result.json`,result);
    if(result?.error||result?.isError) {console.log(JSON.stringify(result));process.exitCode=1;return undefined;}
    await writeJson(output,result);return dataOf(result);
  };
  let run;
  if(command==='run') {
    const offline=await reconcileOfflineProgress();
    if(offline.pendingCount||offline.rejectedCount)throw new Error('OFFLINE_QUEUE_REQUIRES_RECOVERY');
    const source=await readJson(options['--source']);if(!source)throw new Error('PROGRESS_SOURCE_REQUIRED');
    const config=dataOf(await callTool('get_game_config'));
    if(!config.progressConstraints?.executionRuns)throw new Error('PROGRESS_RUN_REQUIRES_V3; use the legacy workflow for this existing journey without starting a new one');
    if(config.progressConstraints.contractFingerprint!==CONTRACT_FINGERPRINT)throw new Error('PROGRESS_CONTRACT_VERSION_MISMATCH');
    run=await execute('begin_journey_progress_run',{requestSource:source,...(input?{proposal:input}:{} )});
  } else if(command==='enrich'||command==='control') {
    if(!previous?.id)throw new Error('PROGRESS_RUN_CONTEXT_REQUIRED');
    run=await execute('submit_journey_progress_enrichment',{runId:previous.id,revision:previous.revision,...(command==='enrich'&&['awaiting-route-proposal','awaiting-letter','attachments'].includes(previous.phase)?{phase:previous.phase}:{}),...(command==='control'?{control:options['--action']}:{proposal:input})});
  } else if(command==='resume') {
    if(!previous?.id)throw new Error('PROGRESS_RUN_CONTEXT_REQUIRED');run=dataOf(await callTool('get_journey_progress_run',{runId:previous.id}));
  }
  if(!run)return;
  const compact=()=>({context:output,phase:run.phase,revision:run.revision,deadlineAt:run.deadlineAt,
    diagnostics:run.attempts?.at(-1)?.diagnostics,externalError:run.externalError,
    task:run.phase==='awaiting-letter'?{kind:'letter',factRefs:(run.facts?.movements??[]).map((m,i)=>({id:i,city:m.destination.city,landmarks:m.landmarkNames})),activityRefs:(run.facts?.activities??[]).map(a=>({id:a.activityId,name:a.displayName})),moods:['warm','curious','peaceful']}:undefined});
  console.log(JSON.stringify(compact()));
  if(!run.id)return;
  if(['awaiting-route-proposal','awaiting-letter'].includes(run.phase)&&options['--wait']!=='true')return;
  const limit=Date.now()+240000;
  while(!['completed','paused','cancelled'].includes(run.phase)&&!run.externalError&&!Object.keys(run.attachmentErrors??{}).length&&Date.now()<limit) {
    await delay(2000);
    const response=await callTool('get_journey_progress_run',{runId:run.id});
    if(response?.error||response?.isError){console.log(JSON.stringify(response));process.exitCode=1;return;}
    run=dataOf(response);await writeJson(output,response);
  }
  if(run.image?.archive==='succeeded') {
    try {
      const result=await callTool('get_memory_image',{journeyId:run.journeyId});
      if(result.error||result.isError||!result.attachments?.length)run.delivery={status:'failed',reason:result.error?.code??'ATTACHMENT_MISSING'};
      else run.delivery={status:'succeeded',attachments:result.attachments};
    } catch(error) {run.delivery={status:'failed',reason:error.code??'ATTACHMENT_SAVE_FAILED'};}
  }
  run.complete=run.phase==='completed'&&(!run.image||run.delivery?.status==='succeeded');
  await writeJson(output,{data:run});
  const entry=run.result?.entry;
  const presentation=run.result?.rescue ? {content:run.result.content,route:[],originalCost:run.result.rescue.originalCost,charged:run.result.rescue.charged,balance:run.result.rescue.balanceAfter,stateAfter:run.result.stateAfter,rescue:run.result.rescue} : entry?{content:run.result.content,route:(run.batchResults??[run.result]).flatMap(r=>r.entry.movements).map(m=>({city:m.destination.city,place:m.destination.name,departedVirtualDay:m.departedVirtualDay,arrivedVirtualDay:m.arrivedVirtualDay,landmarks:m.landmarkNames})),originalCost:String((run.batchResults??[run.result]).reduce((n,r)=>n+BigInt(r.entry.originalCost),0n)),charged:String((run.batchResults??[run.result]).reduce((n,r)=>n+BigInt(r.entry.charged),0n)),balance:entry.balanceAfter,activities:(run.batchResults??[run.result]).flatMap(r=>r.entry.activities??[]),stateAfter:run.result.stateAfter,settlement:run.result.settlement,soul:run.soul,attachments:run.delivery?.attachments}:undefined;
  if(presentation) {
    const file=`${output}.delivery.md`;
    const route=presentation.rescue ? `${presentation.rescue.from.city}·${presentation.rescue.from.name} → 救援归家 → ${presentation.rescue.home.name}` : presentation.route.map(m=>m.place===run.result.stateAfter.currentLocation.name?m.place:m.city).join(' → ');
    const itinerary=[...new Map((presentation.activities??[]).filter(a=>!['rest','food','transit'].includes(a.category)).map(a=>[a.activityId,a])).values()].map(a=>`第${Math.floor(a.fromVirtualDay)+1}天：${a.displayName}`).join('；');
    presentation.itinerary=itinerary;
    presentation.travelDays=presentation.stateAfter.elapsedTravelDays;
    const images=(presentation.attachments??[]).map(a=>`![旅行纪念照](${a.path})`).join('\n');
    await writeFile(file,renderDelivery({presentation,itinerary,route,images}),{mode:0o600});
    presentation.deliveryFile=file;
  }
  console.log(JSON.stringify({...compact(),complete:run.complete,presentation,attachmentErrors:run.attachmentErrors,delivery:run.delivery}));
  if(run.externalError||Object.keys(run.attachmentErrors??{}).length||run.delivery?.status==='failed')process.exitCode=1;
}
if(isMain(import.meta.url))await cli(()=>runProgress());

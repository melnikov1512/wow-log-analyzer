import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import type { WCLClient } from '../wcl/client.js';
import { FIGHT_EVENTS_QUERY } from '../wcl/queries.js';

export type Event = Record<string, any>;
export const META = `query ArchiveMeta($code: String!) { reportData { report(code: $code) {
 code title startTime endTime
 fights { id name encounterID difficulty kill startTime endTime friendlyPlayers phaseTransitions { id startTime } }
 masterData { actors { id gameID name type subType petOwner } abilities { gameID name type } }
} } }`;
export const SETUP = `query ArchiveSetup($code: String!, $fightIDs: [Int]!) { reportData { report(code: $code) {
 playerDetails(fightIDs: $fightIDs, includeCombatantInfo: true)
} } }`;
export function codeOf(value: string): string {
 const code = value.match(/\/reports\/([A-Za-z0-9]+)/)?.[1] ?? value;
 if (!/^[A-Za-z0-9]{16}$/.test(code)) throw new Error('Expected a 16-character WCL report code or report URL');
 return code;
}
export function directory(code: string, fight: number): string {
 if (!Number.isSafeInteger(fight) || fight < 1) throw new Error('Invalid fight ID');
 return join(resolve(process.env.WCL_DATA_DIR ?? fileURLToPath(new URL('../../data',import.meta.url))), codeOf(code), String(fight));
}
export async function save(path: string, value: unknown) {
 await writeFile(path + '.tmp', JSON.stringify(value, null, 2)); await rename(path + '.tmp', path);
}
export async function json(path: string) { return JSON.parse(await readFile(path, 'utf8')); }
export async function discover(client: WCLClient, input: string) {
 const response = await client.query<any>(META, {code: codeOf(input)});
 if (!response.reportData?.report) throw new Error('Report unavailable (public reports only)');
 return response;
}
export async function download(client: WCLClient, input: string, selection: number | 'last', maxPages = 10000) {
 const code = codeOf(input);
 if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('max_pages must be positive');
 // Explicit numeric fights can use a complete archive without any network call.
 if (selection !== 'last') {
  try { const m = await json(join(directory(code, selection), 'manifest.json')); if (m.complete) return m; } catch {}
 }
 const meta = await discover(client, code); const report = meta.reportData.report;
 const fight = selection === 'last' ? report.fights.filter((f: any) => f.encounterID > 0).at(-1) : report.fights.find((f: any) => f.id === selection);
 if (!fight) throw new Error('Fight not found');
 const dir = directory(code, fight.id); await mkdir(dir, {recursive:true});
 try { const m = await json(join(dir, 'manifest.json')); if (m.complete) return m; } catch {}
 const manifest: any = {schema:1, code, fight, downloadedAt:new Date().toISOString(), units:'milliseconds', timestampOrigin:'report start; relativeMs = timestamp - fight.startTime', parameters:{query:FIGHT_EVENTS_QUERY, code, fightID:fight.id, startTime:fight.startTime, endTime:fight.endTime, dataType:'All', includeResources:true, useActorIDs:true, useAbilityIDs:true, hostilityTypes:['Friendlies','Enemies'], limit:10000}, pages:0, events:0, complete:false, warnings:[], directory:dir};
 await save(join(dir,'manifest.json'), manifest); await save(join(dir,'metadata.json'), meta);
 await writeFile(join(dir,'events.jsonl'), '');
 try {
  try { await save(join(dir,'setup.json'), await client.query(SETUP,{code,fightIDs:[fight.id]})); }
  catch { manifest.warnings.push('playerDetails unavailable; inspect combatantinfo events'); }
  const friendlyCounts=new Map<string,number>();
  const enemyCounts=new Map<string,number>();
  manifest.streams={};
  for(const hostilityType of ['Friendlies','Enemies']) {
  let cursor = fight.startTime;
  let finished=false;
  for (let page=0; page<maxPages; page++) {
   if(manifest.pages>=maxPages) break;
   const variables = {code, fightID:fight.id, startTime:cursor, endTime:fight.endTime, dataType:'All',hostilityType};
   const response = await client.query<any>(FIGHT_EVENTS_QUERY, variables);
   await save(join(dir,`page-${hostilityType}-${page}.json`), {variables,response});
   const data = response.reportData?.report?.events;
   if (!data || !Array.isArray(data.data)) throw new Error('Invalid events response');
   for (const e of data.data) if (!Number.isFinite(e.timestamp)) throw new Error('Event timestamp unavailable');
   const unique=data.data.filter((e:Event)=>{
    const key=JSON.stringify(e);
    if(hostilityType==='Friendlies') { friendlyCounts.set(key,(friendlyCounts.get(key)??0)+1); return true; }
    const n=(enemyCounts.get(key)??0)+1; enemyCounts.set(key,n);
    return n>(friendlyCounts.get(key)??0);
   });
   await appendFile(join(dir,'events.jsonl'), unique.map((e: Event)=>JSON.stringify({...e,relativeMs:e.timestamp-fight.startTime})).join('\n') + (unique.length?'\n':''));
   manifest.pages++; manifest.events += unique.length; manifest.nextPageTimestamp=data.nextPageTimestamp;
   await save(join(dir,'manifest.json'),manifest);
   if (data.nextPageTimestamp === null) { finished=true; break; }
   if (!Number.isFinite(data.nextPageTimestamp) || data.nextPageTimestamp <= cursor || data.nextPageTimestamp > fight.endTime) throw new Error('Invalid or non-advancing pagination cursor');
   cursor=data.nextPageTimestamp;
  }
  manifest.streams[hostilityType]={complete:finished,nextPageTimestamp:manifest.nextPageTimestamp};
  if(!finished) { manifest.warnings.push('Page limit reached; archive incomplete'); break; }
  }
  manifest.complete=Object.keys(manifest.streams).length===2 && Object.values(manifest.streams).every((s:any)=>s.complete);
 } catch (error) { manifest.failureCode = (error as any).code ?? ((error as Error).message.startsWith('Invalid') ? (error as Error).message : 'download_failed'); manifest.warnings.push('Download interrupted or API response invalid; archive incomplete. Retry download; inspect API stderr without credentials.'); }
 // Merge hostility streams chronologically for local timeline/aura processing.
 const merged:Event[]=[]; for await(const e of events(dir)) merged.push(e);
 merged.sort((a,b)=>a.timestamp-b.timestamp);
 await writeFile(join(dir,'events.jsonl'),merged.map(e=>JSON.stringify(e)).join('\n')+(merged.length?'\n':''));
 await save(join(dir,'manifest.json'), manifest); return manifest;
}
export async function* events(dir: string): AsyncGenerator<Event> {
 const lines = createInterface({input:createReadStream(join(dir,'events.jsonl')),crlfDelay:Infinity});
 try { for await (const line of lines) if (line) yield JSON.parse(line); } finally { lines.close(); }
}
export function spell(e: Event) { return e.abilityGameID ?? e.ability?.guid ?? e.ability?.gameID ?? null; }
export function matches(e: Event, q: any): boolean {
 return (q.start_ms === undefined || e.relativeMs >= q.start_ms) && (q.end_ms === undefined || e.relativeMs < q.end_ms)
 && (q.actor_id === undefined || (q.direction === 'source' ? e.sourceID===q.actor_id : q.direction === 'target' ? e.targetID===q.actor_id : e.sourceID===q.actor_id || e.targetID===q.actor_id))
 && (q.source_id===undefined || e.sourceID===q.source_id) && (q.target_id===undefined || e.targetID===q.target_id)
 && (q.ability_id===undefined || spell(e)===q.ability_id) && (!q.types?.length || q.types.includes(e.type));
}
export function bounded(items: any[], offset=0, limit=100, maxBytes=24000) {
 const result: any[]=[]; let bytes=0;
 for (const item of items.slice(offset,offset+limit)) { const size=Buffer.byteLength(JSON.stringify(item)); if (bytes+size>maxBytes) break; result.push(item); bytes+=size; }
 return {items:result,total:items.length,next_offset:offset+result.length<items.length?offset+result.length:null, oversized_item:result.length===0 && offset<items.length};
}
export async function inspect(q: any) {
 const dir=directory(q.report,q.fight); const manifest=await json(join(dir,'manifest.json'));
 const meta=(await json(join(dir,'metadata.json'))).reportData.report;
 const context={manifest, report:{code:meta.code,title:meta.title,startTime:meta.startTime,gameVersion:meta.gameVersion??null},fight:manifest.fight, file:join(dir,'events.jsonl')};
 if(q.view==='abilities') return {...context,...bounded(meta.masterData.abilities.filter((a:any)=>q.ability_id===undefined || a.gameID===q.ability_id),q.offset,q.limit)};
 if (q.view==='setup') {
  let details:any=null; try { details=await json(join(dir,'setup.json')); } catch {}
  const info: Event[]=[]; for await(const e of events(dir)) if(e.type==='combatantinfo' && matches(e,q)) info.push(e);
  const selected:any[]=[];
  const visit=(value:any)=>{
   if(!value || typeof value!=='object') return;
   if(!Array.isArray(value) && typeof value.id==='number' && typeof value.name==='string' && (q.actor_id===undefined || value.id===q.actor_id)) { selected.push(value); return; }
   for(const child of Object.values(value)) visit(child);
  };
  visit(details?.reportData?.report?.playerDetails);
  return {...context, playerDetails:bounded(selected,q.offset,q.limit), actors:bounded(meta.masterData.actors.filter((a:any)=>q.actor_id===undefined || a.id===q.actor_id || a.petOwner===q.actor_id),q.offset,q.limit), combatantinfo:bounded(info,q.offset,q.limit), detailsFile:details?join(dir,'setup.json'):null, availability:'Fields absent from combatantinfo/playerDetails are unavailable; no inferred talents, hero talents, gear or stats'};
 }
 const rows:Event[]=[]; const counts=new Map<string,any>(); const active=new Map<string,number>(); const uptime=new Map<string,number>();
 const duration=manifest.fight.endTime-manifest.fight.startTime;
 const start=q.start_ms??0, end=q.end_ms??duration;
 if(start>=duration || end>duration || end<=start) throw new Error('Selected window must be within fight duration');
 for await(const e of events(dir)) {
  // Aura state needs history before the selected window. Keep source identity for overlapping external buffs.
  if ((e.type?.includes('buff')) && matches(e,{...q,start_ms:undefined,end_ms:undefined,types:undefined}) && e.relativeMs<end) {
   const key=`${e.targetID}:${e.sourceID}:${spell(e)}:${e.type.includes('debuff')?'debuff':'buff'}`;
   if (/^(apply|refresh)/.test(e.type) && !active.has(key)) active.set(key,e.relativeMs);
   if (/^remove(buff|debuff)$/.test(e.type) && active.has(key)) { uptime.set(key,(uptime.get(key)??0)+Math.max(0,e.relativeMs-Math.max(start,active.get(key)!))); active.delete(key); }
  }
  if (!matches(e,q)) continue;
  if(q.view==='summary') {
   const key=`${e.type}:${spell(e)}:${e.sourceID}:${e.targetID}`;
   const row=counts.get(key)??{type:e.type,spellID:spell(e),sourceID:e.sourceID,targetID:e.targetID,count:0,amount:null,eventsWithAmount:0,firstMs:e.relativeMs,lastMs:e.relativeMs};
   row.count++; if(typeof e.amount==='number') { row.amount=(row.amount??0)+e.amount; row.eventsWithAmount++; } row.lastMs=e.relativeMs; counts.set(key,row);
  } else if(q.view==='casts' ? ['begincast','cast','interrupt'].includes(e.type) : q.view==='buffs' ? e.type?.includes('buff') : true) rows.push({...e,windowMs:e.relativeMs-start});
 }
 for(const [key,time] of active) uptime.set(key,(uptime.get(key)??0)+Math.max(0,end-Math.max(start,time)));
 if(q.view==='summary') return {...context, tables:bounded([...counts.values()],q.offset,q.limit),uptime:bounded([...uptime].map(([key,observedMs])=>({key,observedMs,percent:100*observedMs/(end-start)})),q.offset,q.limit), caveat:'Observed aura intervals only; initial auras and missing removals may be unknown. Amounts are logged amounts, not inferred DPS losses. Counts separate cast from begincast.'};
 return {...context,...bounded(rows,q.offset,q.limit)};
}

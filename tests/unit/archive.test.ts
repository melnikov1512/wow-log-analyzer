// Synthetic fixtures exercise storage and event semantics; these are not real WCL logs.
import { describe,it,expect,beforeEach,afterEach,vi } from 'vitest';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download,inspect,matches,bounded,directory,json } from '../../src/local/archive.js';
import { localAnalysis,responseText } from '../../src/local/tools.js';
let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'wcl-fixture-'));vi.stubEnv('WCL_DATA_DIR',root);});
afterEach(async()=>{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});
const code='dVaGXbfj6DCHPBFN';
const fight={id:1,name:'Synthetic boss',encounterID:1,startTime:1000,endTime:6000};
const meta={reportData:{report:{code,fights:[fight],masterData:{actors:[{id:1,name:'Synthetic mage'}],abilities:[]}}}};
function client(pages:any[]) { return {query:vi.fn(async(query:string,variables:any)=>query.includes('ArchiveMeta')?meta:query.includes('ArchiveSetup')?{reportData:{report:{playerDetails:{}}}}:{reportData:{report:{events:variables.hostilityType==='Enemies'?{data:[],nextPageTimestamp:null}:pages.shift()}}})} as any; }
describe('local archive',()=>{
 it('downloads every page, preserves raw time, caches without network',async()=>{
  const c=client([{data:[{timestamp:1000,type:'cast',sourceID:1,abilityGameID:42}],nextPageTimestamp:2000},{data:[{timestamp:2000,type:'damage',targetID:1}],nextPageTimestamp:null}]);
  const m=await download(c,code,1);expect(m.complete).toBe(true);expect(m.pages).toBe(3);expect(m.events).toBe(2);
  const r=await inspect({report:code,fight:1,view:'events',actor_id:1});expect(r.items.map((e:any)=>e.relativeMs)).toEqual([0,1000]);expect(r.items[1].timestamp).toBe(2000);
  expect(await json(join(directory(code,1),'page-Friendlies-0.json'))).toHaveProperty('response');
  c.query.mockClear();await download(c,code,1);expect(c.query).not.toHaveBeenCalled();
 });
 it('merges both hostility streams chronologically without double counting overlap or losing identical genuine events',async()=>{
  const shared={timestamp:2000,type:'damage',sourceID:1,targetID:2,amount:42};
  const enemy={timestamp:1500,type:'applydebuff',sourceID:1,targetID:2,abilityGameID:99};
  const c={query:vi.fn(async(query:string,variables:any)=>query.includes('ArchiveMeta')?meta:query.includes('ArchiveSetup')?{}:{reportData:{report:{events:{data:variables.hostilityType==='Friendlies'?[shared,shared]:[enemy,shared,shared],nextPageTimestamp:null}}}})} as any;
  const m=await download(c,code,1);expect(m.complete).toBe(true);expect(m.events).toBe(3);
  const r=await inspect({report:code,fight:1,view:'events'});expect(r.items.map((e:any)=>e.timestamp)).toEqual([1500,2000,2000]);
 });
 it('continues through an empty page with a continuation cursor',async()=>{
  const m=await download(client([{data:[],nextPageTimestamp:2000},{data:[{timestamp:2100,type:'cast'}],nextPageTimestamp:null}]),code,1);
  expect(m.complete).toBe(true);expect(m.events).toBe(1);expect(m.pages).toBe(3);
 });
 it('marks nonadvancing cursor incomplete and preserves fetched page',async()=>{
  const m=await download(client([{data:[{timestamp:1000}],nextPageTimestamp:1000}]),code,1);
  expect(m.complete).toBe(false);expect(m.pages).toBe(1);expect(m.warnings.length).toBeGreaterThan(0);
 });
 it('marks page cap incomplete',async()=>{const m=await download(client([{data:[],nextPageTimestamp:2000}]),code,1,1);expect(m.complete).toBe(false);expect(m.warnings[0]).toContain('limit');});
 it('marks API failure incomplete, never promotes incomplete cache',async()=>{
  const c=client([{data:[],nextPageTimestamp:2000}]);const m=await download(c,code,1);expect(m.complete).toBe(false);
  const good=client([{data:[],nextPageTimestamp:null}]);expect((await download(good,code,1)).complete).toBe(true);
 });
 it('keeps incoming events and external buffs; directional filters and exclusive end work',()=>{
  const e={sourceID:2,targetID:1,relativeMs:100,abilityGameID:42,type:'applybuff'};
  expect(matches(e,{actor_id:1})).toBe(true);expect(matches(e,{actor_id:1,direction:'source'})).toBe(false);
  expect(matches(e,{actor_id:1,direction:'target',ability_id:42})).toBe(true);expect(matches(e,{end_ms:100})).toBe(false);
 });
 it('tracks refresh and stacks without resetting uptime and clips to selected window',async()=>{
  await download(client([{data:[{timestamp:1000,type:'applybuff',sourceID:2,targetID:1,abilityGameID:42},{timestamp:2000,type:'applybuffstack',sourceID:2,targetID:1,abilityGameID:42,stack:2},{timestamp:3000,type:'refreshbuff',sourceID:2,targetID:1,abilityGameID:42},{timestamp:4000,type:'removebuff',sourceID:2,targetID:1,abilityGameID:42}],nextPageTimestamp:null}]),code,1);
  const q={report:code,fight:1,actor_id:1,start_ms:500,end_ms:3500};
  const r=await inspect({...q,view:'summary'});expect(r.uptime.items[0].observedMs).toBe(2500);
  const b=await inspect({...q,view:'buffs'});expect(b.items[0].stack).toBe(2);expect(b.items[0].windowMs).toBe(500);
 });
 it('bounds rows and bytes and signals oversized items',()=>{
  expect(bounded([1,2,3],0,2).next_offset).toBe(2);expect(bounded(['a'.repeat(100)],0,1,10).oversized_item).toBe(true);
  expect(JSON.parse(responseText({large:'x'.repeat(70000)})).error).toBe('response_too_large');
 });
 it('rejects unsafe paths and backwards windows',async()=>{
  expect(()=>directory('../secret',1)).toThrow();await expect(localAnalysis(client([]),{action:'inspect',query:{report:code,fight:1,start_ms:100,end_ms:50}})).rejects.toThrow();
 });
 it('aligns independent windows and preserves comparison context',async()=>{
  await download(client([{data:[{timestamp:2000,type:'cast',sourceID:1}],nextPageTimestamp:null}]),code,1);
  const result=await localAnalysis(client([]),{action:'compare',left:{report:code,fight:1,start_ms:500},right:{report:code,fight:1,start_ms:1000}});
  expect(result.left.items[0].windowMs).toBe(500);expect(result.right.items[0].windowMs).toBe(0);
 });
});

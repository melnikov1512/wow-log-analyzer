import { z } from 'zod';
import type { WCLClient } from '../wcl/client.js';
import { bounded, discover, download, inspect } from './archive.js';
const selection=z.object({
 report:z.string().describe('Report code or URL'), fight:z.number().int().positive(),
 source_id:z.number().int().optional(),target_id:z.number().int().optional(),
 actor_id:z.number().int().optional(), direction:z.enum(['either','source','target']).default('either'),
 start_ms:z.number().nonnegative().optional(),end_ms:z.number().positive().optional(),
 ability_id:z.number().optional(),types:z.array(z.string()).optional(),
 view:z.enum(['events','casts','buffs','summary','setup','abilities']).default('events'),
 offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(200).default(100),
}).refine(q=>q.end_ms===undefined || q.end_ms>(q.start_ms??0),'end_ms must exceed start_ms');
export const localSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('list'),report:z.string(),name:z.string().optional(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(200).default(100)}),
 z.object({action:z.literal('download'),report:z.string(),fight:z.union([z.number().int().positive(),z.literal('last')]),max_pages:z.number().int().positive().max(100000).default(10000)}),
 z.object({action:z.literal('inspect'),query:selection}),
 z.object({action:z.literal('compare'),left:selection,right:selection}),
]);
export const localTool={name:'local_analysis',description:'Reliable local archive: list report fights and actors; download ALL event pages; inspect setup/events/casts/buffs/summary; compare two fights or windows. Times in ms relative to fight start, end exclusive. Choose explicit actor IDs. Compare start_ms anchored to each burst or phase. Buff events preserve stack values. Paginate with offset. Read manifest.complete before conclusions.',inputSchema:{type:'object' as const,properties:{action:{type:'string',enum:['list','download','inspect','compare']},report:{type:'string'},name:{type:'string'},fight:{oneOf:[{type:'integer'},{const:'last'}]},max_pages:{type:'integer'},offset:{type:'integer'},limit:{type:'integer'},query:{type:'object',description:'report, fight, actor_id, direction (either/source/target), start_ms, end_ms, ability_id, types[], view (events/casts/buffs/summary/setup/abilities), offset, limit',additionalProperties:true},left:{type:'object',additionalProperties:true},right:{type:'object',additionalProperties:true}},required:['action']}};
export async function localAnalysis(client:WCLClient,args:unknown):Promise<any> {
 const a=localSchema.parse(args);
 if(a.action==='list') {
  const report=(await discover(client,a.report)).reportData.report;
  return {report:{code:report.code,title:report.title,startTime:report.startTime,gameVersion:report.gameVersion??null},fights:bounded(report.fights,a.offset,a.limit),actors:bounded(report.masterData.actors.filter((p:any)=>!a.name || p.name.toLowerCase()===a.name.toLowerCase()),a.offset,a.limit)};
 }
 if(a.action==='download') return download(client,a.report,a.fight,a.max_pages);
 if(a.action==='inspect') return inspect(a.query);
 return {left:await inspect(a.left),right:await inspect(a.right),alignment:'windowMs = relativeMs - each selected start_ms; choose burst or phase anchors independently', caveat:'Differences are observations, not mistakes. Compare encounter, difficulty, gameVersion/report date, duration, targets, gear, talents, externals and mechanic duties. No automatic rotation verdict or DPS loss estimate.'};
}
// Hard cap the complete response, including metadata and setup. Never silently truncate.
export function responseText(value:unknown,maxBytes=60000):string {
 const text=JSON.stringify(value,null,2);
 if(Buffer.byteLength(text)<=maxBytes) return text;
 return JSON.stringify({error:'response_too_large',message:'Narrow the time range, lower limit, or paginate using offset. Full data remain in WCL_DATA_DIR; no data were deleted.',maxBytes});
}

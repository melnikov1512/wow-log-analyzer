import { z } from 'zod';
import { WCLClient } from '../wcl/client.js';

export const getFightEventsSchema = z.object({
  offset:z.number().int().nonnegative().optional(),
  limit:z.number().int().min(1).max(200).optional(),
  report_code: z.string().describe('WCL report code'),
  fight_id: z.number().describe('Fight ID'),
  event_type: z.enum(['casts', 'damage-done', 'damage-taken', 'healing', 'buffs', 'debuffs', 'deaths']).optional().describe('Event type filter'),
  source_name: z.string().optional().describe('Filter by source player name (client-side filter)'),
  target_name: z.string().optional().describe('Filter by target name (client-side filter)'),
  ability_id: z.number().optional().describe('Filter by ability ID'),
});

export type GetFightEventsArgs = z.infer<typeof getFightEventsSchema>;

export async function handleGetFightEvents(client: WCLClient, args: GetFightEventsArgs): Promise<unknown> {
  try {
    const { download, inspect, json, directory } = await import('../local/archive.js');
    const { join } = await import('node:path');
    const manifest = await download(client,args.report_code,args.fight_id);
    const meta = (await json(join(directory(args.report_code,args.fight_id),'metadata.json'))).reportData.report;
    const find = (name: string) => {
      const actors=meta.masterData.actors.filter((a: any)=>a.name.toLowerCase()===name.toLowerCase());
      if(actors.length!==1) throw new Error('Character missing or ambiguous; use local_analysis with actor_id');
      return actors[0].id;
    };
    const source=args.source_name?find(args.source_name):undefined;
    const target=args.target_name?find(args.target_name):undefined;
    const typeMap: Record<string,string[]> = {'casts':['begincast','cast','interrupt'],'damage-done':['damage'],'damage-taken':['damage'],'healing':['heal','absorbed'],'buffs':['applybuff','refreshbuff','removebuff','applybuffstack','removebuffstack'],'debuffs':['applydebuff','refreshdebuff','removedebuff','applydebuffstack','removedebuffstack'],'deaths':['death']};
    // Apply source and target constraints before local pagination.
    const result:any=await inspect({report:args.report_code,fight:args.fight_id,view:'events',source_id:source,target_id:target,ability_id:args.ability_id,types:args.event_type?typeMap[args.event_type]:undefined,offset:args.offset??0,limit:args.limit??100});
    return {...result,complete:manifest.complete};
  } catch(e) { return {error:'events_failed',message:(e as Error).message}; }
}

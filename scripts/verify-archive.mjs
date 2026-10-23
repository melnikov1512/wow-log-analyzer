// Verify a real local archive without changing its events; never loads credentials.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { directory, events, inspect, spell } from '../dist/local/archive.js';
const [report,fightArg,actorArg]=process.argv.slice(2);
if(!report || !fightArg || !actorArg) throw new Error('Usage: node scripts/verify-archive.mjs REPORT FIGHT ACTOR');
const fight=Number(fightArg), actor=Number(actorArg), dir=directory(report,fight);
const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
assert.equal(manifest.complete,true,'Download must be complete before verification');
const expected=new Map(), streams={};let pages=0;
for(const hostility of ['Friendlies','Enemies']) {
 const counts=new Map();let cursor=manifest.fight.startTime,terminal=false,page=0;
 while(true) {
  const raw=JSON.parse(await readFile(join(dir,`page-${hostility}-${page}.json`),'utf8'));
  assert.equal(raw.variables.startTime,cursor);assert.equal(raw.variables.endTime,manifest.fight.endTime);
  const data=raw.response.reportData.report.events;
  for(const e of data.data) {const key=JSON.stringify(e);counts.set(key,(counts.get(key)??0)+1);}
  pages++;page++;
  if(data.nextPageTimestamp===null){terminal=true;break;}
  assert(data.nextPageTimestamp>cursor,'Cursor must advance');cursor=data.nextPageTimestamp;
 }
 for(const [key,count] of counts)expected.set(key,Math.max(expected.get(key)??0,count));
 streams[hostility]={pages:page,rawEvents:[...counts.values()].reduce((a,b)=>a+b,0),terminal};
}
let count=0, previous=-Infinity, badNormalization=0, outsideFight=0,source=0,target=0,externalBuffs=0,damage=0,incomingDamage=0;
const types={},spells=new Set(),resourceFields=new Set(), samples={};
for await(const e of events(dir)) {
 count++;assert(e.timestamp>=previous,'Archive must be chronological');previous=e.timestamp;
 if(e.relativeMs!==e.timestamp-manifest.fight.startTime)badNormalization++;
 if(e.timestamp<manifest.fight.startTime||e.timestamp>manifest.fight.endTime)outsideFight++;
 const {relativeMs,...raw}=e;const key=JSON.stringify(raw);const remaining=expected.get(key)??0;
 assert(remaining>0,'Derived event must match raw union with correct multiplicity');expected.set(key,remaining-1);
 if(e.sourceID===actor)source++;if(e.targetID===actor)target++;
 if(e.sourceID===actor||e.targetID===actor) {
  types[e.type]=(types[e.type]??0)+1;spells.add(spell(e));
  for(const key of Object.keys(e))if(/resource/i.test(key))resourceFields.add(key);
  if(!samples[e.type])samples[e.type]={timestamp:e.timestamp,relativeMs:e.relativeMs,type:e.type,sourceID:e.sourceID,targetID:e.targetID,spellID:spell(e),stack:e.stack};
 }
 if(e.type==='damage' && e.sourceID===actor)damage+=e.amount??0;
 if(e.type==='damage' && e.targetID===actor)incomingDamage+=e.amount??0;
 if(e.type==='applybuff'&&e.targetID===actor&&e.sourceID!==actor)externalBuffs++;
}
assert.equal(count,manifest.events);assert.equal(pages,manifest.pages);assert.equal(badNormalization,0);
assert.equal([...expected.values()].reduce((a,b)=>a+b,0),0,'Every raw event must be represented');
const q={report,fight,actor_id:actor,offset:0,limit:5};
const setup=await inspect({...q,view:'setup'});
const casts=await inspect({...q,view:'casts',direction:'source',start_ms:0,end_ms:30000});
const next=await inspect({...q,view:'casts',direction:'source',start_ms:0,end_ms:30000,offset:casts.next_offset??0});
const buffs=await inspect({...q,view:'buffs',direction:'target'});
const summary=await inspect({...q,view:'summary',direction:'source'});
assert(source>0&&target>0);assert(casts.items.length>0);assert(buffs.items.length>0);assert(summary.tables.items.length>0);
assert(casts.items.every(e=>e.sourceID===actor&&e.relativeMs>=0&&e.relativeMs<30000));
assert(buffs.items.every(e=>e.targetID===actor));
if(casts.next_offset!==null)assert.equal(next.items.length,Math.min(5,casts.total-casts.next_offset));
const player=setup.playerDetails.items.find(p=>p.id===actor);
assert(player,'Selected playerDetails must be available');
const result={verifiedAt:new Date().toISOString(),report,fight,actor,character:player.name,encounter:manifest.fight.name,durationMs:manifest.fight.endTime-manifest.fight.startTime,difficulty:manifest.fight.difficulty,kill:manifest.fight.kill,complete:manifest.complete,pages,count,streams,badNormalization,outsideFight,sourceEvents:source,targetEvents:target,externalBuffApplications:externalBuffs,loggedDamage:damage,loggedIncomingDamage:incomingDamage,eventTypes:types,resourceFields:[...resourceFields],uniqueAbilityIDs:spells.size,setup:{specs:player.specs,gearEntries:player.combatantInfo?.gear?.length,talentTreeEntries:player.combatantInfo?.talentTree?.length,talentsEntries:player.combatantInfo?.talents?.length,statNames:Object.keys(player.combatantInfo?.stats??{})},queries:{castsFirst30s:casts.total,buffs:buffs.total,summaryRows:summary.tables.total,paginationChecked:casts.next_offset!==null},samples};
await writeFile(join(dir,'verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));

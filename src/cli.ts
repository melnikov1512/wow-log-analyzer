#!/usr/bin/env node
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { WCLClient } from './wcl/client.js';
import { localAnalysis, responseText } from './local/tools.js';
config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true} as any);
async function main() {
 const args=process.argv.slice(2);
 if(!args.length || args[0]==='--help') { console.log('Usage: node dist/cli.js \'{"action":"list","report":"dVaGXbfj6DCHPBFN","name":"Морано"}\'\nActions: list, download, inspect, compare. See README.md.'); return; }
 const client=new WCLClient(process.env.WCL_CLIENT_ID??'',process.env.WCL_CLIENT_SECRET??'');
 const result=await localAnalysis(client,JSON.parse(args.join(' '))); console.log(responseText(result));
 if(result.complete===false) process.exitCode=2;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

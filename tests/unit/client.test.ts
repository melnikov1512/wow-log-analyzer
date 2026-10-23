import { afterEach,describe,it,expect,vi } from 'vitest';
import { WCLClient } from '../../src/wcl/client.js';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const token=()=>new Response(JSON.stringify({access_token:'synthetic-token',expires_in:3600}),{status:200});
const result=()=>new Response(JSON.stringify({data:{ok:true}}),{status:200});
describe('WCL client with synthetic HTTP',()=>{
 it('rejects missing credentials without a network call',async()=>{
  const f=vi.fn();vi.stubGlobal('fetch',f);await expect(new WCLClient('','').query('{}',{})).rejects.toMatchObject({code:'missing_configuration'});expect(f).not.toHaveBeenCalled();
 });
 it('refreshes expired token on 401',async()=>{
  const f=vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(token()).mockResolvedValueOnce(result());
  vi.stubGlobal('fetch',f);await expect(new WCLClient('id','secret').query('{}',{})).resolves.toEqual({ok:true});expect(f).toHaveBeenCalledTimes(4);
 });
 it('does not retry GraphQL schema/permission errors',async()=>{
  const f=vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({data:{partial:true},errors:[{message:'Synthetic schema error'}]})));
  vi.stubGlobal('fetch',f);await expect(new WCLClient('id','secret').query('{}',{})).rejects.toMatchObject({code:'graphql_error'});expect(f).toHaveBeenCalledTimes(2);
 });
 it('honors Retry-After, bounds retries, and does not wait after final attempt',async()=>{
  vi.useFakeTimers();const f=vi.fn().mockImplementation(async(url:string)=>url.includes('oauth')?token():new Response('',{status:429,headers:{'Retry-After':'2'}}));vi.stubGlobal('fetch',f);
  const request=new WCLClient('id','secret').query('{}',{});const assertion=expect(request).rejects.toMatchObject({code:'rate_limited'});
  await vi.runAllTimersAsync();await assertion;expect(f).toHaveBeenCalledTimes(5);expect(vi.getTimerCount()).toBe(0);
 });
 it('does not expose OAuth response body',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('secret-reflected',{status:400})));
  await expect(new WCLClient('id','secret').query('{}',{})).rejects.not.toThrow('secret-reflected');
 });
});

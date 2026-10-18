import { config } from '../config.js';
import { VERSION } from '../version.js';
import { Limiter } from './limit.js';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { quota, requestIdentity } from '../quota.js';

/** Identifying User-Agent for every provider (MET Norway rejects requests without one; others ask for it). */
export const USER_AGENT = `mcp-weather/${VERSION} (+https://github.com/Koneisto/mcp-weather)`;
const requests = new Limiter(config.httpMaxConcurrent, config.httpMaxQueued);

type Representation = { body: Buffer; headers: Headers; expires: number; status: number; statusText: string };
const representations = new Map<string, Representation>();
let representationBytes = 0;
function remove(key:string):void {
  const current=representations.get(key);
  if(current) { representationBytes-=current.body.length;representations.delete(key); }
}
function store(key:string, value:Representation):void {
  remove(key);
  if(value.body.length>config.cacheMaxBytes) return;
  while(representations.size>=config.cacheMaxEntries || representationBytes+value.body.length>config.cacheMaxBytes) {
    const first=representations.keys().next().value; if(first===undefined) break;
    representationBytes-=representations.get(first)!.body.length;representations.delete(first);
  }
  representations.set(key,value);representationBytes+=value.body.length;
}
function cacheExpiry(headers:Headers):number|null {
  const cc=headers.get('cache-control')??'';
  if(/(?:^|,)\s*(?:no-store|private)(?:[=,]|$)/i.test(cc) || headers.get('vary')==='*') return null;
  if(/(?:^|,)\s*no-cache(?:[=,]|$)/i.test(cc)) return 0;
  const age=Number(headers.get('age')??0);
  const max=cc.match(/(?:^|,)\s*max-age=(\d+)/i);
  if(max) { const date=Date.parse(headers.get('date')??''); const apparent=Number.isFinite(date)?Math.max(0,Date.now()-date):0;return Date.now()+Math.max(0,Number(max[1])*1000-Math.max(apparent,Number.isFinite(age)?age*1000:0)); }
  const expires=Date.parse(headers.get('expires')??'');
  return Number.isFinite(expires)?expires:0;
}
function response(value:Representation):Response { return new Response(new Uint8Array(value.body),{status:value.status,statusText:value.statusText,headers:value.headers}); }

/** Bounded HTTPS retrieval. Each redirect/conditional attempt is reserved durably before dispatch. */
export async function httpGet(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Upstream URL must use HTTPS without credentials');
  const identity=requestIdentity(target,headers);
  const key=createHash('sha256').update(JSON.stringify([url,identity.account,Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]).sort()])).digest('hex');
  const signal = AbortSignal.timeout(config.httpTimeoutMs);
  return requests.run(async () => {
    const callerConditional=Object.keys(headers).some(k=>['if-none-match','if-modified-since'].includes(k.toLowerCase()));
    const known=callerConditional?undefined:representations.get(key);
    if(known && known.expires>Date.now()) return response(known);
    const requestHeaders=new Headers({'User-Agent':USER_AGENT,'Accept-Encoding':'gzip',...headers});
    if(known) {
      const etag=known.headers.get('etag'), modified=known.headers.get('last-modified');
      if(etag) requestHeaders.set('If-None-Match',etag);
      else if(modified) requestHeaders.set('If-Modified-Since',modified);
    }
    let current=target;
    for(let attempt=0;attempt<4;attempt++) {
      signal.throwIfAborted();
      // Independent processes may briefly own the fsynced state transaction. Waiting consumes
      // the original request deadline; a crashed lock remains fail-closed instead of resetting it.
      while(true) {
        try { quota.reserve(identity.provider,identity.account,Math.max(identity.cost,requestIdentity(current,headers).cost)); break; }
        catch(err) { if(!(err instanceof Error) || !err.message.startsWith('Quota state locked')) throw err; await pause(5,undefined,{signal}); }
      }
      signal.throwIfAborted();
      let res:Response;
      try { res=await fetch(current,{signal,redirect:'manual',headers:requestHeaders}); }
      catch(err) { quota.observe(identity.provider,identity.account,599,null);throw err; }
      try { quota.observe(identity.provider,identity.account,res.status,res.headers.get('retry-after')); }
      catch(err) { await res.body?.cancel().catch(()=>{});throw err; }
      if([301,302,303,307,308].includes(res.status)) {
        await res.body?.cancel();
        const location=res.headers.get('location');if(!location) throw Error('Upstream redirect has no location');
        const next=new URL(location,current);
        if(next.protocol!=='https:' || next.origin!==target.origin || next.username || next.password) throw Error('Unsafe upstream redirect');
        current=next;continue;
      }
      const reader=res.body?.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      try {
        if(reader) while(true) { signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>config.httpMaxResponseBytes)throw Error('Upstream response exceeds byte limit');chunks.push(value); }
        signal.throwIfAborted();
      } catch(err) {await reader?.cancel().catch(()=>{});throw err;} finally {reader?.releaseLock();}
      const responseHeaders=new Headers(res.headers);responseHeaders.delete('content-encoding');responseHeaders.delete('content-length');
      if(res.status===304) {
        if(!known) { if(callerConditional) return new Response(null,{status:304,headers:responseHeaders}); throw Error('Upstream 304 without known representation'); }
        const merged=new Headers(known.headers);responseHeaders.forEach((v,k)=>merged.set(k,v));
        const expiry=cacheExpiry(merged);const value={...known,headers:merged,expires:expiry??0};
        if(expiry===null) {remove(key);} else store(key,value);
        return response(value);
      }
      const body=Buffer.concat(chunks,bytes);
      const expiry=cacheExpiry(responseHeaders);
      if(res.status===200 && expiry!==null && !callerConditional) store(key,{body,headers:responseHeaders,expires:expiry,status:res.status,statusText:res.statusText});
      else if(known) { remove(key); }
      return new Response([204,205].includes(res.status)?null:body,{status:res.status,statusText:res.statusText,headers:responseHeaders});
    }
    throw Error('Upstream redirect limit exceeded');
  },signal);
}

/** GET JSON; non-2xx is an error with the provider name and status. */
export async function getJson<T>(url: string, provider: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await httpGet(url, { Accept: 'application/json', ...headers });
  if (!res.ok) throw new Error(`${provider} returned ${res.status}`);
  return await res.json() as T;
}

/** GET text (XML feeds). */
export async function getText(url: string, provider: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await httpGet(url, headers);
  if (!res.ok) throw new Error(`${provider} returned ${res.status}`);
  return await res.text();
}

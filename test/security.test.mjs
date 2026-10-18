import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
Object.assign(process.env,{HTTP_TIMEOUT_MS:'80',HTTP_MAX_RESPONSE_BYTES:'1024',HTTP_MAX_CONCURRENT:'2',HTTP_MAX_QUEUED:'2',MAX_HTTP_REQUESTS:'1',MCP_WEATHER_KEY_NOTE:'off'});
const {startHttpServer}=await import('../build/server.js');
const {httpGet}=await import('../build/utils/http.js');
const {Limiter}=await import('../build/utils/limit.js');
const {Cache}=await import('../build/cache.js');
const {resolveLocation}=await import('../build/utils/location.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
const headers={'content-type':'application/json',accept:'application/json'};
async function withServer(fn){const s=await startHttpServer(0,'127.0.0.1');const base=`http://127.0.0.1:${s.address().port}`;try{await fn(base,s);}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}}

test('malformed HTTP targets return 400 and the process keeps serving health and MCP',async()=>{
 await withServer(async(base,s)=>{
  const response=await new Promise((resolve,reject)=>{let data='';const socket=createConnection({host:'127.0.0.1',port:s.address().port},()=>socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));socket.on('data',b=>data+=b);socket.on('error',reject);socket.on('close',()=>resolve(data));});
  assert.match(response,/HTTP\/1.1 400/);
  assert.equal(await(await fetch(base+'/health')).text(),'ok');
  const r=await fetch(base+'/mcp',{method:'POST',headers,body:rpc});assert.equal(r.status,200);assert.equal((await r.json()).result.tools.length,12);
 });
});
test('invalid JSON, content type, oversized bodies and foreign Origin are safely rejected',async()=>{
 await withServer(async base=>{
  for(const [h,body,status] of [[headers,'{bad',400],[{'content-type':'text/plain'},rpc,415],[headers,'x'.repeat((1<<20)+1),413],[{...headers,origin:'https://evil.example'},rpc,403]]){
   const r=await fetch(base+'/mcp',{method:'POST',headers:h,body});assert.equal(r.status,status);await r.text();
  }
  assert.equal((await fetch(base+'/health')).status,200);
 });
});
test('HTTP concurrency rejects overload but health stays available; body deadline frees the slot',async()=>{
 await withServer(async(base,s)=>{
  const socket=createConnection({host:'127.0.0.1',port:s.address().port});await new Promise(r=>socket.once('connect',r));
  let response='';socket.on('data',b=>response+=b);const closed=new Promise(r=>socket.on('close',r));
  socket.write('POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
  await pause(10);
  const busy=await fetch(base+'/mcp',{method:'POST',headers,body:rpc});assert.equal(busy.status,503);assert.equal(busy.headers.get('retry-after'),'1');await busy.text();
  assert.equal((await fetch(base+'/health')).status,200);
  await closed;assert.match(response,/HTTP\/1.1 408/);
  assert.equal((await fetch(base+'/mcp',{method:'POST',headers,body:rpc})).status,200);
 });
});
test('upstream timeout includes streamed response bodies',async()=>{
 const original=globalThis.fetch;let cancelled=false;
 globalThis.fetch=async(_u,{signal})=>new Response(new ReadableStream({start(controller){const timer=setTimeout(()=>{controller.enqueue(new Uint8Array([1]));controller.close();},200);signal.addEventListener('abort',()=>{clearTimeout(timer);cancelled=true;controller.error(signal.reason);},{once:true});}}));
 try{await assert.rejects(httpGet('https://weather.example/data'),/timeout|aborted/i);assert.equal(cancelled,true);}finally{globalThis.fetch=original;}
});
test('upstream byte cap counts decoded bytes and cancels oversized bodies',async()=>{
 const original=globalThis.fetch;let cancelled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1025));},cancel(){cancelled=true;}}));
 try{await assert.rejects(httpGet('https://weather.example/large'),/byte limit/);assert.equal(cancelled,true);}finally{globalThis.fetch=original;}
});
test('all upstream calls share a bounded queue, sockets and original deadlines',async()=>{
 const original=globalThis.fetch;let active=0,peak=0,calls=0;
 globalThis.fetch=async(_u,options)=>{assert.equal(options.redirect,'manual');calls++;peak=Math.max(peak,++active);await pause(10);active--;return new Response('{}');};
 try{const jobs=Array.from({length:5},(_,i)=>httpGet(`https://weather.example/${i}`));const results=await Promise.allSettled(jobs);assert.equal(results.filter(x=>x.status==='fulfilled').length,4);assert.equal(results.filter(x=>x.status==='rejected').length,1);assert.equal(peak,2);assert.equal(calls,4);}finally{globalThis.fetch=original;}
 const limiter=new Limiter(1,1);let release;const first=limiter.run(()=>new Promise(r=>release=r),AbortSignal.timeout(1000));
 const second=limiter.run(()=>assert.fail('expired queued task started'),AbortSignal.timeout(10));const keepalive=pause(30);
 await assert.rejects(second,/timeout|aborted/i);release();await first;await keepalive;
 await limiter.run(async()=>{},AbortSignal.timeout(80));
});
test('cache coalesces identical work, bounds distinct pending work and recovers after failure',async()=>{
 const c=new Cache(2,1);let release,calls=0;const fetcher=()=>{calls++;return new Promise(r=>release=r);};
 const a=c.getOrFetch('same',fetcher),b=c.getOrFetch('same',fetcher);await pause(0);
 await assert.rejects(c.getOrFetch('different',async()=>1),/capacity/);release(7);assert.deepEqual(await Promise.all([a,b]),[7,7]);assert.equal(calls,1);
 await assert.rejects(c.getOrFetch('bad',async()=>{throw Error('controlled');}),/controlled/);assert.equal(c.getStats().inflight,0);assert.equal(await c.getOrFetch('ok',async()=>9),9);
});
test('URLs, coordinate bounds and location length are validated before network work',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('unexpected network');
 try{for(const url of ['http://127.0.0.1/','https://user:pass@weather.example/','file:///etc/passwd'])await assert.rejects(httpGet(url),/HTTPS/);
 for(const q of ['999,999','91,20','60,181','1'.repeat(400)+',0','x'.repeat(201)])await assert.rejects(resolveLocation(q),/Coordinates|200 characters/);
 assert.deepEqual(await resolveLocation('-90,-180'),{lat:-90,lon:-180,name:'-90.00,-180.00'});
 }finally{globalThis.fetch=original;}
});
test('Syke rejects upstream pagination outside its HTTPS API',async()=>{
 const original=globalThis.fetch;const urls=[];globalThis.fetch=async u=>{urls.push(String(u));return new Response(JSON.stringify({value:[],'odata.nextLink':'http://127.0.0.1:9/private'}));};
 try{const {fetchLakeByName}=await import('../build/sources/syke.js');await assert.rejects(fetchLakeByName('Saimaa'),/pagination URL/);assert.ok(urls.every(u=>u.startsWith('https://rajapinnat.ymparisto.fi/')));}finally{globalThis.fetch=original;}
});
test('invalid numeric configuration fails at startup with only the setting name',()=>{
 for(const [key,value] of [['CACHE_MAX_ENTRIES','-1'],['HTTP_TIMEOUT_MS','NaN'],['CACHE_MAX_INFLIGHT','0'],['HTTP_MAX_CONCURRENT','1.5']]){
  const r=spawnSync(process.execPath,['--input-type=module','-e',"await import('./build/config.js')"],{env:{...process.env,[key]:value},encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,new RegExp(key+' must be an integer'));
 }
});
test('standalone bundle serves MCP without node_modules',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'weather-bundle-'));const file=join(dir,'weather.mjs');await copyFile(new URL('../build/weather.mjs',import.meta.url),file);
 const c=new Client({name:'bundle-test',version:'1'});
 try{await c.connect(new StdioClientTransport({command:process.execPath,args:[file],cwd:dir,env:{PATH:process.env.PATH,MCP_STATE_DIR:process.env.MCP_STATE_DIR,MCP_WEATHER_KEY_NOTE:'off'},stderr:'pipe'}));assert.equal((await c.listTools()).tools.length,12);const r=await c.callTool({name:'get_astronomy',arguments:{location:'60.17,24.94',date:'2026-10-18'}});assert.ok(!r.isError);assert.equal(r.structuredContent.date,'2026-10-18');}finally{await c.close();await rm(dir,{recursive:true,force:true});}
});

test('identical concurrent MET requests share one upstream call and still honor Expires',async()=>{
 const {metGet,clearMetStore}=await import('../build/sources/met-norway.js');clearMetStore();
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;await pause(10);return new Response('{"ok":true}',{headers:{expires:new Date(Date.now()+60000).toUTCString()}});};
 try{const results=await Promise.all(Array.from({length:5},()=>metGet('locationforecast/2.0/compact',60.17,24.94)));assert.ok(results.every(x=>x.ok));await metGet('locationforecast/2.0/compact',60.17,24.94);assert.equal(calls,1);}finally{globalThis.fetch=original;clearMetStore();}
});
test('configured provider keys and credential query values are redacted from errors',async()=>{
 const {config}=await import('../build/config.js');const {safeError}=await import('../build/utils/errors.js');const {errorMessage}=await import('../build/utils/result.js');
 const original=config.tomorrowIoKey;config.tomorrowIoKey='test/credential-only';
 try{for(const f of [safeError,errorMessage]){const text=f(Error('provider test/credential-only https://provider.example/?apikey=some-value&key=test%2Fcredential-only'));assert.ok(!text.includes('test/credential-only'));assert.ok(!text.includes('test%2Fcredential-only'));assert.ok(!text.includes('some-value'));assert.match(text,/redacted/);}}finally{config.tomorrowIoKey=original;}
});


test('Origin must be an HTTP origin, without userinfo or a path',async()=>{
 const {originAllowed}=await import('../build/server.js');
 for(const origin of ['file://localhost','ftp://localhost','http://user@localhost','http://localhost/','http://localhost/path'])assert.equal(originAllowed(origin),false);
 assert.equal(originAllowed('http://localhost:6274'),true);assert.equal(originAllowed('https://trusted.example',['https://trusted.example']),true);
});

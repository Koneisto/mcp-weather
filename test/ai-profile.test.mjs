import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root = process.env.WEATHER_BUILD_ROOT ?? resolve('build');
const load = (p) => import(pathToFileURL(resolve(root,p)));
const {createMcpServer,startHttpServer} = await load('server.js');
const {compactResult} = await load('ai-profile.js');
async function client(profile) {
 const [a,b] = InMemoryTransport.createLinkedPair(); const s=createMcpServer(profile); await s.connect(b);
 const c=new Client({name:'ai-test',version:'1'}); await c.connect(a); return c;
}
test('real clients discover twelve tools; compact metadata smaller with constrained selectors',async()=>{
 const full=await client('full'), compact=await client('compact');
 try {
 const f=await full.listTools(),c=await compact.listTools();
 assert.equal(f.tools.length,12);assert.deepEqual(c.tools.map(t=>t.name),f.tools.map(t=>t.name));
 for(const t of c.tools){assert.equal(t.outputSchema,undefined);assert.ok(t.inputSchema.properties.fields.items.enum.length);assert.equal(t.annotations.readOnlyHint,true);}
 assert.ok(f.tools.every(t=>t.outputSchema));
 const fb=Buffer.byteLength(JSON.stringify(f)),cb=Buffer.byteLength(JSON.stringify(c));
 console.log(JSON.stringify({measurement:'tools/list JSON UTF-8 bytes (not model tokens)',full:fb,compact:cb,savedPercent:100*(fb-cb)/fb}));
 assert.ok(cb<fb*0.65);
 }finally{await full.close();await compact.close();}
});
test('single JSON rendering, projection, invalid fields and unchanged full structured automation',async()=>{
 const full=await client('full'),compact=await client('compact');
 try{
 const args={location:'60.17,24.94',date:'2026-10-18'};
 const f=await full.callTool({name:'get_astronomy',arguments:args});assert.ok(f.structuredContent);
 const all=await compact.callTool({name:'get_astronomy',arguments:args});
 const fb=Buffer.byteLength(JSON.stringify(f)),cb=Buffer.byteLength(JSON.stringify(all));
 console.log(JSON.stringify({measurement:'astronomy complete call result JSON UTF-8 bytes (not model tokens)',full:fb,compact:cb,savedPercent:100*(fb-cb)/fb}));
 assert.ok(cb<fb);
 const c=await compact.callTool({name:'get_astronomy',arguments:{...args,fields:['location']}});
 assert.equal(c.isError,undefined);assert.equal(c.structuredContent,undefined);assert.equal(c.content.length,1);
 const data=JSON.parse(c.content[0].text);assert.ok(data.location);assert.equal(data.sunrise,undefined);
 const invalid=await compact.callTool({name:'get_astronomy',arguments:{...args,fields:['bogus']}});assert.equal(invalid.isError,true);
 const stat=await compact.callTool({name:'get_weather_source_status',arguments:{}});assert.ok(!stat.isError);assert.doesNotMatch(stat.content[0].text,/signup|docker compose|howToSet/);
 const fullStat=await compact.callTool({name:'get_weather_source_status',arguments:{detail:'full'}});assert.match(fullStat.content[0].text,/howToSet/);
 }finally{await full.close();await compact.close();}
});
test('canonical output validation retained; safety, freshness and false/zero/null preserved',()=>{
 const t={name:'get_lake_conditions',outputSchema:{location:z.object({name:z.string()}),waterLevels:z.array(z.object({cm:z.number(),status:z.string(),ageDays:z.number()})),ice:z.array(z.object({weak:z.boolean(),thicknessCm:z.number().nullable()})),extra:z.number().optional()}};
 const data={location:{name:'Lake'},waterLevels:[{cm:0,status:'missing',ageDays:9}],ice:[{weak:false,thicknessCm:null}],extra:12};
 const r=compactResult(t,{content:[{type:'text',text:'Human duplicate'}],structuredContent:data},{fields:['location']});
 const obj=JSON.parse(r.content[0].text);assert.equal(obj.waterLevels[0].cm,0);assert.equal(obj.waterLevels[0].ageDays,9);assert.equal(obj.ice[0].weak,false);assert.equal(obj.ice[0].thicknessCm,null);assert.equal(obj.extra,undefined);assert.match(obj._context.note,/stale/);assert.doesNotMatch(r.content[0].text,/Human duplicate/);
 assert.throws(()=>compactResult(t,{content:[],structuredContent:{...data,waterLevels:[{cm:'bad'}]}},{}));
 assert.throws(()=>compactResult(t,{content:[],structuredContent:data},{fields:['invalid']}));
 const error=compactResult(t,{content:[{type:'text',text:'Unavailable, retry later'}],isError:true},{});assert.equal(error.isError,true);assert.match(error.content[0].text,/Unavailable/);
});
test('warning projection retains complete critical instructions and coverage',()=>{
 const t={name:'get_weather_warnings',outputSchema:{location:z.string(),coverage:z.string(),warnings:z.array(z.object({instruction:z.string()})),source:z.string()}};
 const r=compactResult(t,{content:[],structuredContent:{location:'FI',coverage:'country',warnings:[{instruction:'Stay indoors. '.repeat(100)}],source:'Official'}},{fields:['location']});
 const d=JSON.parse(r.content[0].text);assert.equal(d.warnings[0].instruction.length,1400);assert.equal(d.coverage,'country');assert.equal(d.source,'Official');
});
test('compact HTTP endpoint uses real protocol and the same origin/content controls',async()=>{
 const server=await startHttpServer(0); const url=new URL(`http://127.0.0.1:${server.address().port}/mcp/compact`);
 const c=new Client({name:'http-ai-test',version:'1'});
 try{
 await c.connect(new StreamableHTTPClientTransport(url));assert.equal((await c.listTools()).tools.length,12);
 assert.equal((await fetch(url,{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
 assert.equal((await fetch(url)).status,405);
 }finally{await c.close();await new Promise(r=>server.close(r));}
});

test('all twelve compact tool routes reject malformed required input or return valid status JSON',async()=>{
 const c=await client('compact');
 try{for(const t of (await c.listTools()).tools){
  const r=await c.callTool({name:t.name,arguments:{}});
  if(t.name==='get_weather_source_status'){assert.ok(!r.isError);assert.ok(JSON.parse(r.content[0].text).sources);}
  else assert.equal(r.isError,true,t.name);
 }}finally{await c.close();}
});

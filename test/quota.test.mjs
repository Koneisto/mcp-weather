import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {Quota,requestIdentity}=await import(`${process.env.WEATHER_BUILD_ROOT??'../build'}/quota.js`);
const account='a'.repeat(64), provider='example.com';
function fixture(limit=2){let now=Date.UTC(2026,0,1);const dir=mkdtempSync(join(tmpdir(),'quota-test-'));return {dir,q:new Quota(dir,{[provider]:{minute:limit,hour:limit,day:limit,month:limit}},()=>now),tick:n=>now+=n};}
test('durable reservations enforce budget after restart and reset calendar windows',()=>{const {q,dir,tick}=fixture();q.reserve(provider,account);new Quota(dir,{[provider]:{minute:2,hour:2,day:2,month:2}} ,()=>Date.UTC(2026,0,1)).reserve(provider,account);assert.throws(()=>q.reserve(provider,account),/budget/);tick(32*86400000);q.reserve(provider,account);assert.equal(q.getStats()[0].used,1);});
test('429 Retry-After persists and account partitions do not leak keys',()=>{const {q,dir,tick}=fixture(10);q.reserve(provider,account);q.observe(provider,account,429,'120');assert.throws(()=>q.reserve(provider,account),/budget/);q.reserve(provider,'b'.repeat(64));tick(121000);q.reserve(provider,account);const text=readFileSync(join(dir,'quota.json'),'utf8');assert(!text.includes('secret'));assert.equal(q.getStats()[0].accounts,2);assert.equal(q.getStats()[0].usedHour,3);assert.notEqual(requestIdentity(new URL('https://example.com/?key=secret')).account,requestIdentity(new URL('https://example.com/?key=other')).account);});
test('corruption and concurrent process lock fail closed',()=>{const {q,dir}=fixture();writeFileSync(join(dir,'quota.json'),'{}');assert.throws(()=>q.reserve(provider,account),/corrupt/);const f=fixture();mkdirSync(join(f.dir,'quota.lock'));assert.throws(()=>f.q.reserve(provider,account),/locked/);});
test('simultaneous reservations never overspend and clock rollback fails',async()=>{const {q,tick}=fixture(3);const results=await Promise.allSettled(Array.from({length:20},async()=>q.reserve(provider,account)));assert.equal(results.filter(x=>x.status==='fulfilled').length,3);tick(-60000);assert.throws(()=>q.reserve(provider,account),/backwards/);});

test('representation headers cannot multiply account quota; credentials partition',()=>{const u=new URL('https://example.com/?key=secret');assert.equal(requestIdentity(u,{Accept:'json'}).account,requestIdentity(u,{Accept:'xml'}).account);assert.notEqual(requestIdentity(u,{Authorization:'a'}).account,requestIdentity(u,{Authorization:'b'}).account);});
test('hour caps independent of day; unavailable stats safe and circuit after server failures',()=>{const {dir,tick}=fixture();const q=new Quota(dir,{[provider]:{minute:10,hour:1,day:100,month:100}},()=>Date.UTC(2026,0,1));q.reserve(provider,account);assert.throws(()=>q.reserve(provider,account),/budget/);assert.equal(q.getStats()[0].remainingHour,0);assert.equal(q.getStats()[0].blocked,true);writeFileSync(join(dir,'quota.json'),'broken');assert.equal(q.getStats()[0].provider,'state-unavailable');assert.throws(()=>q.reserve(provider,account),/corrupt/);});
test('actual child processes share durable state and cannot exceed allowance',async()=>{
  const {spawn}=await import('node:child_process');const {pathToFileURL}=await import('node:url');const {resolve}=await import('node:path');
  const {dir}=fixture();const module=pathToFileURL(resolve(process.env.WEATHER_BUILD_ROOT??'build','quota.js')).href;
  const code=`import {Quota} from ${JSON.stringify(module)}; const q=new Quota(${JSON.stringify(dir)},{'example.com':{minute:2,hour:2,day:2,month:2}}); try {q.reserve('example.com','${account}');process.exitCode=0;}catch {process.exitCode=2;}`;
  const results=await Promise.all(Array.from({length:12},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});child.once('error',reject);child.once('exit',resolve);})));assert(results.filter(n=>n===0).length<=2);assert(results.some(n=>n===0));const state=JSON.parse(readFileSync(join(dir,'quota.json'),'utf8'));assert(Object.values(state.entries)[0].counts.every(n=>n<=2));
});
test('HTTP-date Retry-After and server-error circuit survive restart',()=>{let now=Date.UTC(2026,0,1);const {dir}=fixture();const q=new Quota(dir,{},()=>now);q.reserve(provider,account);q.observe(provider,account,503,new Date(now+60000).toUTCString());assert.throws(()=>new Quota(dir,{},()=>now).reserve(provider,account),/budget/);now+=61000;new Quota(dir,{},()=>now).reserve(provider,account);});
test('minute and hour windows cannot double spend across UTC boundaries',()=>{let now=Date.UTC(2026,0,1,0,59,59);const {dir}=fixture();const q=new Quota(dir,{[provider]:{minute:2,hour:2,day:100,month:100}},()=>now);q.reserve(provider,account);q.reserve(provider,account);now+=2000;assert.throws(()=>q.reserve(provider,account),/budget/);now+=60000;assert.throws(()=>q.reserve(provider,account),/budget/);now+=3600000;q.reserve(provider,account);now-=1;assert.throws(()=>q.reserve(provider,account),/backwards/);});

test('Open-Meteo variable and duration cost is conservatively reserved in one transaction',()=>{
 const a=requestIdentity(new URL('https://api.open-meteo.com/v1/forecast?current=a,b,c,d,e,f,g,h,i,j,k&daily=a,b,c,d,e,f,g,h,i,j,k&forecast_days=7'));
 assert.equal(a.cost,3);const {q}=fixture(4);q.reserve(provider,account,a.cost);assert.equal(q.getStats()[0].used,3);assert.throws(()=>q.reserve(provider,account,a.cost),/budget/);assert.equal(q.getStats()[0].used,3);
 assert.equal(requestIdentity(new URL('https://api.open-meteo.com/v1/forecast?hourly=a&forecast_days=28')).cost,2);
 assert.throws(()=>q.reserve(provider,account,-1),/cost/);
});

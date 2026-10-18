import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const moduleUrl = pathToFileURL(resolve(process.env.WEATHER_BUILD_ROOT ?? 'build', 'cache.js')).href;
const { Cache } = await import(moduleUrl);

test('100 concurrent users share one fetch; independent keys are bounded; failures do not poison the key', async () => {
  for (const users of [1,10,100]) {
  const cache = new Cache(2, 1); let calls = 0, release;
  const work = () => { calls++; return new Promise(r => release = r); };
  const jobs = Array.from({length: users}, () => cache.getOrFetch('same', work));
  await Promise.resolve();
  await assert.rejects(cache.getOrFetch('other', work), /capacity/);
  release({temperature: 0});
  assert.equal((await Promise.all(jobs)).length, users); assert.equal(calls, 1);
  await assert.rejects(cache.getOrFetch('fail', async () => {throw Error('failure');}), /failure/);
  assert.equal(await cache.getOrFetch('fail', async () => 42), 42);
  assert.equal(cache.getStats().inflight, 0);
  console.log(JSON.stringify({users,upstreamCalls:calls}));
 }
});

test('byte and entry LRU bounds evict weather without evicting protected metadata; oversize values bypass storage', async () => {
  const cache = new Cache(2, 5, {maxBytes: 350, metadataMaxEntries: 2, metadataMaxBytes: 350});
  await cache.getOrFetch('station:TEST', async () => ({lat: 1}), 10000);
  await cache.getOrFetch('first', async () => 'a'.repeat(90));
  await cache.getOrFetch('second', async () => 'b'.repeat(90));
  await cache.getOrFetch('first', () => assert.fail('recent entry must hit'));
  await cache.getOrFetch('third', async () => 'c'.repeat(90));
  await cache.getOrFetch('station:TEST', () => assert.fail('metadata must survive weather flood'));
  let calls = 0;
  await cache.getOrFetch('second', async () => {calls++; return 'reloaded';}); assert.equal(calls, 1);
  await cache.getOrFetch('huge', async () => 'x'.repeat(1000));
  await cache.getOrFetch('huge', async () => {calls++; return 1;}); assert.equal(calls, 2);
  assert.ok(cache.getStats().bytes <= 700);
  await cache.getOrFetch('station:A', async () => 1); await cache.getOrFetch('station:B', async () => 2);
  assert.equal(cache.getStats().metadataEntries, 2);
});

test('expiration never serves stale warnings; zero TTL does not cache; cycles do not break responses', async () => {
  const cache = new Cache(); const original = Date.now; let clock = original(); Date.now = () => clock;
  try {
    await cache.getOrFetch('warn:fmi:all', async () => 'expired warning', 10); clock += 11;
    assert.equal(await cache.getOrFetch('warn:fmi:all', async () => 'fresh warning', 10), 'fresh warning');
    await cache.getOrFetch('none', async () => 'old', 0);
    assert.equal(await cache.getOrFetch('none', async () => 'new', 0), 'new');
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(await cache.getOrFetch('cyclic', async () => cyclic), cyclic);
    assert.equal(await cache.getOrFetch('cyclic', async () => 4), 4);
  } finally {Date.now = original;}
});

test('private restart state reuses only unexpired safe data, rejects secrets, corrupt/oversize/symlink/public files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weather-cache-state-')), file = join(dir, 'state.json');
  const options = {persistPath: file, maxBytes: 1024, metadataMaxBytes: 1024};
  const cache = new Cache(10, 5, options);
  await cache.getOrFetch('station:ABCD', async () => ({name:'airport', lat:1}), 60000);
  await cache.getOrFetch('openmeteo:current:1,2', async () => ({temperature: 0, time:'2026-10-18T01:00'}), 60000);
  await cache.getOrFetch('syke:normal:Vedenkorkeus:1:10-18', async () => [{Arvo: 12}], 60000);
  await cache.getOrFetch('syke:stations:1', async () => [{id:1,name:'Public station',lat:60,lon:24}], 60000);
  await cache.getOrFetch('syke:offset:1', async () => [{Korkeustaso_Id:5,Tasokorjaus:100}], 60000);
  await cache.getOrFetch('obs:dmi:stations',async()=>[{id:1}],60000);
  await cache.getOrFetch('road:stations',async()=>[{id:2}],60000);
  await cache.getOrFetch('warn:all', async () => 'do not persist', 60000);
  await cache.getOrFetch('openmeteo:secret', async () => ({apiKey:'DO_NOT_STORE'}), 60000);
  await cache.getOrFetch('openmeteo:url', async () => ({url:'https://host/?apikey=DO_NOT_STORE'}), 60000);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const state = readFileSync(file, 'utf8'); assert.doesNotMatch(state, /DO_NOT_STORE|warn:all/);
  const childEnv = {...process.env}; delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {Cache}=await import(${JSON.stringify(moduleUrl)});
    const c=new Cache(10,5,${JSON.stringify(options)});
    const result=await c.getOrFetch('station:ABCD',()=>assert.fail('restart made upstream call'));
    assert.equal(result.lat,1);
    for (const k of ['obs:dmi:stations','road:stations','syke:normal:Vedenkorkeus:1:10-18','syke:stations:1','syke:offset:1']) assert.ok(await c.getOrFetch(k,()=>assert.fail('metadata restart call')));
    console.log('RESTART_CACHE_REUSED');
  `], {encoding:'utf8',env:childEnv});
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /RESTART_CACHE_REUSED/);
  for (const text of ['not json', 'x'.repeat(70000), JSON.stringify([['station:expired',{value: 1,expiresAt:0}]]), JSON.stringify([['station:infinite',{value:1,expiresAt:1e30}]])]) {
    writeFileSync(file, text, {mode:0o600}); const c = new Cache(10,5,options); assert.equal(c.getStats().entries,0);
  }
  writeFileSync(file, state); chmodSync(file,0o644); assert.equal(new Cache(10,5,options).getStats().entries,0);
  chmodSync(file,0o600); symlinkSync(file, join(dir,'link')); assert.equal(new Cache(10,5,{...options,persistPath:join(dir,'link')}).getStats().entries,0);
});

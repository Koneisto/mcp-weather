// Finnish lakes (1.3.0): Syke water level, surface water temperature and ice. Offline: syke-recorded.json holds real Syke
// responses from 15 Oct 2026 (station lists trimmed to the lakes used here), replayed by URL; the clock is fixed to that evening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/syke-recorded.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-15T17:10:00Z');
process.env.MCP_WEATHER_KEY_NOTE = 'off';
const S = await import('../build/sources/syke.js');
const { createMcpServer } = await import('../build/server.js');

function offline() {
  const realFetch = globalThis.fetch, realNow = Date.now, calls = [];
  globalThis.fetch = async (u) => {
    u = String(u); calls.push(u);
    if (u in RECORDED) return new Response(RECORDED[u], { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('ymparisto.fi')) return new Response('{"value":[]}', { status: 200 });   // stations left out of the trimmed lists
    throw new Error(`network disabled in test: ${u}`);
  };
  Date.now = () => NOW;
  return { calls, restore: () => { globalThis.fetch = realFetch; Date.now = realNow; } };
}
async function client() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(b);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(a);
  return c;
}

test('Syke names and coordinates: DDMMSS, lake notes, basins, filing errors, normals, ice', () => {
  assert.ok(Math.abs(S.dms('613001') - 61.50028) < 1e-4);
  assert.ok(Number.isNaN(S.dms(null)) && Number.isNaN(S.dms('61300')));
  assert.deepEqual(S.lakeName('Haukivesi (Saimaa N60+75.80)'), { lake: 'Haukivesi', partOf: 'Saimaa' });
  assert.deepEqual(S.lakeName('Päijänne (etel. N60+78.10)'), { lake: 'Päijänne', partOf: undefined });
  assert.deepEqual(S.lakeName('Kallavesi (N60 81.70)'), { lake: 'Kallavesi', partOf: undefined });
  assert.deepEqual(S.lakeName('Inarijärvi l. Anarjävri'), { lake: 'Inarijärvi', partOf: undefined });

  const st = S.toStations([
    { Paikka_Id: 1, Nimi: 'Kallavesi, Itkonniemi', JarviNimi: 'Kallavesi (N60 81.70)', KoordLat: '625200', KoordLong: '274000' },
    { Paikka_Id: 2, Nimi: 'Pyhävesi, Mäntyharju', JarviNimi: 'Kallavesi', KoordLat: '612500', KoordLong: '264900' },
    { Paikka_Id: 3, Nimi: 'Naapuskoski, ylävesi', JarviNimi: 'Kallavesi (N60 81.70)', KoordLat: '624000', KoordLong: '275500' },
    { Paikka_Id: 4, Nimi: 'Haukivesi, Oravi', JarviNimi: 'Haukivesi (Saimaa N60+75.80)', KoordLat: '620000', KoordLong: '285000' },
  ]);
  assert.deepEqual(S.byLakeName(st, 'kallavesi').map((s) => s.id), [1, 3], 'Pyhävesi 150 km away is a filing error');
  assert.deepEqual(S.byLakeName(st, 'Saimaa').map((s) => s.id), [4], 'a basin of Saimaa');

  const rows = (vals) => vals.map((v, i) => ({ Paikka_Id: 1, Aika: `${1990 + i}-10-14T00:00:00`, Arvo: v }));
  assert.equal(S.normalOf(rows([1, 2, 3, 4]), 1990, 2025), undefined, 'fewer than 5 years is no normal');
  assert.deepEqual(S.normalOf(rows([300, 310, 320, 330, 340, 999]), 1990, 1994), { mean: 320, min: 300, max: 340, years: 5, fromYear: 1990, toYear: 1994 });

  const day = '2026-02-10T00:00:00';
  assert.deepEqual(S.iceOf([{ Aika: day, Arvo: 45, Lippu_Id: 41 }, { Aika: day, Arvo: 12, Lippu_Id: 37 }, { Aika: '2026-01-20T00:00:00', Arvo: 30, Lippu_Id: 41 }]),
    { date: '2026-02-10', thicknessCm: 45, snowCm: 12, weak: false });
  assert.equal(S.iceOf([{ Aika: day, Arvo: 0, Lippu_Id: 43 }]).weak, true);
});

test('get_lake_conditions "Saimaa": level with N2000 height and 30-year normal, basins, water temperature', async () => {
  const net = offline();
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_lake_conditions', arguments: { location: 'Saimaa' } });
    const t = r.content[0].text;
    assert.equal(r.isError, undefined, t);
    assert.match(t, /^Lake conditions for Saimaa$/m);
    assert.match(t, /^Water level at Saimaa, Lauritsala, 14 Oct: 75,74 m above sea level \(N2000\), 317 cm on the gauge · ±0 cm in a week$/m);
    assert.match(t, /^ {2}28 cm below the normal for 14 Oct, 345 cm \(1996–2025, range 291–414 cm\)$/m);
    assert.match(t, /^Water level at Saimaa, Ristiina, 15 Oct: 75,77 m/m);
    assert.match(t, /^Water level at Haukivesi, Oravi \(part of Saimaa\), 14 Oct: 75,85 m/m);
    assert.match(t, /^Surface water temperature at Saimaa, Lauritsala, 14 Oct: 11,6 °C$/m);
    assert.match(t, /^ {2}1,6 °C warmer than the normal for 14 Oct, 10 °C \(1996–2025/m);
    assert.match(t, /Source: Finnish Environment Institute \(Syke\), CC BY 4\.0/);
    const lv = r.structuredContent.waterLevels[0];
    assert.deepEqual([lv.station, lv.cm, lv.n2000M, lv.fromNormalCm, lv.normal.years], ['Saimaa, Lauritsala', 317, 75.74, -28, 30]);
    assert.ok(!net.calls.some((u) => u.includes('open-meteo')), 'a lake name needs no geocoding');
  } finally { net.restore(); }
});

test('get_lake_conditions by place: nearest station in Finland; outside Finland an error', async () => {
  const net = offline();
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '61.4964,27.2694' } });
    assert.match(r.content[0].text, /^Water level at Saimaa, Ristiina, [\d,]+ km away, 15 Oct: 75,77 m above sea level/m);
    assert.equal(r.structuredContent.waterLevels.length, 1);
    const se = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '59.3293,18.0686' } });
    assert.equal(se.isError, true);
    assert.match(se.content[0].text, /covers Finland/);
  } finally { net.restore(); }
});

// Finnish lakes (1.3.0): Syke water level, surface water temperature and ice. Offline: syke-recorded.json holds real Syke
// responses from 16 Oct 2026 (station lists trimmed to the lakes used here), replayed by URL; the clock is fixed to that morning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const RECORDED = Object.fromEntries(Object.entries(JSON.parse(readFileSync(new URL('./fixtures/syke-recorded.json', import.meta.url), 'utf8'))).map(([url,body])=>[new URL(url).href,body]));
const NOW = Date.parse('2026-10-16T09:05:00Z');
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
    assert.match(t, /^Water level at Saimaa, Lauritsala, 15 Oct: 75,74 m above sea level \(N2000\), 317 cm on the gauge · \+1 cm in a week$/m);
    assert.match(t, /^ {2}28 cm below the normal for 15 Oct, 345 cm \(1996–2025, range 293–414 cm\)$/m);
    assert.match(t, /^Water level at Saimaa, Ristiina, 16 Oct: 75,77 m/m);
    assert.match(t, /^Water level at Haukivesi, Oravi \(part of Saimaa\), 15 Oct: 75,85 m/m);
    assert.match(t, /^Surface water temperature at Saimaa, Lauritsala, 15 Oct: 10,9 °C$/m);
    assert.match(t, /^ {2}1 °C warmer than the normal for 15 Oct, 9,9 °C \(1996–2025/m);
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
    assert.match(r.content[0].text, /^Water level at Saimaa, Ristiina, [\d,]+ km away, 16 Oct: 75,77 m above sea level/m);
    assert.equal(r.structuredContent.waterLevels.length, 1);
    const se = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '59.3293,18.0686' } });
    assert.equal(se.isError, true);
    assert.match(se.content[0].text, /covers Finland/);
  } finally { net.restore(); }
});

test('get_lake_conditions at Kekinkallio (Ristiina): Saimaa temperature from Lauritsala over a nearer other lake; ice station out of season', async () => {
  const net = offline();
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '61.5295,27.3607' } });
    const t = r.content[0].text;
    assert.match(t, /^Water level at Saimaa, Ristiina, 6 km away, 16 Oct: 75,77 m above sea level \(N2000\)/m);
    assert.match(t, /^Surface water temperature at Saimaa, Lauritsala, 70 km away, 15 Oct: 10,9 °C$/m, 'Saimaa, not Kyyvesi 54 km away');
    assert.match(t, /^Ice is measured in winter at Saimaa, Lauritsala \(69,6 km away\); latest measurement 19 Mar$/m,
      'Yövesi, Kissalahti 5 km away last measured in 2024 and is skipped');
    assert.equal(r.structuredContent.iceStationOutOfSeason.station, 'Saimaa, Lauritsala');
    assert.deepEqual(r.structuredContent.ice, []);
  } finally { net.restore(); }
});

test('get_lake_conditions days=30: daily history of the level (with N2000) and the water temperature, oldest first', async () => {
  const net = offline();
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '61.5295,27.3607', days: 30 } });
    const lv = r.structuredContent.waterLevels[0], tw = r.structuredContent.waterTemperatures[0];
    assert.equal(lv.history.length, 31);
    assert.deepEqual(lv.history[0], { date: '2026-09-16', cm: lv.history[0].cm, n2000M: Math.round(7262 + lv.history[0].cm) / 100 });   // gauge offset 7577 − 315 cm
    assert.deepEqual(lv.history.at(-1), { date: '2026-10-16', cm: 315, n2000M: 75.77 });
    assert.ok(lv.history.every((h, i, a) => i === 0 || a[i - 1].date < h.date), 'oldest first');
    assert.ok(tw.history.length >= 28 && tw.history.at(-1).celsius === 10.9);
    assert.match(r.content[0].text, /^ {2}Last 30 days: lowest \d+ cm, highest \d+ cm \(31 daily values\)$/m);
    const plain = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '61.5295,27.3607' } });
    assert.equal(plain.structuredContent.waterLevels[0].history, undefined, 'no history unless asked');
  } finally { net.restore(); }
});

// 18.10.2026: is an old value "missing" (the station normally measures today, data has stopped) or "off season"
// (water temperature is not measured in winter)? Decided from the last 10 years: years with a value on today's date
// against years with a value at mid-summer.
test('reading status: current, missing, off season', () => {
  const NOW_ = Date.parse('2027-01-15T09:00:00Z');
  assert.equal(S.ageDaysOf('2027-01-15', NOW_), 0);
  assert.equal(S.ageDaysOf('2026-12-23', NOW_), 23);
  const yrs = (md, ys) => ys.map((y) => ({ Paikka_Id: 1, Aika: `${y}-${md}T00:00:00`, Arvo: 5 }));
  const ref = yrs('07-15', [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  assert.equal(S.seasonShare([], ref, 2017, 2026), 0, 'mid-January: never measured');
  assert.equal(S.seasonShare(yrs('12-05', [2021, 2023, 2024, 2025]), ref, 2017, 2026), 0.4);
  assert.equal(S.seasonShare(yrs('10-20', [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]), ref, 2017, 2026), 1);
  assert.equal(S.seasonShare([], yrs('07-15', [2025, 2026]), 2017, 2026), undefined, 'two years of record cannot tell the season');
  assert.equal(S.statusOf(3, 0), 'current', 'daily values: three days old is still current');
  assert.equal(S.statusOf(4, 1), 'missing');
  assert.equal(S.statusOf(23, 0), 'off_season');
  assert.equal(S.statusOf(10, 0.4), 'off_season', 'measured on this day in fewer than half of the years');
  assert.equal(S.statusOf(10, undefined), 'missing', 'unknown season: an old value is not passed off as winter');
});

// Recorded data (latest temperature 15 Oct 2026, level 16 Oct) seen from later dates. The same-day queries for the
// season are answered here: Lauritsala measured water temperature on 15 Jul and 5 Nov in all ten years, on 15 Jan never.
function later(iso) {
  const net = offline(), recorded = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = decodeURIComponent(String(u));
    const m = /LampoPintavesi\?\$filter=Paikka_Id eq (\d+) and month\(Aika\) eq (\d+) and day\(Aika\) eq (\d+) and year\(Aika\) ge (\d+)/.exec(s);
    if (m && s.includes('$select=Aika,Arvo') && !s.includes('ge 19')) {
      const [, , mo, d, from] = m.map(Number);
      const value = mo === 1 ? [] : Array.from({ length: 10 }, (_, i) => ({ Paikka_Id: 1667, Aika: `${from + i}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00`, Arvo: 8 }));
      return new Response(JSON.stringify({ value }), { status: 200 });
    }
    return recorded(u);
  };
  Date.now = () => Date.parse(iso);
  return net;
}

test('get_lake_conditions in winter: water temperature off season, not missing', async () => {
  const net = later('2027-01-15T09:00:00Z');
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_lake_conditions', arguments: { location: 'Saimaa' } });
    const tw = r.structuredContent.waterTemperatures[0];
    assert.deepEqual([tw.station, tw.date, tw.status, tw.ageDays], ['Saimaa, Lauritsala', '2026-10-15', 'off_season', 92]);
    assert.match(r.content[0].text, /10,9 °C \(last measurement of the open-water season; not measured at this time of year\)$/m);
    assert.deepEqual(r.structuredContent.waterLevels, [], 'a level 92 days old is a gauge that has stopped: left out');
    const near = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '61.5295,27.3607' } });
    assert.deepEqual(near.structuredContent.waterTemperatures.map((x) => [x.station, x.status]), [['Saimaa, Lauritsala', 'off_season']],
      'by place: the stopped gauge still names Saimaa, so its temperature station is used');
  } finally { net.restore(); }
});

test('get_lake_conditions with data stopped in season: water temperature and level missing, not hidden', async () => {
  const net = later('2026-11-05T09:00:00Z');
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_lake_conditions', arguments: { location: 'Saimaa' } });
    const t = r.content[0].text, tw = r.structuredContent.waterTemperatures[0], lv = r.structuredContent.waterLevels[0];
    assert.deepEqual([tw.status, tw.ageDays], ['missing', 21]);
    assert.match(t, /10,9 °C \(no new value from Syke for 21 days although it is normally measured at this time of year\)$/m);
    assert.deepEqual([lv.station, lv.status, lv.ageDays], ['Saimaa, Lauritsala', 'missing', 21]);
    assert.match(t, /^Water level: no new value from Syke for 21 days \(the gauge reports daily\); the latest is shown\.$/m);
  } finally { net.restore(); }
});

test('fresh values are current', async () => {
  const net = offline();
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_lake_conditions', arguments: { location: '61.5295,27.3607' } });
    assert.deepEqual([r.structuredContent.waterLevels[0].status, r.structuredContent.waterLevels[0].ageDays], ['current', 0]);
    assert.deepEqual([r.structuredContent.waterTemperatures[0].status, r.structuredContent.waterTemperatures[0].ageDays], ['current', 1]);
    assert.doesNotMatch(r.content[0].text, /no new value|not measured at this time/);
  } finally { net.restore(); }
});

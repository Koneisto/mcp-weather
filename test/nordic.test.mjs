// Nordic features (1.1.0): country of a point, official warnings (FMI, SMHI, MET Norway, MeteoAlarm), radar nowcast,
// aurora forecast, MET Nordic forecast model, pollen, and the MET Norway client rules (User-Agent, 4 decimals, Expires,
// If-Modified-Since). Offline: fixtures are real responses from 14–15 Oct 2026; the clock is fixed to that night.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-15T00:00:00Z');
const { createMcpServer } = await import('../build/server.js');
const { countryOf, inNordicArea } = await import('../build/utils/region.js');
const W = await import('../build/sources/warnings.js');
const { kpNeeded } = await import('../build/sources/space-weather.js');
const { auroraChance } = await import('../build/tools/aurora.js');
const { metGet, clearMetStore } = await import('../build/sources/met-norway.js');
const { cache } = await import('../build/cache.js');

/** Offline network: routes by URL to fixtures; records requests (url + headers). */
function offline(extra = () => undefined) {
  const realFetch = globalThis.fetch, realNow = Date.now, calls = [];
  globalThis.fetch = async (u, init = {}) => {
    u = String(u); calls.push({ url: u, headers: init.headers ?? {} });
    const r = extra(u, init);
    if (r) return r;
    const json = (s, h = {}) => new Response(s, { status: 200, headers: { 'content-type': 'application/json', ...h } });
    if (u.startsWith('https://alerts.fmi.fi/cap/feed/')) return new Response(fx('fmi-cap-atom.xml'), { status: 200 });
    if (u.startsWith('https://opendata-download-warnings.smhi.se/')) return json(fx('smhi-warnings.json'));
    if (u.includes('feeds-latvia')) return json(fx('meteoalarm-latvia.json'));
    if (u.includes('feeds-denmark')) return json(fx('meteoalarm-denmark.json'));
    if (u.startsWith('https://api.met.no/weatherapi/metalerts/')) return json(fx('met-metalerts.json'), { expires: new Date(NOW + 600000).toUTCString() });
    if (u.startsWith('https://api.met.no/weatherapi/nowcast/')) return json(fx('nowcast-bergen.json'), { expires: new Date(NOW + 180000).toUTCString() });
    if (u.startsWith('https://space.fmi.fi/')) return json(fx('fmi-rindex.json'));
    if (u.startsWith('https://services.swpc.noaa.gov/')) return json(fx('kp-forecast.json'));
    if (u.startsWith('https://api.open-meteo.com/v1/forecast') && u.includes('hourly=cloud_cover')) {
      // Tromsø, Europe/Oslo (UTC+2): local hours from 02:00, 20 % cloud
      const times = Array.from({ length: 30 }, (_, i) => new Date(NOW + (i + 2) * 3600000).toISOString().slice(0, 16));
      return json(JSON.stringify({ timezone: 'Europe/Oslo', hourly: { time: times, cloud_cover: times.map(() => 20) } }));
    }
    if (u.startsWith('https://api.open-meteo.com/v1/forecast') && u.includes('daily=')) {
      return json(JSON.stringify({ timezone: 'Europe/Oslo', daily: { time: ['2026-10-15'], temperature_2m_max: [14.2], temperature_2m_min: [9.5], weather_code: [3], precipitation_sum: [0],
        precipitation_probability_max: [50], wind_speed_10m_max: [7.9], wind_direction_10m_dominant: [180], uv_index_max: [0.8], sunrise: ['2026-10-15T07:55'], sunset: ['2026-10-15T18:08'] } }));
    }
    if (u.startsWith('https://air-quality-api.open-meteo.com/')) {
      return json(JSON.stringify({ current: { european_aqi: 20, pm2_5: 4.9, pm10: 6.6, nitrogen_dioxide: 5.2, ozone: 51, sulphur_dioxide: 0.9, carbon_monoxide: 169,
        alder_pollen: 0, birch_pollen: 150.4, grass_pollen: 5, mugwort_pollen: 0.4, ragweed_pollen: null } }));
    }
    throw new Error('network disabled in test');
  };
  Date.now = () => NOW;
  return { calls, restore: () => { globalThis.fetch = realFetch; Date.now = realNow; } };
}

async function client() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(b);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(a);
  await c.listTools();
  return c;
}

test('country of a point: capitals, islands, border towns, coast; not Kaliningrad, Berlin or the open sea', () => {
  const P = { Helsinki: [60.1699, 24.9384, 'FI'], Mariehamn: [60.0973, 19.9348, 'FI'], Stockholm: [59.3293, 18.0686, 'SE'], Oslo: [59.9139, 10.7522, 'NO'],
    Tromso: [69.6492, 18.9553, 'NO'], Copenhagen: [55.6761, 12.5683, 'DK'], Bornholm: [55.1, 14.92, 'DK'], Reykjavik: [64.1466, -21.9426, 'IS'],
    Tallinn: [59.437, 24.7536, 'EE'], Riga: [56.9496, 24.1052, 'LV'], Vilnius: [54.6872, 25.2797, 'LT'], Klaipeda: [55.7033, 21.1443, 'LT'],
    Haparanda: [65.8355, 24.1368, 'SE'], Tornio: [65.85, 24.165, 'FI'], Kilpisjarvi: [69.05, 20.79, 'FI'], Longyearbyen: [78.22, 15.65, 'NO'],
    Berlin: [52.52, 13.4, null], Kaliningrad: [54.71, 20.51, null], OpenSea: [58.0, 20.0, null] };
  for (const [n, [lat, lon, want]] of Object.entries(P)) assert.equal(countryOf(lat, lon), want, n);
  assert.equal(inNordicArea(58.0, 20.0), true, 'Baltic Sea counts for the forecast model');
  assert.equal(inNordicArea(48.85, 2.35), false, 'Paris');
});

test('warning parsers: FMI CAP by polygon and language, SMHI by GeoJSON, MetAlerts levels, MeteoAlarm without green and expired', () => {
  const atom = fx('fmi-cap-atom.xml');
  const en = W.parseFmiCap(atom, 63.096, 21.616, 'en', NOW);
  assert.deepEqual(en.map((w) => [w.level, w.event, w.area]), [['yellow', 'Wind warning for land areas', 'Ostrobothnia']]);
  assert.equal(W.parseFmiCap(atom, 63.096, 21.616, 'fi', NOW)[0].event, 'Tuulivaroitus maa-alueille');
  assert.equal(W.parseFmiCap(atom, 60.17, 24.94, 'en', NOW).length, 0, 'Helsinki is outside the polygons');
  assert.equal(W.parseFmiCap(atom, 63.096, 21.616, 'en', Date.parse('2026-10-17T00:00:00Z')).length, 0, 'expired');
  const sm = W.parseSmhi(JSON.parse(fx('smhi-warnings.json')), 55.6, 13.0, 'en', NOW);
  assert.ok(sm.some((w) => w.area === 'Skåne län' && w.level === 'info'), JSON.stringify(sm.map((w) => w.area)));
  assert.equal(W.parseSmhi(JSON.parse(fx('smhi-warnings.json')), 67.85, 20.22, 'en', NOW).filter((w) => w.area === 'Skåne län').length, 0, 'Kiruna is not in Skåne');
  const ma = W.parseMetAlerts(JSON.parse(fx('met-metalerts.json')), NOW);
  assert.ok(ma.length === 2 && ma.every((w) => w.level === 'yellow'), JSON.stringify(ma));
  const lv = W.parseMeteoAlarm(JSON.parse(fx('meteoalarm-latvia.json')), NOW);
  assert.ok(lv.length >= 1 && lv.every((w) => w.level === 'yellow'), 'expired orange dropped: ' + JSON.stringify(lv.map((w) => [w.level, w.expires])));
  assert.equal(W.parseMeteoAlarm(JSON.parse(fx('meteoalarm-denmark.json')), NOW).length, 0, 'green "Minor" entries are not warnings');
});

test('get_weather_warnings: point match in Finland, country list in Latvia, refusal outside the region', async () => {
  const net = offline();
  try {
    const c = await client();
    let r = await c.callTool({ name: 'get_weather_warnings', arguments: { location: '63.096,21.616' } });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(r.structuredContent.country, 'Finland');
    assert.equal(r.structuredContent.coverage, 'point');
    assert.equal(r.structuredContent.warnings[0].event, 'Wind warning for land areas');
    assert.match(r.content[0].text, /^1 active weather warning for 63\.10,21\.62 \(Finland\):/);
    assert.match(r.content[0].text, /Source: FMI · Finnish Meteorological Institute, CC BY 4\.0/);
    r = await c.callTool({ name: 'get_weather_warnings', arguments: { location: '56.9496,24.1052' } });
    assert.equal(r.structuredContent.coverage, 'country');
    assert.match(r.content[0].text, /in Latvia \(the source does not publish area outlines/);
    assert.match(r.structuredContent.attribution, /EUMETNET/);
    r = await c.callTool({ name: 'get_weather_warnings', arguments: { location: '52.52,13.40' } });
    assert.equal(r.isError, true);
    await c.close();
  } finally { net.restore(); }
});

test('get_precipitation_nowcast: raining now, when it stops, heaviest and total; MET client rules', async () => {
  clearMetStore(); cache.clear?.();
  const net = offline();
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_precipitation_nowcast', arguments: { location: '60.391263,5.322054' } });
    assert.ok(!r.isError, r.content[0].text);
    const s = r.structuredContent;
    assert.equal(s.raining, true);
    assert.ok(s.endsAt && s.maxRate >= 1 && s.totalMm > 0, JSON.stringify({ endsAt: s.endsAt, maxRate: s.maxRate, totalMm: s.totalMm }));
    assert.match(r.content[0].text, /^Precipitation nowcast for /);
    const call = net.calls.find((x) => x.url.includes('/nowcast/'));
    assert.match(call.url, /lat=60\.3912&lon=5\.322(&|$)/, 'coordinates truncated to 4 decimals');
    assert.match(call.headers['User-Agent'], /^mcp-weather\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Koneisto\/mcp-weather\)$/);
    await c.close();
  } finally { net.restore(); }
});

test('nowcast outside the radar area: clear isError message (MET Norway answers 422)', async () => {
  clearMetStore();
  const net = offline((u) => u.includes('/nowcast/') && u.includes('lat=48.8566') ? new Response('{"error":"outside"}', { status: 422 }) : undefined);
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_precipitation_nowcast', arguments: { location: '48.8566,2.3522' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^Precipitation nowcast covers the Nordic radar area .* is outside it\. Use get_weather_forecast instead\.$/);
    await c.close();
  } finally { net.restore(); }
});

test('MET client: no request before Expires, then If-Modified-Since and 304 reuses the stored body', async () => {
  clearMetStore();
  let n = 0, t = NOW;
  const realFetch = globalThis.fetch, realNow = Date.now, seen = [];
  globalThis.fetch = async (u, init) => {
    n++; seen.push(init.headers);
    return n === 1 ? new Response('{"v":1}', { status: 200, headers: { expires: new Date(NOW + 60000).toUTCString(), 'last-modified': 'Wed, 14 Oct 2026 23:00:00 GMT' } })
      : new Response(null, { status: 304, headers: { expires: new Date(NOW + 180000).toUTCString() } });
  };
  Date.now = () => t;
  try {
    assert.deepEqual(await metGet('x/1.0', 60, 25), { v: 1 });
    t = NOW + 30000; assert.deepEqual(await metGet('x/1.0', 60, 25), { v: 1 }); assert.equal(n, 1, 'cached until Expires');
    t = NOW + 90000; assert.deepEqual(await metGet('x/1.0', 60, 25), { v: 1 }); assert.equal(n, 2);
    assert.equal(seen[1]['If-Modified-Since'], 'Wed, 14 Oct 2026 23:00:00 GMT');
  } finally { globalThis.fetch = realFetch; Date.now = realNow; clearMetStore(); }
});

test('aurora: Kp needed by latitude, cloud rules, and the tool in Tromsø', async () => {
  assert.equal(kpNeeded(70), 1);
  assert.ok(kpNeeded(60.17) > 4.5 && kpNeeded(60.17) < 5.5, String(kpNeeded(60.17)));
  assert.ok(kpNeeded(55.7) > kpNeeded(60.17));
  assert.equal(auroraChance(3, 1, 20), 'high');
  assert.equal(auroraChance(3, 1, 90), 'none', 'overcast blocks');
  assert.equal(auroraChance(3, 1, 60), 'moderate', 'half cloudy lowers one step');
  assert.equal(auroraChance(2, 5, 0), 'none');
  const net = offline();
  try {
    const c = await client();
    const r = await c.callTool({ name: 'get_aurora_forecast', arguments: { location: '69.6492,18.9553', hours: 24 } });
    assert.ok(!r.isError, r.content[0].text);
    const s = r.structuredContent;
    assert.equal(s.kpNeeded, 1);
    assert.ok(s.darkHours > 5 && s.chance === 'high', JSON.stringify({ dark: s.darkHours, chance: s.chance }));
    assert.equal(s.activityNow.station, 'Kilpisjärvi');
    assert.ok(s.hours.every((h) => h.cloudCover === 20));
    assert.match(r.content[0].text, /Dark enough: \d+ h \(\d\d:\d\d–\d\d:\d\d/);
    await c.close();
  } finally { net.restore(); }
});

test('forecast uses the MET Nordic model in the Nordic area only; pollen levels in air quality', async () => {
  const net = offline();
  try {
    const c = await client();
    let r = await c.callTool({ name: 'get_weather_forecast', arguments: { location: '59.9139,10.7522', days: 1 } });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(r.structuredContent.source, 'MET Norway MET Nordic model via Open-Meteo');
    assert.ok(net.calls.some((x) => x.url.includes('models=metno_seamless') && x.url.includes('latitude=59.9139')));
    r = await c.callTool({ name: 'get_weather_forecast', arguments: { location: '48.8566,2.3522', days: 1 } });
    assert.equal(r.structuredContent.source, 'Open-Meteo');
    assert.ok(!net.calls.some((x) => x.url.includes('latitude=48.8566') && x.url.includes('models=')));
    r = await c.callTool({ name: 'get_air_quality', arguments: { location: '59.3293,18.0686' } });
    assert.deepEqual(r.structuredContent.pollen.birch, { value: 150.4, level: 'high' });
    assert.deepEqual(r.structuredContent.pollen.grass, { value: 5, level: 'low' });
    assert.equal(r.structuredContent.pollen.mugwort.level, 'none');
    assert.equal(r.structuredContent.pollen.ragweed, undefined);
    assert.match(r.content[0].text, /Pollen: Birch high \(150,4 grains\/m³\), Grass low \(5 grains\/m³\)/);
    await c.close();
  } finally { net.restore(); }
});

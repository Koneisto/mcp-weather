// Marine conditions and Finnish road weather (1.2.0). Offline: fixtures are real responses from 15 Oct 2026 around
// 16:15 UTC (FMI, SMHI, DMI, Kartverket, MET Norway Oceanforecast, Open-Meteo Marine, Fintraffic Digitraffic); the clock is fixed to 16:20 UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-15T16:20:00Z');
process.env.MCP_WEATHER_KEY_NOTE = 'off';
const { createMcpServer } = await import('../build/server.js');
const M = await import('../build/sources/marine.js');
const R = await import('../build/sources/road-weather.js');

const HELSINKI = '60.1699,24.9384', OSLO = '59.9133,10.739', COPENHAGEN = '55.6761,12.5683', STOCKHOLM = '59.3293,18.0686', TAMPERE = '61.4978,23.761';

/** Offline network routed by URL; records requests. */
function offline() {
  const realFetch = globalThis.fetch, realNow = Date.now, calls = [];
  globalThis.fetch = async (u, init = {}) => {
    u = String(u); calls.push({ url: u, headers: init.headers ?? {} });
    const res = (s, type = 'application/json') => new Response(s, { status: 200, headers: { 'content-type': type } });
    if (u.includes('mareograph::timevaluepair')) return res(fx('marine-fmi-mareograph.xml'), 'text/xml');
    if (u.includes('wave::timevaluepair')) return res(fx('marine-fmi-wave.xml'), 'text/xml');
    if (u.includes('sealevel::point::simple')) return res(fx('marine-fmi-sealevel.xml'), 'text/xml');
    if (u.startsWith('https://opendata-download-ocobs.smhi.se/')) {
      const p = /\/parameter\/(\d+)\//.exec(u)[1];
      return res(JSON.stringify(JSON.parse(fx('marine-smhi.json'))[p]));
    }
    if (u.includes('/oceanObs/collections/station/')) return res(fx('marine-dmi-stations.json'));
    if (u.includes('/oceanObs/collections/observation/')) {
      const p = /parameterId=(\w+)/.exec(u)[1];
      const all = JSON.parse(fx('marine-dmi-obs.json'));
      return res(JSON.stringify({ features: all.features.filter((f) => f.properties.parameterId === p) }));
    }
    if (u.includes('tide_request=stationlist')) return res(fx('marine-kartverket-stations.xml'), 'text/xml');
    if (u.includes('tide_request=locationdata')) return res(fx('marine-kartverket-oslo.xml'), 'text/xml');
    if (u.startsWith('https://api.met.no/weatherapi/oceanforecast/')) return res(fx('marine-oceanforecast-oslo.json'));
    if (u.startsWith('https://marine-api.open-meteo.com/')) {
      if (u.includes('latitude=61.')) {   // inland Finland: the model has no sea there
        return res(JSON.stringify({ current: { time: '2026-10-15T16:15', wave_height: null, wave_direction: null, wave_period: null, sea_surface_temperature: null }, hourly: { time: [], wave_height: [] } }));
      }
      return res(fx('marine-openmeteo-helsinki.json'));
    }
    if (u === 'https://tie.digitraffic.fi/api/weather/v1/stations') return res(fx('road-stations.json'));
    const data = /\/stations\/(\d+)\/data$/.exec(u);
    if (data) return ['1002', '1041'].includes(data[1]) ? res(fx(`road-data-${data[1]}.json`)) : new Response('{}', { status: 404 });
    if (u.startsWith('https://tie.digitraffic.fi/api/weather/v1/forecast-sections/forecasts')) return res(fx('road-forecast-helsinki.json'));
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

test('FMI marine: mareograph mm → cm against the theoretical mean, buoy waves and water temperature, sea level forecast', () => {
  const pts = M.fmiMarinePoints(fx('marine-fmi-mareograph.xml'), fx('marine-fmi-wave.xml'));
  const kaivo = pts.find((p) => p.station === 'Helsinki Kaivopuisto');
  assert.deepEqual(kaivo.level, { cm: 30, time: '2026-10-15T16:00:00Z' });   // WATLEV 304 mm
  assert.equal(kaivo.temp.c, 10.8);
  assert.equal(kaivo.reference, 'theoretical mean sea level');
  const buoy = pts.find((p) => p.station === 'Helsinki Suomenlinna aaltopoiju');
  assert.deepEqual(buoy.wave, { hs: 0.5, dir: 189, per: 3.2, time: '2026-10-15T15:00:00Z' });
  assert.equal(pts.find((p) => p.station === 'Pori Kaijakari').wave, undefined, 'buoy station with water temperature only');
  const fc = M.parseFmiSeaLevel(fx('marine-fmi-sealevel.xml'));
  assert.equal(fc.length, 20, 'SeaLevel only, not SeaLevelN2000');
  assert.deepEqual(M.forecastRange(fc, NOW).high, { time: '2026-10-15T17:00:00Z', cm: 35 });
});

test('SMHI, DMI and Kartverket: national references, suspect values skipped, Kartverket times to UTC', () => {
  const se = M.smhiMarinePoints(JSON.parse(fx('marine-smhi.json')));
  assert.deepEqual(se.find((p) => p.station === 'Stockholm-Skeppsholmen').level, { cm: 28, time: '2026-10-15T14:00:00Z' });
  const bro = se.find((p) => p.station === 'Brofjorden Vågboj').wave;
  assert.equal(bro.hs, 1.56); assert.equal(Math.round(bro.dir), 246); assert.equal(bro.per, 9.07);
  const suspect = M.smhiMarinePoints({ 6: { station: [{ key: '1', name: 'X', latitude: 59, longitude: 18, value: [{ date: NOW, value: 99, quality: 'Y' }] }] } });
  assert.equal(suspect[0]?.level, undefined, 'quality Y is not used');

  const dk = M.dmiMarinePoints(JSON.parse(fx('marine-dmi-stations.json')), JSON.parse(fx('marine-dmi-obs.json')));
  assert.deepEqual(dk.find((p) => p.station === 'Københavns Havn').level, { cm: 17, time: '2026-10-15T16:10:00Z' });
  assert.ok(dk.every((p) => p.reference === 'DVR90'));

  const kv = M.parseKartverket(fx('marine-kartverket-oslo.xml'));
  assert.deepEqual(kv.observation.at(-1), { time: '2026-10-15T16:00:00Z', cm: 33 });   // 17:00+01:00 in the response
  assert.ok(kv.forecast.length > 30);
  assert.equal(M.parseKartverketStations(fx('marine-kartverket-stations.xml')).find((s) => s.code === 'OSL').name, 'Oslo');
});

test('wave models: Open-Meteo rounded and its 24 h max never below now; land point gives no model; Oceanforecast', () => {
  // the 24 h maximum counts from now, so the clock is fixed to the recording (with the real clock it ran out on 17 Oct)
  const realNow = Date.now; Date.now = () => NOW;
  try {
    const om = M.openMeteoMarineModel(JSON.parse(fx('marine-openmeteo-helsinki.json')));
    assert.deepEqual([om.heightM, om.directionDeg, om.periodS, om.seaTempC], [0.4, 191, 2.9, 11.2]);
    assert.ok(om.maxHeightM >= om.heightM);
    assert.equal(M.openMeteoMarineModel({ current: { time: '2026-10-15T16:00', wave_height: null, sea_surface_temperature: null } }), null);
    const of = M.oceanForecastModel(JSON.parse(fx('marine-oceanforecast-oslo.json')));
    assert.deepEqual([of.provider, of.time, of.heightM, of.directionDeg, of.seaTempC], ['MET Norway', '2026-10-15T16:00:00Z', 0.5, 200, 12.2]);
  } finally { Date.now = realNow; }
});

test('get_marine_conditions: Finland, Norway, Denmark and Sweden each from their national service; inland is an error', async () => {
  const net = offline();
  try {
    const c = await client();
    const call = async (location) => c.callTool({ name: 'get_marine_conditions', arguments: { location } });

    const hel = await call(HELSINKI);
    const t = hel.content[0].text;
    assert.match(t, /^Sea level: \+30 cm against theoretical mean sea level at Helsinki Kaivopuisto \(FMI, 2,\d km away, 19:00\)$/m);
    assert.match(t, /^Sea level forecast until .*highest \+35 cm around 20:00/m);
    assert.match(t, /^Water temperature: 10,8 °C at Helsinki Kaivopuisto/m);
    assert.match(t, /^Waves: 0,5 m from S \(189°\), period 3,2 s at Helsinki Suomenlinna aaltopoiju \(FMI/m);
    assert.match(t, /^Wave model \(Open-Meteo Marine\): waves 0,4 m/m);
    assert.match(t, /Sources: Finnish Meteorological Institute \(CC BY 4\.0\); Open-Meteo Marine/);
    assert.equal(hel.structuredContent.seaLevel.reference, 'theoretical mean sea level');
    assert.equal(hel.structuredContent.seaLevelForecast.provider, 'FMI');

    const osl = await call(OSLO);
    assert.match(osl.content[0].text, /^Sea level: \+33 cm against mean sea level at Oslo \(Kartverket, 18:00\)$/m, 'Oslo is UTC+2 in October');
    assert.match(osl.content[0].text, /^Wave model \(MET Norway Oceanforecast\)/m);
    assert.equal(osl.structuredContent.seaLevelForecast.provider, 'Kartverket');
    const ua = net.calls.find((x) => x.url.includes('oceanforecast')).headers['User-Agent'];
    assert.match(ua, /^mcp-weather\/[\d.]+ \(\+https:\/\/github\.com\/Koneisto\/mcp-weather\)$/);

    const cph = await call(COPENHAGEN);
    assert.match(cph.content[0].text, /^Sea level: \+17 cm against DVR90 at Københavns Havn \(DMI/m);
    assert.match(cph.content[0].text, /^Water temperature: 13,4 °C at Københavns Havn II/m);

    const sto = await call(STOCKHOLM);
    assert.match(sto.content[0].text, /^Sea level: \+28 cm against RH 2000 at Stockholm-Skeppsholmen \(SMHI/m);
    assert.ok(!net.calls.some((x) => x.url.includes('oceanObs') && x.url.includes('bbox=16.')), 'DMI is not asked for Stockholm');

    const tre = await call(TAMPERE);
    assert.equal(tre.isError, true);
    assert.match(tre.content[0].text, /not at the coast or at sea/);
  } finally { net.restore(); }
});

test('road weather parsers: station names, faulty surface sensor falls back, frost risk, worst forecast per step', () => {
  assert.deepEqual(R.stationName('kt51_Hki_Lapinlahti'), { name: 'Hki Lapinlahti', road: 51 });
  assert.deepEqual(R.stationName('Kirkkonummi'), { name: 'Kirkkonummi' });
  const keimola = R.parseRoadStation(JSON.parse(fx('road-data-1041.json')), { name: 'vt3_Vantaa_Keimola', distanceKm: 0.7 });
  assert.equal(keimola.surface, 'Dry', 'KELI_1 and KELI_2 report a fault; the optical sensor says dry');
  const frost = R.parseRoadStation({ id: 1, sensorValues: [
    { name: 'ILMA', value: 0.5, measuredTime: '2026-10-15T16:10:00Z' }, { name: 'TIE_1', value: -1.2 }, { name: 'KASTEPISTE', value: -0.8 }, { name: 'KELI_1', value: 5 }] }, { name: 'x', distanceKm: 1 });
  assert.equal(frost.frostRisk, true);
  assert.equal(frost.surface, 'Frost');

  const real = R.summarizeForecast(JSON.parse(fx('road-forecast-helsinki.json')));
  assert.deepEqual(real.map((s) => [s.step, s.condition]), [['0h', 'normal'], ['2h', 'normal'], ['4h', 'normal'], ['6h', 'normal'], ['12h', 'normal']]);
  const f = (id, step, c, reason) => ({ id, forecasts: [{ time: '2026-10-16T04:00:00Z', forecastName: step, overallRoadCondition: c, forecastConditionReason: reason }] });
  const poor = R.summarizeForecast({ forecastSections: [
    f('00004_001_00000_1_0', '12h', 'POOR_CONDITION', { roadCondition: 'FROST', precipitationCondition: 'NO_RAIN_DRY_WEATHER' }),
    f('00045_002_00000_1_0', '12h', 'POOR_CONDITION', { winterSlipperiness: 'POSSIBLE' }),
    f('00001_001_00000_1_0', '12h', 'NORMAL_CONDITION', { roadCondition: 'DRY' }),
  ] });
  assert.deepEqual(poor, [{ step: '12h', time: '2026-10-16T04:00:00Z', condition: 'poor', roads: [4, 45], reasons: ['frost', 'possible'] }]);
});

test('get_road_weather: nearest fresh station and the forecast in Finland; refusal outside Finland', async () => {
  const net = offline();
  try {
    const c = await client();
    const hel = await c.callTool({ name: 'get_road_weather', arguments: { location: HELSINKI } });
    const t = hel.content[0].text;
    assert.match(t, /^Station: Hki Lapinlahti \(road 51\), 2,\d km away, measured 19:11$/m);
    assert.match(t, /^Road surface: 11,3 °C, dry · air 11,5 °C · dew point 8,3 °C$/m);
    assert.match(t, /^Friction: 0,82 \(dry asphalt about 0,8\) · slipperiness warning: none$/m);
    assert.match(t, /^Road condition forecast \(8 road sections within 10 km\): now normal, 2 h normal, 4 h normal, 6 h normal, 12 h normal$/m);
    assert.match(t, /Source: Fintraffic \/ digitraffic\.fi, CC BY 4\.0/);
    assert.equal(hel.structuredContent.station.road, 51);
    const dt = net.calls.find((x) => x.url.includes('tie.digitraffic.fi'));
    assert.equal(dt.headers['Digitraffic-User'], 'Koneisto/mcp-weather');
    assert.equal(dt.headers['Accept-Encoding'], 'gzip');

    const sto = await c.callTool({ name: 'get_road_weather', arguments: { location: STOCKHOLM } });
    assert.equal(sto.isError, true);
    assert.match(sto.content[0].text, /covers Finland/);
  } finally { net.restore(); }
});

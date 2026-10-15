// National services (1.2.0): station parsers for SMHI, DMI, IMO (vedur.is), LHMT (meteo.lt) and the Estonian Environment Agency,
// and FMI's meteorologist-edited forecast in get_weather_forecast.
// Offline: fixtures are real responses from 15 Oct 2026 around 16:00 UTC, trimmed to a few stations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const O = await import('../build/sources/national-obs.js');
const F = await import('../build/sources/fmi-forecast.js');
const { createMcpServer } = await import('../build/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

test('SMHI: latest-hour sets merge per station, values as numbers, time from the temperature', () => {
  const c = O.mergeSmhi({ 1: JSON.parse(fx('obs-smhi-temp.json')) });
  const sthlm = c.find((x) => x.name === 'Stockholm-Observatoriekullen A');
  assert.equal(sthlm.weather.temperature, 11.4);
  assert.equal(sthlm.time, '2026-10-15T15:00:00.000Z');
  assert.equal(c.length, 3);
});

test('DMI: latest value per parameter, other parameters ignored', () => {
  const l = O.dmiLatest(JSON.parse(fx('obs-dmi-copenhagen.json')));
  assert.equal(l.time, '2026-10-15T15:10:00Z');
  assert.equal(l.weather.temperature, 14.1);
  assert.equal(l.weather.dewPoint, 11.42);
  assert.deepEqual(Object.keys(l.weather).sort(), ['dewPoint', 'humidity', 'temperature']);
});

test('IMO: observations join the station list for coordinates; vedur.is times are UTC without a zone', () => {
  const c = O.joinVedur(JSON.parse(fx('obs-vedur-stations.json')), JSON.parse(fx('obs-vedur-aws.json')));
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'Keflavíkurflugvöllur');
  assert.equal(c[0].time, '2026-10-15T16:00:00Z');
  assert.equal(c[0].weather.temperature, 3.93);
  assert.equal(c[0].weather.precipitation, undefined, 'null is missing, not zero');
  assert.ok(Math.abs(c[0].lat - 63.97) < 0.1);
});

test('LHMT: last hourly observation, UTC time, condition code as text', () => {
  const l = O.ltLatest(JSON.parse(fx('obs-lhmt-kaunas.json')));
  assert.equal(l.time, '2026-10-15T16:00:00Z');
  assert.equal(l.weather.temperature, 8.2);
  assert.equal(l.weather.weatherDescription, 'Clear');
  assert.deepEqual(O.ltLatest({ observations: [] }), { weather: {} });
});

test('Estonia: one timestamp for all stations, empty values missing, visibility km → m', () => {
  const c = O.parseEstonia(fx('obs-estonia.xml'));
  assert.deepEqual(c.map((x) => x.name).sort(), ['Kuressaare linn', 'Tallinn-Harku', 'Tartu-Tõravere']);
  assert.ok(c.every((x) => x.time === c[0].time && x.time.startsWith('2026-10-15T')));
  const kur = c.find((x) => x.name === 'Kuressaare linn');
  assert.equal(kur.weather.temperature, 11.3);
  assert.equal(kur.weather.windSpeed, undefined);
  const harku = c.find((x) => x.name === 'Tallinn-Harku');
  assert.equal(harku.weather.visibility, 35000);
  assert.equal(harku.weather.weatherDescription, 'Overcast');
});

test('FMI forecast: multipointcoverage parsed hourly; full local days only, most severe symbol, wind vector mean', () => {
  const hours = F.parseFmiMultipoint(fx('fmi-forecast-helsinki.xml'));
  assert.equal(hours.length, 224);
  assert.deepEqual(hours[0], { time: '2026-10-15T17:00:00.000Z', values: { Temperature: 11.11, Precipitation1h: 0, PoP: 0, WindSpeedMS: 6.7, WindDirection: 194, HourlyMaximumGust: 10.9, WeatherSymbol3: 3 } });
  const days = F.fmiDaily(hours);
  assert.equal(days[0].date, '2026-10-16', '15 Oct has only 4 forecast hours left (from 20:00 local)');
  assert.ok(days.length >= 8 && days.every((d) => /^\d{4}-\d\d-\d\d$/.test(d.date)));
  const d16 = hours.filter((h) => h.time >= '2026-10-15T21:00' && h.time < '2026-10-16T21:00');   // 16 Oct in Helsinki (UTC+3)
  assert.equal(d16.length, 24);
  assert.equal(days[0].tempMax, Math.round(Math.max(...d16.map((h) => h.values.Temperature)) * 10) / 10);
  assert.equal(days[0].precipitationSum, Math.round(d16.reduce((a, h) => a + h.values.Precipitation1h, 0) * 10) / 10);
  const mixed = F.fmiDaily(Array.from({ length: 20 }, (_, i) => ({ time: new Date(Date.UTC(2026, 9, 16, i)).toISOString(),
    values: { Temperature: 5, WindSpeedMS: i < 10 ? 2 : 8, WindDirection: i < 10 ? 90 : 270, WeatherSymbol3: i === 5 ? 21 : i === 6 ? 92 : 2 } })));
  assert.equal(mixed[0].weatherDescription, 'Light showers', 'showers outrank fog and partly cloudy');
  assert.equal(mixed[0].windDirection, 270, 'the stronger westerly wins');
});

test('get_weather_forecast in Finland: FMI for the full days, the model for today, UV and sunrise; Sweden unchanged', async () => {
  const realFetch = globalThis.fetch, realNow = Date.now;
  globalThis.fetch = async (u) => {
    u = String(u);
    if (u.includes('fmi::forecast::edited')) return new Response(fx('fmi-forecast-helsinki.xml'), { status: 200 });
    if (u.startsWith('https://api.open-meteo.com/v1/forecast')) {
      const date = ['2026-10-15', '2026-10-16', '2026-10-17'];
      return new Response(JSON.stringify({ timezone: 'Europe/Helsinki', daily: { time: date, temperature_2m_max: [11.6, 99, 99], temperature_2m_min: [10.8, 99, 99],
        weather_code: [51, 0, 0], precipitation_sum: [0.1, 0, 0], precipitation_probability_max: [25, 0, 0], wind_speed_10m_max: [8.6, 1, 1],
        wind_direction_10m_dominant: [200, 0, 0], uv_index_max: [1.4, 0.3, 0.25], sunrise: date.map((d) => `${d}T08:00`), sunset: date.map((d) => `${d}T18:10`) } }), { status: 200 });
    }
    throw new Error(`network disabled in test: ${u}`);
  };
  Date.now = () => Date.parse('2026-10-15T16:20:00Z');
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(b);
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(a);
    const r = await c.callTool({ name: 'get_weather_forecast', arguments: { location: '60.1699,24.9384', days: 3 } });
    const days = r.structuredContent.days;
    assert.deepEqual(days.map((d) => d.source), ['MET Norway MET Nordic model via Open-Meteo', 'FMI', 'FMI']);
    assert.equal(days[0].tempMax, 11.6, 'today stays with the model');
    assert.ok(days[1].tempMax < 30 && days[1].uvIndexMax === 0.3 && days[1].sunrise === '08:00', 'FMI values, model UV and sunrise');
    assert.match(r.content[0].text, /^Source: Finnish Meteorological Institute, meteorologist-edited forecast \(CC BY 4\.0\) for 2026-10-16–2026-10-17; other days, UV and sunrise\/sunset: MET Norway MET Nordic model via Open-Meteo$/m);
    const se = await c.callTool({ name: 'get_weather_forecast', arguments: { location: '59.3293,18.0686', days: 3 } });
    assert.ok(se.structuredContent.days.every((d) => d.source === 'MET Norway MET Nordic model via Open-Meteo'), 'no FMI forecast outside Finland');
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

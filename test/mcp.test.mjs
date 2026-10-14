// MCP protocol level: tools as a client sees them (titles, output schemas, annotations), structuredContent validated by
// the SDK client against each tool's outputSchema, isError on failures, and the native stateless Streamable HTTP server.
// Offline: external sources answer from fixtures; the HTTP part talks to a local server on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { createMcpServer, startHttpServer } = await import('../build/server.js');
const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const MIKKELI = fixture('fmi-mikkeli-airport.xml'), AQ = fixture('fmi-aq-helsinki-kallio.xml');
const NOW = Date.parse('2026-10-14T17:15:00Z');

const FORECAST = { daily: { time: ['2026-10-14', '2026-10-15'], temperature_2m_max: [9.9, 11], temperature_2m_min: [4.9, 7.7], weather_code: [53, 3],
  precipitation_sum: [2.7, 0], precipitation_probability_max: [77, 0], wind_speed_10m_max: [5, 6], wind_direction_10m_dominant: [160, 180],
  uv_index_max: [0.8, 1.3], sunrise: ['2026-10-14T08:04', '2026-10-15T08:07'], sunset: ['2026-10-14T18:15', '2026-10-15T18:12'] } };
const METAR = [{ rawOb: 'METAR EFHK 141720Z 12005KT 9999 BKN020 10/08 Q1015 NOSIG', name: 'x', obsTime: 1791998400, temp: 10, dewp: 8, wdir: 120,
  wspd: 5, wgst: null, visib: '6+', altim: 1015, slp: null, fltCat: 'MVFR', clouds: [{ cover: 'BKN', base: 2000 }], wxString: null }];

/** Offline sources: FMI weather/AQ fixtures, Open-Meteo forecast/AQ, METAR for EFHK only; everything else fails. */
function offline() {
  const realFetch = globalThis.fetch, realNow = Date.now;
  globalThis.fetch = async (u) => {
    u = String(u);
    if (u.includes('airquality::hourly') && u.includes('urban::')) return new Response(AQ, { status: 200 });
    if (u.includes('airquality::hourly')) return new Response('<wfs:FeatureCollection numberReturned="0"></wfs:FeatureCollection>', { status: 200 });
    if (u.startsWith('https://opendata.fmi.fi/')) return new Response(MIKKELI, { status: 200 });
    if (u.startsWith('https://api.open-meteo.com/v1/forecast') && u.includes('daily=')) return new Response(JSON.stringify(FORECAST), { status: 200 });
    if (u.startsWith('https://air-quality-api.open-meteo.com/')) return new Response(JSON.stringify({ current: { european_aqi: 20, pm2_5: 4.9, pm10: 6.6, nitrogen_dioxide: 5.2, ozone: 51, sulphur_dioxide: 0.9, carbon_monoxide: 169 } }), { status: 200 });
    if (u.includes('aviationweather.gov/api/data/metar') && u.includes('ids=EFHK')) return new Response(JSON.stringify(METAR), { status: 200 });
    if (u.includes('aviationweather.gov')) return new Response('unavailable', { status: 503 });
    throw new Error('network disabled in test');
  };
  Date.now = () => NOW;
  return () => { globalThis.fetch = realFetch; Date.now = realNow; };
}

async function inMemoryClient() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(b);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(a);
  await c.listTools();   // the client caches output schemas and validates structuredContent against them
  return c;
}

test('tools: same names, with title, output schema and read-only annotations', async () => {
  const c = await inMemoryClient();
  const tools = (await c.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_air_quality', 'get_astronomy', 'get_current_weather', 'get_metar', 'get_weather_forecast', 'get_weather_source_status']);
  for (const t of tools) {
    assert.ok(t.title, t.name);
    assert.equal(t.outputSchema?.type, 'object', t.name);
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
  await c.close();
});

test('every tool returns structuredContent that validates against its outputSchema, plus the same text', async () => {
  const restore = offline();
  try {
    const c = await inMemoryClient();
    const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`); assert.ok(r.structuredContent, name); return r; };
    let r = await call('get_current_weather', { location: 'mikkeli' });
    assert.equal(r.structuredContent.measuredAt.station, 'Mikkeli Lentoasema AWOS');
    assert.equal(r.structuredContent.temperature, 8.6);
    assert.match(r.content[0].text, /^Temperature: 8,6 °C$/m);
    r = await call('get_weather_forecast', { location: 'tre', days: 2 });
    assert.equal(r.structuredContent.days.length, 2);
    assert.equal(r.structuredContent.days[0].sunrise, '08:04');
    r = await call('get_air_quality', { location: '60.1876,24.9510' });
    assert.equal(r.structuredContent.pollutants.pm25.origin, 'measured');
    assert.equal(r.structuredContent.pollutants.co.origin, 'model');
    assert.equal(r.structuredContent.category, 'Good');
    r = await call('get_metar', { station: 'EFHK' });
    assert.equal(r.structuredContent.kind, 'metar');
    assert.equal(r.structuredContent.visibilityOrMore, true);
    r = await call('get_metar', { station: 'EFMI' });
    assert.equal(r.structuredContent.kind, 'fmi_observation');
    assert.equal(r.structuredContent.fmiStation, 'Mikkeli Lentoasema AWOS');
    r = await call('get_astronomy', { location: '60.17,24.94', date: '2026-10-14' });
    assert.match(r.structuredContent.sun.sunrise, /^07:5\d$/);
    r = await call('get_weather_source_status', {});
    assert.ok(r.structuredContent.sources.some((s) => s.name === 'FMI' && s.status === 'OK'));
    await c.close();
  } finally { restore(); }
});

test('failures are isError with a readable message', async () => {
  const restore = offline();
  try {
    const c = await inMemoryClient();
    for (const [name, args, re] of [
      ['get_astronomy', { location: 'hki', date: 'tomorrow' }, /^Error: invalid date/],
      ['get_metar', { station: 'Lontoo' }, /^Could not resolve "Lontoo"/],
      ['get_metar', { station: 'ESSA' }, /^Error fetching METAR: /],
      ['get_current_weather', { location: '  ' }, /^Error: Location is required$/],
    ]) {
      const r = await c.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, re);
      assert.equal(r.structuredContent, undefined);
    }
    await c.close();
  } finally { restore(); }
});

test('native Streamable HTTP: one process, stateless JSON, /health, 405 on GET, 400 on bad JSON', async () => {
  const http = await startHttpServer(0, '127.0.0.1');
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const clients = await Promise.all([1, 2, 3].map(async () => {
      const c = new Client({ name: 'http', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      return c;
    }));
    const results = await Promise.all(clients.map((c, i) => c.callTool({ name: 'get_astronomy', arguments: { location: '60.17,24.94', date: `2026-10-1${i + 4}` } })));
    results.forEach((r, i) => { assert.ok(!r.isError); assert.equal(r.structuredContent.date, `2026-10-1${i + 4}`); });
    const e = await clients[0].callTool({ name: 'get_astronomy', arguments: { location: '60.17,24.94', date: 'x' } });
    assert.equal(e.isError, true);
    for (const c of clients) await c.close();
  } finally { await new Promise((r) => http.close(r)); }
});

test('1.0.2: instructions, one-time API key note, key help in source status', async () => {
  const { resetKeyNote } = await import('../build/server.js');
  const restore = offline();
  try {
    resetKeyNote();
    const c = await inMemoryClient();
    assert.match(c.getInstructions() ?? '', /get_weather_source_status explains where to get free keys/);
    const r1 = await c.callTool({ name: 'get_astronomy', arguments: { location: '60.17,24.94', date: '2026-10-14' } });
    assert.equal(r1.content.length, 2);
    assert.match(r1.content[1].text, /^Note: 3 optional sources are off because no API key is set \(OpenWeatherMap, WeatherAPI, Tomorrow\.io\)/);
    const r2 = await c.callTool({ name: 'get_astronomy', arguments: { location: '60.17,24.94', date: '2026-10-15' } });
    assert.equal(r2.content.length, 1, 'note only once per process');
    const s = await c.callTool({ name: 'get_weather_source_status', arguments: {} });
    assert.deepEqual(s.structuredContent.apiKeys.missing.map((k) => k.env), ['OPENWEATHERMAP_API_KEY', 'WEATHERAPI_KEY', 'TOMORROW_IO_API_KEY']);
    assert.match(s.content[0].text, /How to set: Docker: add KEY=value to the \.env file/);
    await c.close();
    resetKeyNote(); process.env.MCP_WEATHER_KEY_NOTE = 'off';
    const c2 = await inMemoryClient();
    const r3 = await c2.callTool({ name: 'get_astronomy', arguments: { location: '60.17,24.94', date: '2026-10-14' } });
    assert.equal(r3.content.length, 1, 'MCP_WEATHER_KEY_NOTE=off silences the note');
    await c2.close();
  } finally { delete process.env.MCP_WEATHER_KEY_NOTE; restore(); }
});

test('1.0.2: JSON-only clients are served (no SSE needed), foreign Origin is rejected', async () => {
  const { originAllowed } = await import('../build/server.js');
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed('http://localhost:6274'), true);
  assert.equal(originAllowed('http://evil.example'), false);
  assert.equal(originAllowed('https://ok.example', ['https://ok.example']), true);
  const http = await startHttpServer(0, '127.0.0.1');
  const base = `http://127.0.0.1:${http.address().port}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  try {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal((await r.json()).result.serverInfo.version, '1.0.2');
    const f = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'http://evil.example' }, body });
    assert.equal(f.status, 403);
  } finally { await new Promise((res) => http.close(res)); }
});

// Tests for the FMI source and its use in get_current_weather and the get_metar fallback.
// No network: fetch is replaced with fixtures. Run after `npm run build`: npm test
// Fixtures are real FMI open data responses (14 Oct 2026), © Finnish Meteorological Institute, CC BY 4.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MIKKELI = fixture('fmi-mikkeli-airport.xml');
const HELSINKI = fixture('fmi-helsinki-area.xml');
const FIXTURE_NOW = Date.parse('2026-10-14T17:15:00Z');   // fixtures end at 17:10Z

const { parseFmiTimeValuePair, stationToWeather, fetchFmiObservation, isInFinland } = await import('../build/sources/fmi.js');
const { metarTool } = await import('../build/tools/metar.js');
const { currentWeatherTool } = await import('../build/tools/current-weather.js');

/** Replace fetch: FMI → given XML, aviationweather.gov → HTTP 503, everything else → network error. */
function withFetch(fmiXml, fn) {
  const realFetch = globalThis.fetch, realNow = Date.now, calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://opendata.fmi.fi/')) return new Response(fmiXml, { status: 200 });
    if (String(url).includes('aviationweather.gov')) return new Response('unavailable', { status: 503 });
    throw new Error('network disabled in test');
  };
  Date.now = () => FIXTURE_NOW;
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = realFetch; Date.now = realNow; });
}

test('parses stations and the latest valid value of each parameter', () => {
  const [st] = parseFmiTimeValuePair(MIKKELI);
  assert.equal(st.fmisid, '855522');
  assert.equal(st.name, 'Mikkeli Lentoasema AWOS');
  assert.ok(Math.abs(st.lat - 61.68751) < 1e-6 && Math.abs(st.lon - 27.20671) < 1e-6);
  assert.equal(st.values.t2m.time, '2026-10-14T17:10:00Z');
  assert.equal(st.values.t2m.value, 8.6);
  const names = parseFmiTimeValuePair(HELSINKI).map((s) => s.name);
  assert.equal(names.length, 8, 'eight stations in the Helsinki area fixture');
  assert.ok(names.includes('Vantaa Helsinki-Vantaan lentoasema'));
});

test('NaN means not measured and is skipped', () => {
  const xml = '<wfs:member><gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">1</gml:identifier>' +
    '<gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">Test</gml:name><gml:pos>61.0 25.0 </gml:pos>' +
    '<wml2:MeasurementTimeseries gml:id="obs-obs-1-1-t2m">' +
    '<wml2:time>2026-10-14T17:00:00Z</wml2:time><wml2:value>5.0</wml2:value>' +
    '<wml2:time>2026-10-14T17:10:00Z</wml2:time><wml2:value>NaN</wml2:value></wml2:MeasurementTimeseries></wfs:member>';
  const [st] = parseFmiTimeValuePair(xml);
  assert.deepEqual(st.values.t2m, { time: '2026-10-14T17:00:00Z', value: 5 });
});

test('cloud octas and precipitation are converted', () => {
  const st = (v) => stationToWeather({ fmisid: '1', name: 'x', lat: 0, lon: 0, values: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { time: 't', value: x }])) });
  assert.equal(st({ n_man: 4 }).cloudCover, 50);
  assert.equal(st({ n_man: 9 }).cloudCover, 100, 'sky obscured');
  assert.equal(st({ r_1h: -1 }).precipitation, 0, 'negative = no precipitation');
  assert.equal(st({}).temperature, undefined);
});

test('outside Finland: no request', async () => {
  await withFetch(MIKKELI, async (calls) => {
    assert.equal(isInFinland(51.5, -0.12), false);
    const r = await fetchFmiObservation(51.5, -0.12);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
});

test('nearest station within the radius; stale data is rejected', async () => {
  await withFetch(HELSINKI, async () => {
    const r = await fetchFmiObservation(60.3172, 24.9633, 15);   // EFHK reference point
    assert.equal(r.ok, true);
    assert.equal(r.data.station, 'Vantaa Helsinki-Vantaan lentoasema');
    assert.ok(r.data.distanceKm < 3);
  });
  const realNow = Date.now;
  await withFetch(MIKKELI, async () => {
    Date.now = () => FIXTURE_NOW + 3 * 3600e3;                   // three hours later
    const r = await fetchFmiObservation(61.70, 27.21, 14);       // different bbox → no cache hit
    assert.equal(r.ok, false);
  }).finally(() => { Date.now = realNow; });
});

test('get_metar falls back to the FMI airport station and says it is not a METAR', async () => {
  await withFetch(MIKKELI, async (calls) => {
    const out = (await metarTool.handler({ station: 'EFMI' }, {})).content[0].text;
    assert.ok(calls.some((u) => u.includes('aviationweather.gov')), 'METAR tried first');
    assert.match(out, /METAR for EFMI is unavailable/);
    assert.match(out, /This is not a METAR/);
    assert.match(out, /Station: Mikkeli Lentoasema AWOS/);
    assert.match(out, /Temperature: 8,6 °C/);
    assert.match(out, /Finnish Meteorological Institute open data \(CC BY 4\.0\)/);
  });
});

test('get_metar for a non-Finnish airport has no FMI fallback', async () => {
  await withFetch(MIKKELI, async (calls) => {
    const out = (await metarTool.handler({ station: 'ESSA' }, {})).content[0].text;
    assert.match(out, /^Error fetching METAR/);
    assert.ok(!calls.some((u) => u.includes('fmi.fi')));
  });
});

test('get_current_weather in Finland: FMI measurement first, credited', async () => {
  await withFetch(MIKKELI, async () => {
    const out = (await currentWeatherTool.handler({ location: 'mikkeli' }, {})).content[0].text;
    assert.match(out, /Temperature: 8,6 °C/);
    assert.match(out, /Measured at: Mikkeli Lentoasema AWOS/);
    assert.match(out, /Sources: FMI/);
    assert.match(out, /Finnish Meteorological Institute \(CC BY 4\.0\)/);
  });
});

test('no METAR for the station (HTTP 204, empty body) is reported as missing, then FMI fallback', async () => {
  const realFetch = globalThis.fetch, realNow = Date.now;
  globalThis.fetch = async (url) => String(url).includes('aviationweather.gov')
    ? new Response(null, { status: 204 })
    : new Response(MIKKELI, { status: 200 });
  Date.now = () => FIXTURE_NOW;
  try {
    const out = (await metarTool.handler({ station: 'mikkeli' }, {})).content[0].text;
    assert.match(out, /METAR for EFMI is unavailable \(No METAR data for EFMI\)/);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

test('METAR observation time (Unix seconds) is shown as a time, not a number', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{ rawOb: 'METAR EFHK 141650Z 16010KT 9999 OVC011 11/08 Q1015', name: 'x', obsTime: 1791996600,
    temp: 11, dewp: 8, wdir: 160, wspd: 10, wgst: null, visib: '6+', altim: 1015, slp: null, fltCat: 'MVFR', clouds: [{ cover: 'OVC', base: 1100 }], wxString: null }]), { status: 200 });
  try {
    const out = (await metarTool.handler({ station: 'EFHK' }, {})).content[0].text;
    assert.match(out, /Observation: 19:50 Finnish time \(2026-10-14T16:50:00Z\)/);
    assert.doesNotMatch(out, /1791996600/);
  } finally { globalThis.fetch = realFetch; }
});

// ---- 10/2026 fixes: radius, ICAO location, sea-level pressure, METAR visibility ----
const { resolveLocation } = await import('../build/utils/location.js');
const { metarVisibility } = await import('../build/sources/metar.js');
const { fetchOpenMeteoCurrent } = await import('../build/sources/open-meteo.js');

test('station farther than 15 km is not used for current weather', async () => {
  await withFetch(MIKKELI, async () => {
    // Mikkeli airport station 61.6875,27.2067; point 20 km north of it
    const r = await fetchFmiObservation(61.687 + 20 / 111, 27.207);
    assert.equal(r.ok, false);
    assert.match(r.error, /within 15 km/);
  });
});

test('ICAO code resolves to the airport, not 0,0', async () => {
  const realFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('stationinfo?ids=ESSA')) return new Response(JSON.stringify([{ icaoId: 'ESSA', site: 'Stockholm/Arlanda Arpt', lat: 59.664, lon: 17.92, country: 'SE' }]), { status: 200 });
    if (String(url).includes('stationinfo')) return new Response(null, { status: 204 });
    if (String(url).includes('geocoding-api')) return new Response(JSON.stringify({ results: [{ latitude: 41.89, longitude: 12.48, name: 'Rome', country: 'Italy' }] }), { status: 200 });
    throw new Error('unexpected ' + url);
  };
  try {
    const hk = await resolveLocation('EFHK');
    assert.ok(Math.abs(hk.lat - 60.317) < 0.01 && Math.abs(hk.lon - 24.963) < 0.01, 'Finnish airport from the local table');
    assert.equal(calls.length, 0, 'no request for a Finnish airport');
    const ar = await resolveLocation('essa');
    assert.equal(ar.name, 'Stockholm/Arlanda Arpt (ESSA)');
    assert.equal(ar.country, 'Sweden');
    assert.ok(Math.abs(ar.lat - 59.664) < 1e-6);
    const roma = await resolveLocation('Roma');
    assert.equal(roma.name, 'Rome', '4-letter non-ICAO word falls back to geocoding');
  } finally { globalThis.fetch = realFetch; }
});

test('Open-Meteo pressure is sea level (pressure_msl)', async () => {
  const realFetch = globalThis.fetch; let url = '';
  globalThis.fetch = async (u) => { url = String(u); return new Response(JSON.stringify({ current: { temperature_2m: 1, pressure_msl: 1015.5 } }), { status: 200 }); };
  try {
    const r = await fetchOpenMeteoCurrent(48.1, 11.6);
    assert.match(url, /pressure_msl/);
    assert.doesNotMatch(url, /surface_pressure/);
    assert.equal(r.data.pressure, 1015.5);
  } finally { globalThis.fetch = realFetch; }
});

test('METAR visibility: 9999 and CAVOK = 10 km or more, metres and statute miles parsed', () => {
  assert.deepEqual(metarVisibility('METAR EFMI 141650Z AUTO 13005KT 9999 OVC011 09/07 Q1017', '6+'), { visibility: 10000, visibilityOrMore: true });
  assert.deepEqual(metarVisibility('METAR EFHK 141650Z 16010KT CAVOK 11/08 Q1015', '6+'), { visibility: 10000, visibilityOrMore: true });
  assert.deepEqual(metarVisibility('METAR EFRO 141650Z 00000KT 0300 FG VV001 03/03 Q1012', '0.19'), { visibility: 300 });
  assert.deepEqual(metarVisibility('METAR KJFK 141651Z 27006KT 10SM -RA FEW036 23/19 A2987 RMK AO2 SLP115', '10+'), { visibility: 16093, visibilityOrMore: true });
  assert.deepEqual(metarVisibility('METAR KSFO 141656Z 28012KT 1 1/2SM BR OVC004 14/13 A3001', '1 1/2'), { visibility: 2414 });
});

test('wttr.in is queried with coordinates, not the place name', async () => {
  const realFetch = globalThis.fetch, urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); throw new Error('offline'); };
  try {
    await currentWeatherTool.handler({ location: '59.664,17.92' }, {});
    assert.ok(urls.some((u) => u.startsWith('https://wttr.in/59.664%2C17.92?')), urls.join('\n'));
  } finally { globalThis.fetch = realFetch; }
});

// ---- remaining fixes: geocoding languages, Tomorrow.io quota, nearest station for reference ----
const { pickGeocodeResult } = await import('../build/utils/location.js');

test('geocoding prefers the capital / largest exact match across languages', () => {
  const romania = { id: 1, name: 'Roma', country_code: 'RO', feature_code: 'PPLA2', population: 3218, latitude: 47.8, longitude: 26.6 };
  const rome = { id: 2, name: 'Roma', country_code: 'IT', feature_code: 'PPLC', population: 2318895, latitude: 41.9, longitude: 12.5 };
  const lesotho = { id: 3, name: 'Roma', country_code: 'LS', feature_code: 'PPL', population: 14259, latitude: -29.4, longitude: 27.7 };
  assert.equal(pickGeocodeResult('Roma', [romania, lesotho, rome]).id, 2);
  const lontoo = { id: 4, name: 'Lontoo', country_code: 'GB', feature_code: 'PPLC', population: 8961989, latitude: 51.5, longitude: -0.13 };
  const lontoon = { id: 5, name: 'Lontoon City', country_code: 'GB', feature_code: 'PPLA3', population: 8072, latitude: 51.5, longitude: -0.09 };
  assert.equal(pickGeocodeResult('lontoo', [lontoon, lontoo]).id, 4, 'exact name, case-insensitive');
  assert.equal(pickGeocodeResult('Kivisto', [{ id: 6, name: 'Kivistö', feature_code: 'PPL', population: 11125, latitude: 60.3, longitude: 24.8 }]).id, 6, 'diacritics ignored');
});

test('Tomorrow.io: one request per location; HTTP 429 pauses the source', async () => {
  const { fetchTomorrowCurrent } = await import('../build/sources/tomorrow-io.js');
  const { config } = await import('../build/config.js');
  if (!config.hasTomorrowIo) { config.hasTomorrowIo = true; config.tomorrowIoKey = 'test'; }
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: { values: { temperature: 5, pressureSurfaceLevel: 990, pressureSeaLevel: 1012, visibility: 10, weatherCode: 1000, particulateMatter25: 3 } } }), { status: 200 }); };
  try {
    const c = await fetchTomorrowCurrent(10.1, 20.2);
    await fetchTomorrowCurrent(10.1, 20.2);
    assert.equal(calls, 1, 'second call from cache');
    assert.equal(c.data.pressure, 1012, 'sea-level pressure');
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 429 }); };
    calls = 0;
    const r1 = await fetchTomorrowCurrent(10.3, 20.4);
    const r2 = await fetchTomorrowCurrent(10.5, 20.6);
    assert.equal(r1.ok, false);
    assert.match(r2.error, /paused until/);
    assert.equal(calls, 1, 'no requests while paused');
  } finally { globalThis.fetch = realFetch; }
});

test('no station within 15 km: model values, nearest station shown for reference only', async () => {
  const realFetch = globalThis.fetch, realNow = Date.now;
  globalThis.fetch = async (u) => {
    if (String(u).startsWith('https://opendata.fmi.fi/')) return new Response(MIKKELI, { status: 200 });
    if (String(u).startsWith('https://api.open-meteo.com/')) return new Response(JSON.stringify({ current: { temperature_2m: 7.9, pressure_msl: 1016 } }), { status: 200 });
    throw new Error('network disabled in test');
  };
  Date.now = () => FIXTURE_NOW;
  try {
    // 25 km north of the Mikkeli airport station: outside 15 km, inside 50 km
    const r = await currentWeatherTool.handler({ location: `${(61.6875 + 25 / 111).toFixed(4)},27.2067` }, {});
    const out = r.content[0].text;
    assert.match(out, /^Temperature: 7,9 °C$/m, 'model value for the point');
    assert.doesNotMatch(out, /Measured at:/);
    assert.match(out, /Nearest weather station: Mikkeli Lentoasema AWOS \(FMI\), 25 km away: 8,6 °C at 20:10 \(for reference/);
    assert.match(out, /Finnish Meteorological Institute \(CC BY 4\.0\)/);
    assert.match(out, /^Sources: Open-Meteo$/m);
    assert.equal(r.structuredContent.temperature, 7.9);
    assert.equal(r.structuredContent.nearestStation.station, 'Mikkeli Lentoasema AWOS');
    assert.equal(r.structuredContent.measuredAt, undefined);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

test('no source answers: isError, not an empty weather report', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await currentWeatherTool.handler({ location: '41.89,12.51' }, {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^Error: no weather source answered/);
  } finally { globalThis.fetch = realFetch; }
});

test('timeout is reported as "no response within N s"', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; };
  try {
    const out = (await metarTool.handler({ station: 'XQZW' }, {})).content[0].text;
    assert.match(out, /^Error fetching METAR: no response within 10 s/);
  } finally { globalThis.fetch = realFetch; }
});

// ---- astronomy input validation and solar day (careful test round 14.10.2026) ----
const { astronomyTool } = await import('../build/tools/astronomy.js');
const astro = async (a) => (await astronomyTool.handler(a, {})).content[0].text;

test('astronomy: invalid date or timezone is an error, not a wrong answer', async () => {
  assert.match(await astro({ location: '60.17,24.94', date: '2026-13-45' }), /^Error: invalid date "2026-13-45"/);
  assert.match(await astro({ location: '60.17,24.94', date: '2026-02-30' }), /^Error: invalid date/);
  assert.match(await astro({ location: '60.17,24.94', date: 'tomorrow' }), /^Error: invalid date/);
  assert.match(await astro({ location: '60.17,24.94', timezone: 'Mars/Base' }), /^Error: unknown timezone/);
});

test('astronomy: same day regardless of longitude (Helsinki and Tokyo on 14 Oct 2026)', async () => {
  const hki = await astro({ location: '60.17,24.94', date: '2026-10-14' });
  assert.match(hki, /^Sunrise: 07:5\d$/m);
  assert.match(hki, /^Sunset: 18:1\d$/m);
  const tokyo = await astro({ location: '35.69,139.69', date: '2026-10-14', timezone: 'Asia/Tokyo' });
  assert.match(tokyo, /^Sunrise: 05:4\d$/m, 'Tokyo sunrise in mid-October is about 05:45 local time');
  assert.match(tokyo, /^Sunset: 17:(0[5-9]|1[0-4])$/m);   // Open-Meteo: 05:46 / 17:07
});

test('errors are not double-prefixed and an empty location is rejected without requests', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  try {
    const out = (await currentWeatherTool.handler({ location: '  ' }, {})).content[0].text;
    assert.equal(out, 'Error: Location is required');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = realFetch; }
});

// ---- air quality: FMI measured values, European AQI scale (14.10.2026) ----
const AQ_KALLIO = fixture('fmi-aq-helsinki-kallio.xml');   // urban:: stations Kallio 2 and Teollisuuskatu, until 18:00Z
const { europeanAqi, aqiToCategory } = await import('../build/utils/units.js');
const { airQualityTool } = await import('../build/tools/air-quality.js');

test('European AQI: EEA bands, maximum of sub-indices, European categories', () => {
  // Open-Meteo gave european_aqi 20 for these model values (Helsinki Kallio 14.10.2026 18:00Z)
  assert.equal(europeanAqi({ pm25: 4.9, pm10: 6.6, no2: 5.2, o3: 51 }), 20);
  assert.equal(europeanAqi({ pm25: 10 }), 20);
  assert.equal(europeanAqi({ pm25: 22.5 }), 50);
  assert.equal(europeanAqi({ no2: 400 }), 102);   // band 340–1000 → 100–120
  assert.equal(europeanAqi({}), undefined);
  assert.equal(aqiToCategory(18), 'Good');
  assert.equal(aqiToCategory(45), 'Moderate', 'was "Good" on the US EPA scale');
  assert.equal(aqiToCategory(61), 'Poor');
  assert.equal(aqiToCategory(120), 'Extremely poor');
});

test('air quality in Helsinki: measured station first, labelled, index from the shown values', async () => {
  const realFetch = globalThis.fetch, realNow = Date.now, urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (String(u).includes('urban::observations::airquality')) return new Response(AQ_KALLIO, { status: 200 });
    if (String(u).includes('fmi::observations::airquality')) return new Response('<wfs:FeatureCollection numberReturned="0"></wfs:FeatureCollection>', { status: 200 });
    if (String(u).includes('air-quality-api.open-meteo.com')) return new Response(JSON.stringify({ current: { european_aqi: 20, pm2_5: 4.9, pm10: 6.6, nitrogen_dioxide: 5.2, ozone: 51, sulphur_dioxide: 0.9, carbon_monoxide: 169 } }), { status: 200 });
    throw new Error('unexpected ' + u);
  };
  Date.now = () => Date.parse('2026-10-14T18:30:00Z');
  try {
    const out = (await airQualityTool.handler({ location: '60.1876,24.9510' }, {})).content[0].text;   // Kallio 2 station area
    assert.match(out, /Measured at: Helsinki (Kallio 2|Teollisuuskatu) \([\d,]+ km away\), hourly average, \d\d:\d\d/);
    assert.match(out, /^PM2\.5: [\d,]+ µg\/m³ \(measured\)$/m);
    assert.match(out, /^CO: 169 µg\/m³ \(model\)$/m, 'model fills what the station does not measure');
    assert.match(out, /^Sources: FMI, Open-Meteo$/m);
    assert.doesNotMatch(out, /Tomorrow/);
    const aqi = +(/European AQI: (\d+)/.exec(out)[1]);
    const v = (k) => parseFloat((new RegExp(`^${k}: ([\\d,]+) µg`, 'm').exec(out) || [])[1]?.replace(',', '.'));
    assert.equal(aqi, europeanAqi({ pm25: v('PM2\\.5'), pm10: v('PM10'), no2: v('NO₂'), o3: v('O₃'), so2: v('SO₂') }), 'index agrees with the values shown');
    assert.ok(urls.some((u) => u.includes('fmi::observations::airquality')), 'FMI background stations queried too');
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

test('air quality outside Finland: model only, no FMI request, no labels', async () => {
  const realFetch = globalThis.fetch, urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return new Response(JSON.stringify({ current: { european_aqi: 61, pm2_5: 18.7, pm10: 24, nitrogen_dioxide: 61.4, ozone: 15 } }), { status: 200 }); };
  try {
    const out = (await airQualityTool.handler({ location: '41.89,12.51' }, {})).content[0].text;
    assert.match(out, /European AQI: 61 \(Poor\)/);
    assert.doesNotMatch(out, /measured|model\)/);
    assert.ok(!urls.some((u) => u.includes('fmi.fi')));
  } finally { globalThis.fetch = realFetch; }
});

test('snow depth (snow_aws): whole cm, negative = no snow', async () => {
  const st = (v) => ({ fmisid: '1', name: 'x', lat: 0, lon: 0, values: { t2m: { time: '', value: -3 }, snow_aws: { time: '', value: v } } });
  assert.equal(stationToWeather(st(23.4)).snowDepth, 23);
  assert.equal(stationToWeather(st(-1)).snowDepth, 0);
  assert.equal(stationToWeather({ values: {} }).snowDepth, undefined, 'the station does not measure snow');
});

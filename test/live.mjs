// Live acceptance test against a running server, real network (optional API keys from the server's environment).
// Usage: npm run test:live -- <stdio command | http://host:port/mcp>
//   npm run test:live -- ./run.sh            (stdio, e.g. a wrapper that loads .env)
//   npm run test:live -- http://localhost:3015/mcp
// Expectations follow live data (e.g. which FMI station is nearest), so a failure means: look, not necessarily a bug.
import { fileURLToPath } from 'node:url';
const SDK = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''), target = process.argv[2] ?? 'node build/index.js';
const { Client } = await import(SDK + '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const mk = async () => {
  const c = new Client({ name: 'suite', version: '1' });
  if (target.startsWith('http')) {
    const { StreamableHTTPClientTransport } = await import(SDK + '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
    const tr = new StreamableHTTPClientTransport(new URL(target)); await c.connect(tr); c._tr = tr;
  } else {
    const { StdioClientTransport } = await import(SDK + '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
    const [command, ...args] = target.split(' ');
    await c.connect(new StdioClientTransport({ command, args, stderr: 'ignore' }));
  }
  return c;
};
const results = []; let c = await mk();
const call = async (name, args, cl = c) => { const r = await cl.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? '', isError: !!r.isError, data: r.structuredContent }; };
const check = (label, ok, info = '') => { results.push({ label, ok: !!ok }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : '  → ' + String(info).slice(0, 400).replace(/\n/g, ' | ')}`); };
const num = (t, re) => { const m = re.exec(t); return m ? parseFloat(m[1].replace(',', '.')) : NaN; };
const line = (t, p) => t.split('\n').find((l) => l.startsWith(p)) ?? '';

// ---------- 1. tools ----------
const tools = (await c.listTools()).tools;
check('12 tools', tools.length === 12 && ['get_current_weather','get_weather_forecast','get_precipitation_nowcast','get_weather_warnings','get_marine_conditions','get_lake_conditions','get_road_weather','get_air_quality','get_aurora_forecast','get_metar','get_astronomy','get_weather_source_status'].every((n) => tools.some((t) => t.name === n)), tools.map((t) => t.name));
check('METAR description mentions the FMI fallback', /Finnish Meteorological Institute/.test(tools.find((t) => t.name === 'get_metar').description));

// ---------- 2. current weather ----------
const cw = async (loc) => (await call('get_current_weather', { location: loc })).text;
const errOf = async (name, args) => { const r = await call(name, args); return r.isError && !r.data ? r.text : `NOT isError: ${r.text}`; };
const sane = (t) => { const T = num(t, /^Temperature: (-?[\d,]+) °C/m), p = num(t, /^Pressure: ([\d,]+) hPa/m), h = num(t, /^Humidity: ([\d,]+) %/m);
  return T > -50 && T < 50 && (isNaN(p) || (p > 940 && p < 1070)) && (isNaN(h) || (h >= 0 && h <= 100)); };
let t = await cw('hki');
check('hki: FMI first, Kaisaniemi under 1 km', /^Sources: FMI, /m.test(t) && /Measured at: Helsinki Kaisaniemi \(FMI, 0,\d km away\)/.test(t), t);
check('hki: sane values, FMI credited', sane(t) && /Finnish Meteorological Institute \(CC BY 4\.0\)/.test(t), t);
t = await cw('Kivistö');
check('Kivistö: Helsinki-Vantaa airport 7,4 km', /Measured at: Vantaa Helsinki-Vantaan lentoasema \(FMI, 7,4 km away\)/.test(t) && /Location: Kivistö, Finland/.test(t), t);
const kivTemp = num(t, /^Temperature: (-?[\d,]+) °C/m);
t = await cw(' efhk ');
check('" efhk ": airport position, not 0,0', /Location: Helsinki-Vantaa \(EFHK\), Finland \(60\.3172, 24\.9633\)/.test(t) && /lentoasema \(FMI, 1,4 km away\)/.test(t), t);
const efhkTemp = num(t, /^Temperature: (-?[\d,]+) °C/m);
check('Kivistö and EFHK from the same station → same temperature', kivTemp === efhkTemp, [kivTemp, efhkTemp]);
t = await cw('ESSA');
check('ESSA: Arlanda, Sweden, SMHI station, no FMI', /Stockholm\/Arlanda Arpt \(ESSA\), Sweden/.test(t) && /^Sources: SMHI, MET Nordic analysis/m.test(t) && !/FMI/.test(line(t, 'Sources')) && sane(t), t);
t = await cw('Utsjoki');
check('Utsjoki: model values, nearest station (Kevo) for reference', !/Measured at/.test(t) && /Nearest weather station: Utsjoki Kevo[^(]*\(FMI\), 1\d(,\d)? km away/.test(t), t);
t = await cw('Ristiina');
check('Ristiina: Mikkeli station ~20 km for reference', /Nearest weather station: Mikkeli Lentoasema AWOS \(FMI\), (19|20|21)(,\d)? km away/.test(t), t);
t = await cw('Tallinn');
check('Tallinn: measured by the Estonian Environment Agency, not FMI', /Location: Tallinn/.test(t) && /Measured at: .*\(Keskkonnaagentuur, [\d,]+ km away\)/.test(t) && !/FMI/.test(line(t, 'Sources')) && /Keskkonnaagentuur\), https:\/\/www\.ilmateenistus\.ee/.test(t) && sane(t), t);
t = await cw('65.84,24.14');
check('Haparanda coordinates: Tornio station nearby → measured', /Measured at: Tornio/.test(t), t);
t = await cw('Mariehamn');
check('Mariehamn (Åland): FMI measurement', /Measured at: .*(Jomala|Maarianhamina|Mariehamn)/.test(t), t);
for (const [q, cc] of [['Roma', 'Italy'], ['Rooma', 'Italy'], ['Lontoo', 'United Kingdom'], ['London', 'United Kingdom'], ['Tokyo', 'Japan'], ['Pietari', 'Russia']]) {
  t = await cw(q); check(`${q} → ${cc}`, new RegExp(`Location: [^,]+, ${cc} \\(`).test(t) && sane(t), line(t, 'Location'));
}
t = await errOf('get_current_weather', { location: 'xyzzyqq' });
check('unknown place: isError with a clear message', /not found/.test(t), t);
t = await errOf('get_current_weather', { location: '' });
check('empty location: isError "Error: Location is required"', t === 'Error: Location is required', t);
{
  const r = await call('get_current_weather', { location: 'Kivistö' });
  check('structuredContent: Kivistö temperature and station match the text', r.data && r.data.measuredAt?.station === 'Vantaa Helsinki-Vantaan lentoasema' && r.text.includes(`Temperature: ${String(r.data.temperature).replace('.', ',')} °C`), r.data);
}

// ---------- 3. forecast, air quality ----------
t = (await call('get_weather_forecast', { location: 'tre', days: 7 })).text;
check('7-day forecast Tampere', (t.match(/^--- \d{4}-\d\d-\d\d ---/gm) || []).length === 7, t.slice(0, 200));
{
  const r = await call('get_weather_forecast', { location: 'tre', days: 7 });
  check('forecast Tampere: FMI meteorologist forecast for the full days (at least 5 of 7), credited', r.data.days.filter((d) => d.source === 'FMI').length >= 5 && /^Source: Finnish Meteorological Institute, meteorologist-edited forecast/m.test(r.text), r.data?.days?.map((d) => d.source));
}
const omSunrise = (/Sunrise: (\d\d:\d\d)/.exec((await call('get_weather_forecast', { location: 'EFHK', days: 1 })).text) || [])[1];
const bad = await call('get_weather_forecast', { location: 'tre', days: 30 });
check('forecast days=30: rejected or capped', bad.isError || (bad.text.match(/^--- /gm) || []).length <= 16, bad.text.slice(0, 200));
t = (await call('get_air_quality', { location: 'hki' })).text;
check('air quality hki: AQI and PM2.5', /European AQI: \d+ \(/.test(t) && /PM2\.5: [\d,]+ µg/.test(t), t);
check('air quality hki: structured pollutants with origin', (await call('get_air_quality', { location: 'hki' })).data?.pollutants?.pm25?.origin === 'measured');
check('air quality hki: measured station within 10 km, FMI first, no Tomorrow.io', /Measured at: Helsinki .* km away\), hourly average/.test(t) && /^Sources: FMI, Open-Meteo$/m.test(t) && /\(measured\)/.test(t) && !/Tomorrow/.test(t), t);
t = (await call('get_air_quality', { location: 'Roma' })).text;
check('air quality Roma: model only, European category scale', /European AQI: \d+ \((Good|Fair|Moderate|Poor|Very poor|Extremely poor)\)/.test(t) && !/measured/.test(t) && /^Sources: Open-Meteo$/m.test(t), t);

// ---------- 3b. Nordic: MET Nordic forecast, warnings in 8 countries, radar nowcast, aurora, pollen ----------
{
  let r = await call('get_weather_forecast', { location: 'Oslo', days: 2 });
  check('forecast Oslo: MET Nordic model', !r.isError && r.data?.source === 'MET Norway MET Nordic model via Open-Meteo' && r.data.days.length === 2, r.text.slice(0, 200));
  r = await call('get_weather_forecast', { location: 'Paris', days: 1 });
  check('forecast Paris: Open-Meteo default model', !r.isError && r.data?.source === 'Open-Meteo', r.data?.source);
  for (const [q, country, coverage] of [['Vaasa', 'Finland', 'point'], ['Tromsø', 'Norway', 'point'], ['Malmö', 'Sweden', 'point'], ['Copenhagen', 'Denmark', 'country'],
    ['Reykjavik', 'Iceland', 'country'], ['Tallinn', 'Estonia', 'country'], ['Riga', 'Latvia', 'country'], ['Vilnius', 'Lithuania', 'country']]) {
    r = await call('get_weather_warnings', { location: q });
    check(`warnings ${q}: ${country}, ${coverage}, credited`, !r.isError && r.data?.country === country && r.data.coverage === coverage && /Source: /.test(r.text) && Array.isArray(r.data.warnings), r.text.slice(0, 300));
  }
  r = await call('get_weather_warnings', { location: 'Vaasa', language: 'fi' });
  check('warnings Vaasa in Finnish: no English event names', !r.isError && r.data.warnings.every((w) => !/warning/i.test(w.event)), r.data?.warnings?.map((w) => w.event));
  r = await call('get_weather_warnings', { location: 'Berlin' });
  check('warnings Berlin: isError (outside the region)', r.isError && /not in these countries/.test(r.text), r.text);
  r = await call('get_precipitation_nowcast', { location: 'Bergen' });
  check('nowcast Bergen: 2 h of 5-min steps or a clear radar message', (!r.isError && r.data.steps.length >= 20 && typeof r.data.raining === 'boolean') || /radar coverage/.test(r.text), r.text.slice(0, 200));
  r = await call('get_aurora_forecast', { location: 'Tromsø' });
  check('aurora Tromsø: Kp needed 1, dark hours, chance', !r.isError && r.data.kpNeeded === 1 && r.data.darkHours >= 0 && ['none', 'low', 'moderate', 'high'].includes(r.data.chance), r.text.slice(0, 300));
  r = await call('get_aurora_forecast', { location: 'Rovaniemi' });
  check('aurora Rovaniemi: FMI R-index station nearby', !r.isError && r.data.activityNow && r.data.activityNow.distanceKm < 300, r.text.slice(0, 300));
  r = await call('get_air_quality', { location: 'hki' });
  check('air quality hki: pollen levels (CAMS)', !r.isError && r.data.pollen && ['none', 'low', 'moderate', 'high'].includes(r.data.pollen.birch?.level), JSON.stringify(r.data?.pollen));
}

// ---------- 3c. marine and road weather ----------
{
  // each country's tide gauges, with its own reference level (sea level in cm stays within ±3 m)
  for (const [q, provider, reference] of [['Helsinki', 'FMI', 'theoretical mean sea level'], ['Stockholm', 'SMHI', 'RH 2000'], ['Copenhagen', 'DMI', 'DVR90'], ['Bergen', 'Kartverket', 'mean sea level']]) {
    const r = await call('get_marine_conditions', { location: q });
    const sl = r.data?.seaLevel;
    check(`marine ${q}: sea level from ${provider} against ${reference}`, !r.isError && sl?.provider === provider && sl.reference === reference && Math.abs(sl.cm) < 300 && r.data.model, r.text.slice(0, 300));
  }
  let r = await call('get_marine_conditions', { location: 'Helsinki' });
  check('marine Helsinki: FMI sea level forecast and a wave buoy within 100 km', r.data?.seaLevelForecast?.provider === 'FMI' && (!r.data.waves || r.data.waves.distanceKm <= 100), r.text.slice(0, 400));
  r = await call('get_marine_conditions', { location: 'Tampere' });
  check('marine Tampere: isError (inland)', r.isError && /not at the coast/.test(r.text), r.text);
  r = await call('get_road_weather', { location: 'Kivistö' });
  check('road weather Kivistö: station within 30 km with a surface state, forecast steps', !r.isError && r.data.station?.distanceKm <= 30 && r.data.station.surface && r.data.forecast.length === 5 && /Fintraffic/.test(r.text), r.text.slice(0, 400));
  r = await call('get_lake_conditions', { location: 'Saimaa' });
  const sai = r.data?.waterLevels?.find((l) => l.station === 'Saimaa, Lauritsala');
  check('lake Saimaa: Lauritsala level 74–78 m N2000 within 3 days, 30-year normal, credited Syke', !r.isError && sai && sai.n2000M > 74 && sai.n2000M < 78
    && Date.now() - Date.parse(sai.date) < 3 * 86400000 && sai.normal?.years >= 20 && /Syke/.test(r.text), r.text.slice(0, 400));
  r = await call('get_lake_conditions', { location: 'Savonlinna' });
  check('lake by place Savonlinna: a Saimaa basin within 25 km', !r.isError && r.data.waterLevels[0]?.distanceKm <= 25 && r.data.waterLevels[0]?.partOf === 'Saimaa', r.text.slice(0, 300));
  r = await call('get_lake_conditions', { location: 'Stockholm' });
  check('lake Stockholm: isError (Finland only)', r.isError && /covers Finland/.test(r.text), r.text);
  r = await call('get_road_weather', { location: 'Stockholm' });
  check('road weather Stockholm: isError (Finland only)', r.isError && /covers Finland/.test(r.text), r.text);
}

// ---------- 4. astronomy ----------
t = (await call('get_astronomy', { location: 'EFHK' })).text;
const scSunrise = (/^Sunrise: (\d\d:\d\d)/m.exec(t) || [])[1];
const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3);
check('sunrise: suncalc vs Open-Meteo within 2 min', scSunrise && omSunrise && Math.abs(mins(scSunrise) - mins(omSunrise)) <= 2, [scSunrise, omSunrise]);
t = (await call('get_astronomy', { location: 'Utsjoki', date: '2026-12-21' })).text;
check('polar night Utsjoki 21 Dec', /polar night/.test(t), t);
t = (await call('get_astronomy', { location: 'Sodankylä', date: '2026-06-21' })).text;
check('midnight sun Sodankylä 21 Jun', /midnight sun/.test(t), t);
t = await errOf('get_astronomy', { location: 'hki', date: '2026-13-45' });
check('invalid date: isError with a clear message', /^Error: invalid date "2026-13-45"/.test(t), t);
t = (await call('get_astronomy', { location: 'Tokyo', date: '2026-10-14', timezone: 'Asia/Tokyo' })).text;
check('Tokyo 14 Oct: sunrise 05:4x, sunset 17:0x–17:1x (Open-Meteo 05:46/17:07)', /^Sunrise: 05:4\d$/m.test(t) && /^Sunset: 17:(0\d|1\d)$/m.test(t), t);

// ---------- 5. METAR ----------
t = (await call('get_metar', { station: 'EFHK' })).text;
const raw = (/^Raw: (.*)$/m.exec(t) || [])[1] || '';
const rt = /\s(M?\d\d)\/(M?\d\d)\s/.exec(raw);
check('EFHK METAR: temperature matches the raw report', rt && num(t, /^Temperature: (-?[\d,]+) °C/m) === parseInt(rt[1].replace('M', '-'), 10), [raw, line(t, 'Temperature')]);
check('EFHK METAR: time shown as clock time, sane visibility', /^Observation: \d\d:\d\d Finnish time/m.test(t) && (/ 9999 | CAVOK /.test(raw) ? /Visibility: 10,0 km or more/.test(t) : /Visibility: /.test(t)), t);
t = (await call('get_metar', { station: 'mikkeli' })).text;
check('mikkeli → EFMI', /METAR (for|EFMI)/.test(t) && /EFMI/.test(t), t);
{ const r = await call('get_metar', { station: 'EFKA' }); t = r.text;
check('EFKA: FMI fallback, "not a METAR", kind fmi_observation', /This is not a METAR/.test(t) && /Kauhava lentokenttä/.test(t) && r.data?.kind === 'fmi_observation', t); }
t = await errOf('get_metar', { station: 'EFVR' });
check('EFVR: no METAR and no station, isError', /No METAR data for EFVR\. FMI fallback also failed: No FMI station/.test(t), t);
t = (await call('get_metar', { station: 'KJFK' })).text;
check('KJFK: US METAR, visibility from statute miles', /Raw: METAR KJFK/.test(t) && /Visibility: [\d,]+ km/.test(t), t);
t = (await call('get_metar', { station: 'ESSA' })).text;
check('ESSA: no FMI fallback', /METAR ESSA|No METAR data|no response/.test(t) && !/Finnish Meteorological/.test(t), t);

// ---------- 6. FMI value vs the FMI API directly ----------
{
  const start = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d+Z/, 'Z');
  const xml = await (await fetch(`https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature&storedquery_id=fmi::observations::weather::simple&fmisid=100968&starttime=${start}&parameters=t2m`)).text();
  const vals = [...xml.matchAll(/<BsWfs:ParameterValue>([^<]+)</g)].map((m) => parseFloat(m[1])).filter(Number.isFinite);
  check('EFHK temperature = direct FMI observation (last 60 min)', vals.includes(efhkTemp), [efhkTemp, vals]);
}

// ---------- 7. cache, concurrency, status ----------
const t0 = Date.now(); await cw('Kivistö'); const cached = Date.now() - t0;
check(`repeat call served from cache (${cached} ms)`, cached < 300, cached);
const par = await Promise.all(['hki', 'tre', 'Kivistö', 'oulu', 'turku'].map((q) => cw(q)));
check('5 parallel calls in one session', par.every((x) => /^Currently /.test(x)), par.map((x) => x.slice(0, 40)));
t = (await call('get_weather_source_status', {})).text;
check('source status: FMI, Open-Meteo OK and cache hits', /FMI: OK/.test(t) && /Open-Meteo: OK/.test(t) && /METAR: (OK|Error)/.test(t) && num(t, /Hit rate: ([\d,]+) %/) > 0, t);

// ---------- 8. HTTP sessions (HTTP target only) ----------
if (target.startsWith('http')) {
  const cs = await Promise.all([1, 2, 3].map(() => mk()));
  const outs = await Promise.all(cs.map((x) => call('get_current_weather', { location: 'hki' }, x)));
  check('3 separate sessions respond', outs.every((o) => /^Currently /.test(o.text)));
  for (const x of cs) { try { await x._tr.terminateSession(); } catch {} await x.close(); }
}
try { await c._tr?.terminateSession(); } catch {}   // end the session so the server process exits
await c.close?.();
const fails = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - fails.length}/${results.length} OK${fails.length ? '  failed: ' + fails.map((f) => f.label).join(' ; ') : ''}`);
process.exit(fails.length ? 1 : 0);

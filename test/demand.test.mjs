import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = resolve(process.env.WEATHER_BUILD_ROOT ?? 'build');
// Mock credentials enable paid providers without spending a real quota.
Object.assign(process.env, {OPENWEATHERMAP_API_KEY:'test-not-a-secret', WEATHERAPI_KEY:'test-not-a-secret', TOMORROW_IO_API_KEY:'test-not-a-secret'});
const {aggregateCurrentWeather} = await import(pathToFileURL(resolve(root,'utils/aggregator.js')).href);
const OM = await import(pathToFileURL(resolve(root,'sources/open-meteo.js')).href);
const {resolveLocation} = await import(pathToFileURL(resolve(root,'utils/location.js')).href);
const {currentWeatherTool} = await import(pathToFileURL(resolve(root,'tools/current-weather.js')).href);
const json = v => new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const current = {time:'2026-10-18T01:00', temperature_2m:12, apparent_temperature:10,relative_humidity_2m:70,pressure_msl:1010,wind_speed_10m:3,wind_direction_10m:90,wind_gusts_10m:5,cloud_cover:20,weather_code:1,precipitation:0,dew_point_2m:8};
function dataset(){const time=Array.from({length:7},(_,i)=>`2026-10-${18+i}`);return {current:{...current},daily:{time,temperature_2m_max:time.map(()=>15),temperature_2m_min:time.map(()=>5),weather_code:time.map(()=>1),precipitation_sum:time.map(()=>0),wind_speed_10m_max:time.map(()=>4),wind_direction_10m_dominant:time.map(()=>90),uv_index_max:time.map(()=>1),sunrise:time.map(x=>x+'T07:00'),sunset:time.map(x=>x+'T18:00')}};}
async function offline(route, run){const old=globalThis.fetch,calls=[];globalThis.fetch=async(u,init)=>{const url=new URL(String(u));calls.push(url);return route(url,init);};try{return await run(calls);}finally{globalThis.fetch=old;}}
const loc=(lat,lon)=>({lat,lon,name:'Test point'});

test('100 users and current/1/7-day requests share one source/model/location representation',async()=>{
 await offline(u=>{assert.equal(u.hostname,'api.open-meteo.com'); assert.equal(u.searchParams.get('forecast_days'),'7');return json(dataset());},async calls=>{
  const results=await Promise.all(Array.from({length:100},()=>aggregateCurrentWeather(loc(40.1,-74.1),['temperature','conditions'])));
  assert.ok(results.every(r=>r.weather.temperature===12&&r.sources.length===1));
  const one=await OM.fetchOpenMeteoForecast(40.1,-74.1,1),seven=await OM.fetchOpenMeteoForecast(40.1,-74.1,7);
  assert.equal(one.data.length,1);assert.equal(seven.data.length,7);assert.equal(calls.length,1);
 });
});
test('default essentials stop before wttr and paid providers when model data suffices',async()=>{
 await offline(u=>{assert.equal(u.hostname,'api.open-meteo.com');return json(dataset());},async calls=>{
  const r=await aggregateCurrentWeather(loc(40.2,-74.2));assert.equal(r.weather.temperature,12);assert.equal(calls.length,1);assert.deepEqual(r.sources,['Open-Meteo']);
 });
});
test('conditions maps to weatherDescription; missing demand triggers one fallback and stops paid providers',async()=>{
 await offline(u=>{
  if(u.hostname==='api.open-meteo.com')return json(dataset());
  assert.equal(u.hostname,'wttr.in');return json({current_condition:[{temp_C:'99',FeelsLikeC:'98',humidity:'65',pressure:'1009',windspeedKmph:'9',winddirDegree:'180',cloudcover:'10',visibility:'8',uvIndex:'2',precipMM:'0',weatherDesc:[{value:'Clear'}]}]});
 },async calls=>{
  const r=await aggregateCurrentWeather(loc(40.3,-74.3),['conditions','visibility']);assert.equal(r.weather.temperature,12);assert.equal(r.weather.visibility,8000);assert.equal(r.weather.weatherDescription,'Mainly clear');assert.equal(calls.length,2);assert.deepEqual(r.sources,['Open-Meteo','wttr.in']);
 });
});
test('national observation satisfies explicit demand before model, optional or paid calls',async()=>{
 await offline(u=>{
  if(u.pathname.endsWith('/stations'))return json([{code:'test-national',name:'National station',coordinates:{latitude:54.9,longitude:23.9}}]);
  assert.match(u.pathname,/observations\/latest$/);return json({observations:[{observationTimeUtc:new Date().toISOString().slice(0,19).replace('T',' '),airTemperature:4,conditionCode:'cloudy'}]});
 },async calls=>{
  const r=await aggregateCurrentWeather(loc(54.9,23.9),['temperature','conditions']);assert.equal(r.weather.temperature,4);assert.equal(r.observation.station,'National station');assert.deepEqual(r.sources,['LHMT']);assert.equal(calls.length,2);
 });
});
test('distant station remains reference-only and cannot replace point weather',async()=>{
 await offline(u=>{
  if(u.hostname==='api.open-meteo.com')return json(dataset());
  if(u.pathname.endsWith('/stations'))return json([{code:'test-national',name:'National station',coordinates:{latitude:54.9,longitude:23.9}}]);
  return json({observations:[{observationTimeUtc:new Date().toISOString().slice(0,19).replace('T',' '),airTemperature:4,conditionCode:'cloudy'}]});
 },async()=>{
  const r=await aggregateCurrentWeather(loc(55.15,23.9),['temperature']);assert.equal(r.weather.temperature,12);assert.equal(r.observation,undefined);assert.equal(r.nearbyObservation.station,'National station');assert.deepEqual(r.sources,['MET Norway MET Nordic model via Open-Meteo']);
 });
});
test('hourly cloud windows share 48 hours and preserve supplied local time strings/timezone',async()=>{
 await offline(u=>{assert.equal(u.searchParams.get('forecast_hours'),'48');return json({timezone:'America/New_York',hourly:{time:Array.from({length:48},(_,i)=>`local-${i}`),cloud_cover:Array.from({length:48},(_,i)=>i)}});},async calls=>{
  const [six,full]=await Promise.all([OM.fetchOpenMeteoHourlyCloud(40.4,-74.4,6),OM.fetchOpenMeteoHourlyCloud(40.4,-74.4,48)]);assert.equal(calls.length,1);assert.equal(six.times.length,6);assert.equal(full.cloud.length,48);assert.equal(full.timezone,'America/New_York');assert.equal(full.times[0],'local-0');
 });
});
test('exact capital stops geocoding early; normalized queries share metadata',async()=>{
 await offline(u=>{assert.equal(u.hostname,'geocoding-api.open-meteo.com');return json({results:[{id:8001,name:'Tokyo',feature_code:'PPLC',country_code:'JP',latitude:35.7,longitude:139.7}]});},async calls=>{
  assert.equal((await resolveLocation('Tokyo')).country,'Japan');assert.equal((await resolveLocation('  TOKYO ')).name,'Tokyo');assert.equal(calls.length,1);
 });
});
test('ambiguous and Finnish exonym geocoding still consult languages until correct exact capital',async()=>{
 await offline(u=>{
  if(u.hostname==='aviationweather.gov')return new Response(null,{status:204});
  const query=u.searchParams.get('name'),language=u.searchParams.get('language');
  return json({results:query==='Roma'?(language==='it'?[{id:8101,name:'Roma',feature_code:'PPLC',country_code:'IT',latitude:41.9,longitude:12.5}]:[{id:8102,name:'Roma',feature_code:'PPLA2',country_code:'RO',latitude:47.8,longitude:26.6}]):(language==='fi'?[{id:8103,name:'Lontoo',feature_code:'PPLC',country_code:'GB',latitude:51.5,longitude:-.13}]:[])});
 },async calls=>{
  assert.equal((await resolveLocation('Roma')).country,'Italy');assert.equal((await resolveLocation('Lontoo')).country,'United Kingdom');assert.equal(calls.filter(u=>u.hostname==='geocoding-api.open-meteo.com').length,8);
 });
});
test('public fields validates the same names as structuredContent and accepts conditions',()=>{
 assert.deepEqual(currentWeatherTool.schema.fields.parse(['temperature','conditions']),['temperature','conditions']);assert.throws(()=>currentWeatherTool.schema.fields.parse(['weatherDescription']));assert.throws(()=>currentWeatherTool.schema.fields.parse([]));
});

test('unavailable snow-depth demand does not call providers that cannot supply it',async()=>{
 await offline(()=>assert.fail('unsupported fields must not spend an upstream call'),async calls=>{
  const r=await aggregateCurrentWeather(loc(40.6,-74.6),['snowDepth']);assert.equal(r.weather.snowDepth,undefined);assert.equal(calls.length,0);assert.deepEqual(r.sources,[]);
 });
});
test('UV demand skips providers without UV; paid provider is used only when free source fails',async()=>{
 await offline(u=>{
  if(u.hostname==='wttr.in')return new Response('{}',{status:503});
  assert.equal(u.hostname,'api.weatherapi.com');return json({current:{temp_c:12,feelslike_c:10,humidity:70,pressure_mb:1010,wind_kph:10,wind_degree:90,gust_kph:12,cloud:20,vis_km:8,uv:3,precip_mm:0,dewpoint_c:8,condition:{text:'Clear'}}});
 },async calls=>{
  const r=await aggregateCurrentWeather(loc(40.7,-74.7),['uvIndex']);assert.equal(r.weather.uvIndex,3);assert.equal(calls.length,2);assert.deepEqual(r.sources,['WeatherAPI']);
 });
});
test('cached daily forecast rolls forward at provider local midnight within the same UTC date',async()=>{
 const old=Date.now;let now=Date.parse('2026-10-18T20:59:00Z');Date.now=()=>now;
 try {
  await offline(()=>{const d=dataset();d.timezone='Europe/Helsinki';d.daily.time=d.daily.time.map(x=>now>Date.parse('2026-10-18T21:00:00Z')?x.replace(/18$/,'19'):x);return json(d);},async calls=>{
   const before=await OM.fetchOpenMeteoForecast(60.11,24.11,1);assert.equal(before.data[0].date,'2026-10-18');
   now+=120000;
   const after=await OM.fetchOpenMeteoForecast(60.11,24.11,1);assert.equal(after.data[0].date,'2026-10-19');
   await OM.fetchOpenMeteoForecast(60.11,24.11,1);assert.equal(calls.length,2);
  });
 } finally {Date.now=old;}
});

test('sub-grid coordinate precision does not fragment the model cache',async()=>{
 await offline(u=>{assert.equal(u.searchParams.get('latitude'),'40.8123');assert.equal(u.searchParams.get('longitude'),'-74.8123');return json(dataset());},async calls=>{
 const [a,b]=await Promise.all([OM.fetchOpenMeteoCurrent(40.812301,-74.812301),OM.fetchOpenMeteoForecast(40.812302,-74.812302,2)]);assert.equal(a.ok,true,a.error);assert.equal(b.ok,true,b.error);assert.equal(calls.length,1);
 });
});

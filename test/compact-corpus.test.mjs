// Recorded public source data through real handlers and SDK clients; no external requests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
process.env.MCP_WEATHER_KEY_NOTE='off';
const {createMcpServer}=await import('../build/server.js');
const fx=name=>readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8');
const records=Object.fromEntries(Object.entries(JSON.parse(fx('syke-recorded.json'))).map(([u,b])=>[new URL(u).href,b]));
const json=x=>new Response(typeof x==='string'?x:JSON.stringify(x),{headers:{'content-type':'application/json'}});
const now=Date.parse('2026-10-16T16:20:00Z');
const cases=[
 ['get_current_weather',{location:'40.01,-74.01'},'temperature'],
 ['get_weather_forecast',{location:'40.01,-74.01',days:2},'days'],
 ['get_precipitation_nowcast',{location:'60.39,5.32'},'steps'],
 ['get_weather_warnings',{location:'hki'},'warnings'],
 ['get_marine_conditions',{location:'hki'},'model'],
 ['get_lake_conditions',{location:'Saimaa'},'waterLevels'],
 ['get_road_weather',{location:'hki'},'station'],
 ['get_air_quality',{location:'40.01,-74.01'},'pollutants'],
 ['get_aurora_forecast',{location:'69.6492,18.9553'},'chance'],
 ['get_metar',{station:'EFHK'},'temperature'],
 ['get_astronomy',{location:'hki',date:'2026-10-16'},'sun'],
 ['get_weather_source_status',{},'cache'],
];
async function client(profile){const [a,b]=InMemoryTransport.createLinkedPair();await createMcpServer(profile).connect(b);const c=new Client({name:'corpus',version:'1'});await c.connect(a);return c;}
test('48 compact calls preserve canonical selected values and mandatory safety across all twelve real handlers',async()=>{
 const realFetch=globalThis.fetch,realNow=Date.now;Date.now=()=>now;
 globalThis.fetch=async u=>{u=String(u);const url=new URL(u);
  if(u in records)return json(records[u]);if(url.hostname==='rajapinnat.ymparisto.fi')return json({value:[]});
  if(u.includes('alerts.fmi.fi'))return new Response(fx('fmi-cap-atom.xml'));
  if(u.includes('/nowcast/'))return json(fx('nowcast-bergen.json'));
  if(u.includes('space.fmi.fi'))return json(fx('fmi-rindex.json'));
  if(u.includes('swpc.noaa.gov'))return json(fx('kp-forecast.json'));
  if(u.includes('air-quality-api.open-meteo.com'))return json({current:{european_aqi:20,pm2_5:0,pm10:6,nitrogen_dioxide:5,ozone:51,sulphur_dioxide:0,carbon_monoxide:169,birch_pollen:0}});
  if(u.includes('marine-api.open-meteo.com'))return json(fx('marine-openmeteo-helsinki.json'));
  if(u.includes('api.open-meteo.com'))return json({timezone:'Europe/Helsinki',current:{temperature_2m:0,apparent_temperature:0,relative_humidity_2m:70,pressure_msl:1010,wind_speed_10m:0,wind_direction_10m:0,wind_gusts_10m:0,cloud_cover:0,weather_code:0,precipitation:0},daily:{time:['2026-10-16','2026-10-17'],temperature_2m_max:[8,9],temperature_2m_min:[0,0],weather_code:[0,1],precipitation_sum:[0,0],wind_speed_10m_max:[0,2],wind_direction_10m_dominant:[0,90],uv_index_max:[0,1],sunrise:['2026-10-16T08:00','2026-10-17T08:03'],sunset:['2026-10-16T18:00','2026-10-17T17:57']},hourly:{time:['2026-10-16T18:00'],cloud_cover:[0]}});
  if(u.includes('mareograph::'))return new Response(fx('marine-fmi-mareograph.xml'));
  if(u.includes('wave::'))return new Response(fx('marine-fmi-wave.xml'));
  if(u.includes('sealevel::'))return new Response(fx('marine-fmi-sealevel.xml'));
  if(u==='https://tie.digitraffic.fi/api/weather/v1/stations')return json(fx('road-stations.json'));
  const road=/\/stations\/(1002|1041)\/data$/.exec(u);if(road)return json(fx('road-data-'+road[1]+'.json').replaceAll('2026-10-15','2026-10-16'));
  if(u.includes('/forecast-sections/forecasts'))return json(fx('road-forecast-helsinki.json').replaceAll('2026-10-15','2026-10-16'));
  if(u.includes('aviationweather.gov/api/data/metar'))return json([{icaoId:'EFHK',name:'Helsinki',lat:60.3172,lon:24.9633,obsTime:1792167000,temp:0,dewp:0,wdir:0,wspd:0,visib:'6+',altim:1010,rawOb:'EFHK 161600Z 00000KT CAVOK 00/00 Q1010',fltCat:'VFR',clouds:[]}]);
  throw Error('Fixture unavailable');
 };
 const full=await client('full'),compact=await client('compact'),measurements=[];
 try{
  for(const [name,args,field] of cases){
   const canonical=await full.callTool({name,arguments:args});assert.ok(!canonical.isError,name+': '+canonical.content[0]?.text);assert.ok(canonical.structuredContent,name);canonical.structuredContent=JSON.parse(JSON.stringify(canonical.structuredContent));
   for(const selection of [{},{detail:'full'},{fields:[field]},{fields:[field],detail:'full'}]){
    const r=await compact.callTool({name,arguments:{...args,...selection}});assert.ok(!r.isError,name+': '+r.content[0]?.text);assert.equal(r.content.length,1);assert.equal(r.structuredContent,undefined);
    const data=JSON.parse(r.content[0].text);
    // Status counters legitimately advance while the test runs; all other selected values must remain exact.
    if(name!=='get_weather_source_status')for(const [k,v] of Object.entries(data)){if(!k.startsWith('_')&&k!=='apiKeys')assert.deepEqual(v,canonical.structuredContent[k],name+'.'+k);}
    if(selection.fields)assert.ok(Object.hasOwn(data,field),name+'.'+field);
    for(const k of ['location','source','sources','measuredAt','nearestStation','country','coverage','kind'])if(Object.hasOwn(canonical.structuredContent,k))assert.deepEqual(data[k],canonical.structuredContent[k],name+'.'+k);
    for(const [tool,keys] of [['get_lake_conditions',['waterLevels','waterTemperatures','ice']],['get_weather_warnings',['warnings']],['get_road_weather',['station','forecast','sections']],['get_metar',['raw','flightCategory']]])if(name===tool)for(const k of keys)if(Object.hasOwn(canonical.structuredContent,k))assert.deepEqual(data[k],canonical.structuredContent[k],name+'.safety.'+k);
    measurements.push({name,selection,full:JSON.stringify(canonical),compact:JSON.stringify(r)});
   }
  }
  assert.equal(measurements.length,48);console.log('COMPACT_CORPUS_48_PRESERVED');
  if(process.env.MCP_MEASUREMENT_FILE)writeFileSync(process.env.MCP_MEASUREMENT_FILE,JSON.stringify({discovery:{full:await full.listTools(),compact:await compact.listTools()},cases:measurements}));
 }finally{await full.close();await compact.close();globalThis.fetch=realFetch;Date.now=realNow;}
});

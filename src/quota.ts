import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, fsyncSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

type Limits = { minute: number; hour: number; day: number; month: number };
type Entry = { minute: number; hour: number; day: number; month: number; counts: number[]; blockedUntil: number; failures: number; attempts: number[]; lastAt: number };
const defaults: Limits = { minute: 30, hour: 200, day: 1000, month: 10000 };
function defaultLimits(provider:string):Limits { return provider==='tomorrow-io'?{minute:10,hour:20,day:200,month:5000}:provider==='open-meteo'||provider==='rajapinnat.ymparisto.fi'?{...defaults,minute:60}:defaults; }
const overrides: Record<string, Limits> = {};
if (config.quotaLimitsJson) {
  const parsed: unknown = JSON.parse(config.quotaLimitsJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid WEATHER_QUOTAS_JSON');
  for (const [provider, limits] of Object.entries(parsed)) {
    if (!/^[a-z0-9.-]{1,100}$/.test(provider) || !limits || typeof limits !== 'object' || Array.isArray(limits)) throw Error('Invalid quota provider');
    const v = limits as Record<string, unknown>;
    if (Object.keys(v).some(k => !['minute', 'hour', 'day', 'month'].includes(k))) throw Error('Invalid quota field');
    const merged = { ...defaultLimits(provider), ...v } as Limits;
    if (Object.values(merged).some(n => !Number.isSafeInteger(n) || n < 1 || n > 100000000)) throw Error('Invalid quota limit');
    overrides[provider] = merged;
  }
}
export function requestIdentity(url: URL, headers: Record<string,string> = {}): { provider: string; account: string; cost: number } {
  const host = url.hostname;
  const provider = (host==='open-meteo.com' || host.endsWith('.open-meteo.com')) ? 'open-meteo' : host === 'api.openweathermap.org' ? 'openweathermap' : host === 'api.weatherapi.com' ? 'weatherapi' : host === 'api.tomorrow.io' ? 'tomorrow-io' : host;
  // Credentials define an account budget; representation headers must never mint a new allowance.
  const credentials = [...url.searchParams].filter(([k]) => /key|token|secret|auth/i.test(k)).sort();
  const account = createHash('sha256').update(JSON.stringify([credentials, Object.entries(headers).filter(([k])=>/key|token|secret|auth|cookie/i.test(k)).map(([k,v])=>[k.toLowerCase(),v]).sort()])).digest('hex');
  // Open-Meteo prices >10 variables or >14 days as multiple calls. Round up
  // conservatively; these are budget units, not a billing reconciliation.
  const count = (name: string) => (url.searchParams.get(name) ?? '').split(',').filter(Boolean).length;
  const variables = ['current','hourly','daily','minutely_15'].reduce((n,k)=>n+count(k),0);
  const days = Number(url.searchParams.get('forecast_days') ?? 0) + Number(url.searchParams.get('past_days') ?? 0);
  const cost = provider === 'open-meteo' ? Math.ceil(Math.max(1,variables/10) * Math.max(1,days/14) * Math.max(1,count('latitude')) * Math.max(1,count('models'))) : 1;
  if (!Number.isSafeInteger(cost) || cost < 1 || cost > 10000) throw Error('Invalid upstream request cost');
  return { provider, account, cost };
}
export class Quota {
  constructor(private dir = config.stateDir, private limits = overrides, private now = () => Date.now()) {}
  private transaction<T>(fn: (entries: Record<string,Entry>)=>T, persist = true): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw Error('Quota state directory must be private and service-owned');
    const lock = join(this.dir, 'quota.lock');
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw Error('Quota state locked (active transaction or interrupted owner; inspect quota.lock before manual recovery); refusing upstream request'); }
    try {
      const file = join(this.dir, 'quota.json');
      let entries: Record<string,Entry> = {};
      try {
        if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 1024*1024) throw Error('Invalid quota state');
        const state = JSON.parse(readFileSync(file,'utf8'));
        if (state.version !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) throw Error('Invalid quota state');
        entries = state.entries;
        for (const [key,e] of Object.entries(entries)) if (!/^[a-z0-9.-]+:[a-f0-9]{64}$/.test(key) || !e || ![e.minute,e.hour,e.day,e.month,e.blockedUntil,e.failures,e.lastAt,...(Array.isArray(e.counts)?e.counts:[])].every(n=>Number.isSafeInteger(n)&&n>=0) || e.counts?.length!==4 || !Array.isArray(e.attempts) || !e.attempts.every((n:number,i:number)=>Number.isSafeInteger(n)&&n>=0&&n<=e.lastAt&&(i===0||n>=e.attempts[i-1]))) throw Error('Invalid quota state');
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Quota state corrupt; refusing upstream request'); }
      const result = fn(entries);
      if (!persist) return result;
      if (Object.keys(entries).length > 2048) throw Error('Quota state capacity reached');
      const temp = join(this.dir, `quota-${randomUUID()}.tmp`);
      const fd = openSync(temp,'wx',0o600);
      try { const encoded=JSON.stringify({version:1,entries});if(Buffer.byteLength(encoded)>1024*1024)throw Error('Quota state capacity reached');writeFileSync(fd,encoded); fsyncSync(fd); } catch(err) { rmSync(temp,{force:true});throw err; } finally { closeSync(fd); }
      renameSync(temp,file);
      const d = openSync(this.dir,'r'); try { fsyncSync(d); } finally { closeSync(d); }
      return result;
    } finally { rmSync(lock,{recursive:true}); }
  }
  reserve(provider:string, account:string, cost = 1): void {
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 10000) throw Error('Invalid reservation cost');
    this.transaction(entries=> {
      const now=this.now(), date=new Date(now), windows=[Math.floor(now/60000),Math.floor(now/3600000),Math.floor(now/86400000),date.getUTCFullYear()*12+date.getUTCMonth()];
      const key=`${provider}:${account}`;
      const e=entries[key]??{minute:windows[0],hour:windows[1],day:windows[2],month:windows[3],counts:[0,0,0,0],blockedUntil:0,failures:0,attempts:[],lastAt:now};
      const old=[e.minute,e.hour,e.day,e.month];
      if (e.lastAt>now || old.some((n,i)=>n>windows[i])) throw Error('Quota clock moved backwards');
      e.counts=e.counts.map((n,i)=>old[i]===windows[i]?n:0);
      e.attempts=e.attempts.filter(n=>n>now-3600000);
      e.counts[0]=e.attempts.filter(n=>n>now-60000).length;e.counts[1]=e.attempts.length;
      const limits=this.limits[provider]??defaultLimits(provider);
      if (e.blockedUntil>now || e.counts.some((n,i)=>n+cost>[limits.minute,limits.hour,limits.day,limits.month][i])) throw Error(`Upstream budget unavailable (${provider})`);
      [e.minute,e.hour,e.day,e.month]=windows;e.lastAt=now;e.attempts.push(...Array<number>(cost).fill(now)); e.counts=e.counts.map(n=>n+cost); entries[key]=e;
    });
  }
  observe(provider:string,account:string,status:number,retryAfter:string|null):void {
    this.transaction(entries=>{
      const e=entries[`${provider}:${account}`]; if(!e) throw Error('Missing quota reservation');
      if(status===429 || status>=500) {
        e.failures=Math.min(e.failures+1,20);
        const seconds=retryAfter && /^\d+$/.test(retryAfter)?Number(retryAfter)*1000:retryAfter?Date.parse(retryAfter)-this.now():0;
        const delay=Number.isFinite(seconds)?Math.max(0,seconds):0;
        e.blockedUntil=Math.min(8640000000000000,Math.max(e.blockedUntil,this.now()+Math.max(delay,status===429?60000:Math.min(300000,1000*2**e.failures))));
      } else if(status<400) e.failures=0;
    });
  }
  getStats(): Array<{provider:string; accounts:number; used:number; usedHour:number; limitHour:number; remainingHour:number; limitDay:number; remainingDay:number; blocked:boolean; blockedUntil?:string}> {
    try { return this.transaction(entries=>{
      const result=new Map<string,{provider:string;accounts:number;used:number;usedHour:number;limitHour:number;remainingHour:number;limitDay:number;remainingDay:number;blocked:boolean;blockedUntil?:string}>();
      for(const [key,e] of Object.entries(entries)) {
        const provider=key.split(':')[0],limits=this.limits[provider]??defaultLimits(provider);
        const s=result.get(provider)??{provider,accounts:0,used:0,usedHour:0,limitHour:0,remainingHour:0,limitDay:0,remainingDay:0,blocked:false};
        const used=e.day===Math.floor(this.now()/86400000)?e.counts[2]:0, hour=e.attempts.filter(n=>n>this.now()-3600000).length;
        s.accounts++;s.used+=used;s.usedHour+=hour;s.limitHour+=limits.hour;s.limitDay+=limits.day;s.remainingHour+=Math.max(0,limits.hour-hour);s.remainingDay+=Math.max(0,limits.day-used);
        s.blocked ||= e.lastAt>this.now() || e.blockedUntil>this.now() || hour>=limits.hour || used>=limits.day || e.attempts.filter(n=>n>this.now()-60000).length>=limits.minute || (e.month===new Date(this.now()).getUTCFullYear()*12+new Date(this.now()).getUTCMonth()&&e.counts[3]>=limits.month);
        if(e.blockedUntil>this.now()) s.blockedUntil=new Date(Math.min(8640000000000000,e.blockedUntil)).toISOString();
        result.set(provider,s);
      }
      return [...result.values()];
    }, false); } catch { return [{provider:'state-unavailable',accounts:0,used:0,usedHour:0,limitHour:0,remainingHour:0,limitDay:0,remainingDay:0,blocked:true}]; }
  }
}
export const quota = new Quota();

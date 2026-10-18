// Each test-file process gets private persistent state; restart tests explicitly share their own fixture directory.
import {mkdtempSync,rmSync} from 'node:fs';
import {beforeEach} from 'node:test';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const parent=process.env.MCP_TEST_ROOT??tmpdir();
process.env.MCP_STATE_DIR=mkdtempSync(join(parent,'weather-state-'));
process.env.OPENWEATHERMAP_API_KEY='';
process.env.WEATHERAPI_KEY='';
process.env.TOMORROW_IO_API_KEY='';

// Independent fixture cases must not inherit another case's mock outage circuit or shifted clock.
const fileState=process.env.MCP_STATE_DIR;
beforeEach(()=>{for(const name of ['quota.json','quota.lock'])rmSync(join(fileState,name),{recursive:true,force:true});});

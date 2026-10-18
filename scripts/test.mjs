import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=mkdtempSync(join(tmpdir(),'mcp-weather-tests-'));
try {
  const r=spawnSync(process.execPath,['--test','--import','./test/isolated-state.mjs','test/*.test.mjs'],{stdio:'inherit',env:{...process.env,MCP_TEST_ROOT:root}});
  if(r.error)throw r.error;
  process.exitCode=r.status??1;
} finally {rmSync(root,{recursive:true,force:true});}

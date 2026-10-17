import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
await build({
  entryPoints: ['src/index.ts'], outfile: 'build/weather.mjs', bundle: true,
  platform: 'node', target: 'node22', format: 'esm', minify: true,
  // CommonJS dependencies still need Node builtins at runtime.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await chmod('build/index.js', 0o755);

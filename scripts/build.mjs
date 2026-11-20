import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const outputDirectory = 'dist';

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  bundle: true,
  entryPoints: ['src/index.js'],
  format: 'iife',
  outfile: `${outputDirectory}/Code.js`,
  platform: 'browser',
  target: 'es2019',
  legalComments: 'none'
});
await cp('appsscript.json', `${outputDirectory}/appsscript.json`);

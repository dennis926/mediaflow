#!/usr/bin/env node
// Emits both CJS (dist/*.js) and ESM (dist/esm/*.js). Bundlers such as Vite/Rollup need the
// ESM build to statically analyse named exports; Node/ts-node keep using the CJS build.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const esmDir = resolve(here, '../dist/esm');
mkdirSync(esmDir, { recursive: true });
writeFileSync(resolve(esmDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
process.stdout.write('shared: marked dist/esm as ESM\n');

// Builds the package: compiles src/ with tsc as ES modules into dist/esm and as CommonJS into
// dist/cjs, each with its own package.json that pins the module format. The model is a generated
// TypeScript module (src/model-data.ts), so there is no data file to locate at runtime.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = require.resolve('typescript/bin/tsc');

function runTsc(project, ...args) {
    const result = spawnSync(process.execPath, [tsc, '-p', project, ...args], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
runTsc('tsconfig.esm.json');
// The ES module compile has already type-checked the same sources
runTsc('tsconfig.cjs.json', '--noCheck');
for (const [format, type] of [
    ['esm', 'module'],
    ['cjs', 'commonjs']
]) {
    fs.writeFileSync(path.join(root, 'dist', format, 'package.json'), JSON.stringify({ type }, null, 4) + '\n');
}

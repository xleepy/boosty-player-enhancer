import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Check all authored ESM scripts without executing browser-only entry points.
const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'scripts']) {
  for (const name of (await readdir(path.join(root, directory))).filter(name => name.endsWith('.js')).sort()) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, name)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('Source and build scripts passed syntax checks');

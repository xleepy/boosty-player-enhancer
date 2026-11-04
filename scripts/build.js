import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

// Builds the installable extension from ESM sources and static assets. Only
// generated dist/ files are replaced; a version tag must match the manifest.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    [pkg.version, lock.version, lock.packages[''].version].some(version => version !== manifest.version)) {
  throw new Error('Manifest, package.json and package-lock.json must have the same x.y.z version');
}
if (process.env.GITHUB_REF?.startsWith('refs/tags/') &&
    process.env.GITHUB_REF !== `refs/tags/v${manifest.version}`) {
  throw new Error(`Release tag must be v${manifest.version}`);
}

const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'extension'), path.join(dist, 'extension'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { content: 'src/content.js', popup: 'src/popup.js' },
  outdir: 'dist/extension',
  bundle: true,
  format: 'iife',
  banner: { js: '"use strict";' },
  platform: 'browser',
  target: 'chrome111',
  charset: 'utf8',
  sourcemap: false,
  legalComments: 'none',
});
console.log(`Built Boosty Autoplay ${manifest.version} in dist/extension/`);

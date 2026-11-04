import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync } from 'fflate';

// Packages only the built extension and installation instructions. The ZIP is
// deterministic; SHA256SUMS describes the exact archive uploaded to a release.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const extension = path.join(dist, 'extension');
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const files = {};
async function collect(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const absolute = path.join(directory, name);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) await collect(absolute);
    else if (stat.isFile()) {
      const relative = path.relative(extension, absolute).split(path.sep).join('/');
      files[`boosty-autoplay/${relative}`] = new Uint8Array(await readFile(absolute));
    } else throw new Error(`Unsupported archive entry: ${absolute}`);
  }
}
await collect(extension);
files['boosty-autoplay/INSTALL.txt'] = new TextEncoder().encode(
  `Boosty Autoplay ${manifest.version}\n\n` +
  '1. Распакуйте архив в постоянную папку. Node.js и сборка не нужны.\n' +
  '2. Откройте chrome://extensions и включите «Режим разработчика».\n' +
  '3. Нажмите «Загрузить распакованное расширение» и выберите boosty-autoplay.\n' +
  '4. Обновите вкладку Boosty. Не удаляйте подключённую папку.\n\n' +
  'При обновлении замените файлы в той же папке, перезагрузите расширение\n' +
  'в chrome://extensions и обновите вкладку Boosty.\n\n' +
  'Исходники: https://github.com/xleepy/boosty-player-enhancer\n'
);
const entries = Object.fromEntries(Object.entries(files).map(([name, bytes]) =>
  [name, [bytes, { mtime: new Date(2000, 0, 1) }]]));
const archive = zipSync(entries, { level: 9 });
const extracted = unzipSync(archive);
if (Object.keys(extracted).length !== Object.keys(files).length ||
    Object.entries(files).some(([name, bytes]) => !Buffer.from(bytes).equals(Buffer.from(extracted[name])))) {
  throw new Error('ZIP verification failed');
}
const filename = `boosty-autoplay-${manifest.version}.zip`;
await writeFile(path.join(dist, filename), archive);
const digest = createHash('sha256').update(archive).digest('hex');
await writeFile(path.join(dist, 'SHA256SUMS'), `${digest}  ${filename}\n`);
console.log(`Packaged dist/${filename} (${Object.keys(files).length} files)`);

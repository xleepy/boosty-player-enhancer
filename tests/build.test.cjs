const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const extensionRoot = path.resolve(__dirname, '../dist/extension');

test('the built extension includes every manifest and popup asset needed for installation', t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  const popup = new JSDOM(fs.readFileSync(path.join(extensionRoot, manifest.action.default_popup), 'utf8'));
  t.after(() => popup.window.close());
  const assets = [
    ...manifest.content_scripts.flatMap(script => [...script.js, ...script.css]),
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
    ...[...popup.window.document.querySelectorAll('script[src], link[rel="stylesheet"][href], img[src]')]
      .map(element => element.getAttribute('src') || element.getAttribute('href')),
  ];

  for (const asset of new Set(assets)) {
    const absolute = path.resolve(extensionRoot, asset);
    assert.equal(path.relative(extensionRoot, absolute).startsWith('..'), false,
      `The extension references an asset outside its package: ${asset}`);
    assert.ok(fs.statSync(absolute).isFile(), `The extension is missing ${asset}`);
  }
});

test('the built content script and popup run as classic scripts without module loading', t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  const popup = new JSDOM(fs.readFileSync(path.join(extensionRoot, manifest.action.default_popup), 'utf8'));
  t.after(() => popup.window.close());
  const popupScripts = [...popup.window.document.querySelectorAll('script[src]')];
  for (const script of popupScripts) assert.notEqual(script.type, 'module');
  assert.equal(manifest.content_scripts[0].js.length, 1,
    'Chrome should load one self-contained content script');
  const scripts = [...manifest.content_scripts.flatMap(script => script.js),
    ...popupScripts.map(script => script.getAttribute('src'))];

  for (const script of scripts) {
    const source = fs.readFileSync(path.join(extensionRoot, script), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: script }),
      `${script} is not valid as a classic Chrome extension script`);
    assert.doesNotMatch(source, /\bimport\s*\(/,
      `${script} would need to load a module after installation`);
  }
});

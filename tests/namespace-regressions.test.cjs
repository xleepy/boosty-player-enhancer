const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, eventually } = require('./helpers/boosty-fixture.cjs');

const collisions = [
  { name: 'an element id', elements: [{ tag: 'div', id: 'BoostyEnhancer' }] },
  { name: 'duplicate element ids', elements: [
    { tag: 'div', id: 'BoostyEnhancer' }, { tag: 'div', id: 'BoostyEnhancer' },
  ] },
  { name: 'a named iframe', elements: [{ tag: 'iframe', name: 'BoostyEnhancer' }] },
];

for (const { name, elements } of collisions) {
  test(`the bundle preserves ${name} named BoostyEnhancer without exposing module exports`, async t => {
    let pageValue;
    let nodes;
    const p = fixture({ count: 2, beforeScripts(window) {
      nodes = elements.map(({ tag, ...attributes }) => {
        const node = window.document.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
        window.document.body.append(node);
        return node;
      });
      pageValue = window.BoostyEnhancer;
      assert.ok(pageValue, 'The page must expose a named value before the extension starts');
    } });
    t.after(() => p.close());

    assert.equal(Object.hasOwn(p.window, 'BoostyEnhancer'), false,
      'The bundle must not install a module registry on the global object');
    if (pageValue instanceof p.window.HTMLCollection) {
      assert.deepEqual(Array.from(p.window.BoostyEnhancer), nodes,
        'The bundle replaced the page\'s named element collection');
    } else {
      assert.equal(p.window.BoostyEnhancer, pageValue,
        'The bundle replaced the page\'s named DOM value');
    }
    for (const factory of ['createPlayers', 'createWindowView', 'createAutoplay']) {
      assert.equal(Object.hasOwn(pageValue, factory), false,
        `The extension exported ${factory} onto a page-owned object`);
    }
    await p.enable();
    await p.enterWindow();
    for (const node of nodes) node.remove();
    assert.equal(p.window.BoostyEnhancer, undefined,
      'Removing named elements must not reveal an extension registry');
    await p.start();
    p.end(0);
    await eventually(() => p.calls.play.includes(1), 'The next player did not start after removing the named DOM');
    await eventually(() => p.blocks[1].hasAttribute('data-bpa-stage'), 'Window view did not follow playback');
    assert.equal(p.videos.get(1).paused, false);
    assert.equal(p.players.get(1).root.querySelector('.bpa-window-toggle').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(p.errors, []);
  });
}

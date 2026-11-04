const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const sourcePath = path.resolve(__dirname, '../extension/content.js');
const POST = 'bf1407b6-54fd-4c33-96b5-310f2d57280f';
const OTHER = '8116cf3e-a608-4005-893d-e16b22abb0e9';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(check, message, timeout = 3500) {
  const deadline = Date.now() + timeout;
  do {
    if (check()) return;
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail(message);
}

// Runs the shipped content script against open Shadow DOM, not exported test hooks.
function fixture({ count = 3, lazyIndex = -1, storedEnabled = false,
  regionLabel = 'Video player', controlsInitially = true, lazyVideoInitially = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `https://boosty.to/creator/posts/${POST}`,
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const changes = new Set();
  const storage = { enabled: storedEnabled };
  const videos = new Map();
  const finishes = new Map();
  const players = new Map();
  const blocks = [];
  const calls = { play: [], pause: [], fullscreen: [], exit: 0, scroll: [], native: [], nativePlay: [] };
  const fullscreenStack = [];
  let scrollHook = () => {};
  let rejectPlay = null;
  let deferredKey = null;
  const deferredPlays = new Map();
  const errors = [];
  window.addEventListener('error', event => errors.push(event.error));
  Object.defineProperty(document, 'fullscreenElement', { get: () => fullscreenStack.at(-1) || null });
  Object.defineProperty(document, 'fullscreenEnabled', { value: true });
  window.HTMLElement.prototype.requestFullscreen = async function () {
    if (fullscreenStack.at(-1) !== this) fullscreenStack.push(this);
    calls.fullscreen.push(this);
    document.dispatchEvent(new window.Event('fullscreenchange'));
  };
  document.exitFullscreen = async () => {
    fullscreenStack.pop();
    calls.exit++;
    document.dispatchEvent(new window.Event('fullscreenchange'));
  };
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && document.fullscreenElement) {
      calls.native.push('escape');
      document.exitFullscreen();
    }
  });
  window.HTMLElement.prototype.scrollIntoView = function () {
    calls.scroll.push(this);
    scrollHook(this);
  };
  window.scrollTo = () => {};
  window.chrome = {
    runtime: { id: 'test-extension' },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storage[k]]));
          return { ...keys, ...storage };
        },
        async set(values) {
          const delta = Object.fromEntries(Object.entries(values).map(([key, newValue]) =>
            [key, { oldValue: storage[key], newValue }]));
          Object.assign(storage, values);
          for (const listener of changes) listener(delta, 'local');
        },
      },
      onChanged: {
        addListener(listener) { changes.add(listener); },
        removeListener(listener) { changes.delete(listener); },
      },
    },
  };
  function makeVideo(key, root) {
    const video = document.createElement('video');
    video.className = 'player-media';
    let paused = true;
    let ended = false;
    Object.defineProperties(video, {
      paused: { get: () => paused },
      ended: { get: () => ended },
      readyState: { get: () => 4 },
      duration: { get: () => 180 },
      currentSrc: { get: () => `blob:https://boosty.to/${key}` },
    });
    video.play = () => {
      calls.play.push(key);
      if (rejectPlay?.(key)) return Promise.reject(new window.DOMException('Blocked', 'NotAllowedError'));
      if (deferredKey === key) {
        paused = false;
        ended = false;
        video.dispatchEvent(new window.Event('play'));
        return new Promise((resolve, reject) => {
          deferredPlays.set(key, {
            resolve() {
              deferredPlays.delete(key);
              paused = false;
              ended = false;
              video.dispatchEvent(new window.Event('playing'));
              resolve();
            }, reject,
          });
        });
      }
      paused = false;
      ended = false;
      video.dispatchEvent(new window.Event('play'));
      video.dispatchEvent(new window.Event('playing'));
      return Promise.resolve();
    };
    video.pause = () => {
      calls.pause.push(key);
      paused = true;
      if (deferredPlays.has(key)) {
        deferredPlays.get(key).reject(new window.DOMException('Aborted by pause', 'AbortError'));
        deferredPlays.delete(key);
      }
      video.dispatchEvent(new window.Event('pause'));
    };
    root.prepend(video);
    videos.set(key, video);
    finishes.set(key, () => {
      paused = true;
      ended = true;
      video.dispatchEvent(new window.Event('ended'));
    });
    return video;
  }
  function mount(block, key, { lazyVideo = lazyVideoInitially, controls = controlsInitially } = {}) {
    const player = document.createElement('vk-video-player');
    const holder = document.createElement('div');
    holder.className = 'shadow-root-container';
    player.append(holder);
    const root = holder.attachShadow({ mode: 'open' });
    const playLabel = regionLabel === 'Видеоплеер' ? 'Смотреть' : 'Play';
    root.innerHTML = `<div class="keyboard-controls" role="region" aria-label="${regionLabel}" tabindex="-1">
      <div data-testid="unstarted-thumb"><div role="button" aria-label="${playLabel}">${playLabel}</div></div>
      ${controls ? '<div data-testid="player_controls"><div class="controls-right"><button data-testid="fullscreen-btn" aria-label="Full screen">Fullscreen</button></div></div>' : ''}
    </div>`;
    const thumb = root.querySelector('[data-testid="unstarted-thumb"]');
    // Media readiness does not imply that VK's preview UI was initialized.
    // Only the native play path dismisses this separate overlay.
    thumb.getClientRects = () => thumb.classList.contains('hidden') || thumb.style.visibility === 'hidden'
      ? [] : [{ width: 640, height: 360 }];
    root.querySelector('[data-testid="unstarted-thumb"] [role="button"]').addEventListener('click', () => {
      calls.nativePlay.push(key);
      thumb.classList.add('hidden');
      thumb.style.visibility = 'hidden';
      const video = videos.get(key) || makeVideo(key, root);
      video.play().catch(() => {});
    });
    if (!lazyVideo) makeVideo(key, root);
    const nativeFullscreen = () => document.fullscreenElement
      ? document.exitFullscreen() : player.requestFullscreen();
    root.querySelector('[data-testid="fullscreen-btn"]')?.addEventListener('click', () => {
      calls.native.push('button');
      nativeFullscreen();
    });
    root.addEventListener('keydown', event => {
      if (event.key.toLowerCase() === 'f') { calls.native.push('f'); nativeFullscreen(); }
    });
    root.addEventListener('dblclick', () => { calls.native.push('dblclick'); nativeFullscreen(); });
    block.append(player);
    players.set(key, { player, root, block });
    return player;
  }
  function makePost(id) {
    const post = document.createElement('div');
    post.dataset.postId = id;
    post.dataset.testId = 'COMMON_POST:ROOT';
    post.innerHTML = '<article></article>';
    document.body.append(post);
    return post;
  }
  const otherPost = makePost(OTHER);
  const otherBlock = document.createElement('div');
  otherBlock.id = 'video-other';
  otherPost.firstChild.append(otherBlock);
  mount(otherBlock, 'other');
  const post = makePost(POST);
  for (let i = 0; i < count; i++) {
    const block = document.createElement('div');
    block.id = `video-${i}`;
    post.firstChild.append(block);
    blocks.push(block);
    if (i !== lazyIndex) mount(block, i);
  }
  window.eval(fs.readFileSync(sourcePath, 'utf8'));
  const api = {
    dom, window, document, videos, players, blocks, post, otherPost, calls, errors, storage,
    mount,
    setScrollHook(fn) { scrollHook = fn; },
    setRejectPlay(fn) { rejectPlay = fn; },
    setDeferredPlay(key) { deferredKey = key; },
    completeDeferredPlay(key) { deferredPlays.get(key)?.resolve(); },
    async ready() {
      await eventually(() => players.get(0)?.root.querySelector('.bpa-toggle'), 'Toggle was not inserted');
    },
    async enable() {
      await api.ready();
      const toggle = players.get(0).root.querySelector('.bpa-toggle');
      if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
      await eventually(() => toggle.getAttribute('aria-pressed') === 'true', 'Toggle did not enable');
    },
    async enterWindow(key = 0) {
      await api.ready();
      const toggle = players.get(key).root.querySelector('.bpa-window-toggle');
      assert.ok(toggle, 'Window-mode control was not inserted');
      toggle.click();
      await eventually(() => document.documentElement.hasAttribute('data-bpa-windowed'), 'Window mode did not open');
    },
    async start(key = 0) {
      // This helper represents a player the user has already started normally.
      const thumb = players.get(key).root.querySelector('[data-testid="unstarted-thumb"]');
      thumb.classList.add('hidden');
      thumb.style.visibility = 'hidden';
      await videos.get(key).play();
      await delay(30);
    },
    end(key) { finishes.get(key)(); },
    close() { dom.window.close(); },
  };
  return api;
}

test('disabled by default: ended does not start another video', async t => {
  const p = fixture(); t.after(() => p.close());
  await p.ready();
  assert.equal(p.players.get(0).root.querySelector('.bpa-toggle').getAttribute('aria-pressed'), 'false');
  await p.start(); p.end(0); await delay(220);
  assert.deepEqual(p.calls.play, [0]);
});

test('plays the next video in the same post, transfers preferences, then stops at the last', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  p.videos.get(0).volume = 0.37;
  p.videos.get(0).muted = true;
  p.videos.get(0).playbackRate = 1.5;
  p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Second video did not start');
  assert.equal(p.videos.get(1).volume, 0.37);
  assert.equal(p.videos.get(1).muted, true);
  assert.equal(p.videos.get(1).playbackRate, 1.5);
  assert.equal(p.calls.play.includes('other'), false);
  p.end(1); await delay(250);
  assert.equal(p.calls.play.filter(key => key === 0).length, 1, 'Last video must not wrap to first');
  assert.equal(p.calls.play.includes('other'), false);
});

test('window mode follows the queue and keeps all native controls and DOM parents intact', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  const originals = [...p.players.values()].map(r => [r.player, r.player.parentNode]);
  const nativeControls = [...p.players.values()].map(r => [r.root, r.root.querySelector('[data-testid="player_controls"]')]);
  await p.enterWindow();
  p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Next video did not play');
  assert.equal(p.document.fullscreenElement, null);
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
  assert.equal(p.calls.exit, 0);
  assert.equal(p.calls.fullscreen.length, 0);
  for (const [player, parent] of originals) assert.equal(player.parentNode, parent);
  for (const [root, control] of nativeControls) assert.equal(root.querySelector('[data-testid="player_controls"]'), control);
  assert.ok(p.blocks[1].hasAttribute('data-bpa-stage'));
});

test('loads a lazy next block before starting its video', async t => {
  const p = fixture({ count: 2, lazyIndex: 1 }); t.after(() => p.close());
  p.setScrollHook(block => { if (block === p.blocks[1] && !p.players.has(1)) p.mount(block, 1, { lazyVideo: true }); });
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Lazy video did not initialize and play');
  assert.equal(p.calls.play.includes('other'), false);
});

test('disabling autoplay while next block loads prevents a late autoplay', async t => {
  const p = fixture({ count: 2, lazyIndex: 1 }); t.after(() => p.close());
  await p.enable(); await p.start(); p.end(0); await delay(50);
  p.players.get(0).root.querySelector('.bpa-toggle').click();
  p.mount(p.blocks[1], 1);
  await delay(1400);
  assert.equal(p.calls.play.includes(1), false);
});

test('SPA navigation invalidates an in-flight transition', async t => {
  const p = fixture({ count: 2, lazyIndex: 1 }); t.after(() => p.close());
  await p.enable(); await p.start(); p.end(0); await delay(40);
  p.window.history.pushState({}, '', `/creator/posts/${OTHER}`);
  p.window.dispatchEvent(new p.window.PopStateEvent('popstate'));
  p.mount(p.blocks[1], 1);
  await delay(1400);
  assert.equal(p.calls.play.includes(1), false);
});

test('replacing native controls restores exactly one autoplay and window-mode button', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable();
  const root = p.players.get(0).root;
  const controls = root.querySelector('[data-testid="player_controls"]');
  controls.outerHTML = '<div data-testid="player_controls"><div class="controls-right"><button data-testid="fullscreen-btn">Fullscreen</button></div></div>';
  await eventually(() => root.querySelector('[data-testid="player_controls"] .bpa-toggle'), 'Toggle did not survive control rerender');
  await delay(1200);
  assert.equal(root.querySelectorAll('.bpa-toggle').length, 1);
  assert.equal(root.querySelectorAll('.bpa-window-toggle').length, 1);
  assert.equal(root.querySelector('.bpa-toggle').getAttribute('aria-pressed'), 'true');
});

test('a rejected play offers a retry which starts that same next video', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  p.setRejectPlay(key => key === 1);
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => [...p.document.querySelectorAll('#bpa-status button')].some(b => /Продолжить/.test(b.textContent)), 'No continuation control after rejected play');
  p.setRejectPlay(null);
  [...p.document.querySelectorAll('#bpa-status button')].find(b => /Продолжить/.test(b.textContent)).click();
  await eventually(() => !p.videos.get(1).paused, 'Retry did not play the next video');
  assert.equal(p.calls.play.includes('other'), false);
});

test('restores enabled state from extension storage', async t => {
  const p = fixture({ storedEnabled: true }); t.after(() => p.close());
  await p.ready();
  await eventually(() => p.players.get(0).root.querySelector('.bpa-toggle').getAttribute('aria-pressed') === 'true', 'Saved enabled state not restored');
  assert.deepEqual(p.errors, []);
});

test('manual selection of a different video cancels a pending next-video load', async t => {
  const p = fixture({ count: 3, lazyIndex: 1 }); t.after(() => p.close());
  await p.enable(); await p.start(); p.end(0); await delay(40);
  await p.start(2);
  p.mount(p.blocks[1], 1);
  await delay(1400);
  assert.equal(p.calls.play.includes(1), false);
  assert.equal(p.videos.get(2).paused, false);
});

test('enabling autoplay leaves the native fullscreen element unchanged', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.ready(); await p.start();
  await p.players.get(0).player.requestFullscreen();
  await p.enable();
  assert.equal(p.document.fullscreenElement, p.players.get(0).player);
  assert.equal(p.calls.fullscreen.length, 1);
  assert.equal(p.calls.exit, 0);
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), false);
});

test('native fullscreen button, F, and double click preserve their own handlers in window mode', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  await p.enterWindow();
  p.videos.get(0).dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, composed: true }));
  await eventually(() => p.document.fullscreenElement === p.players.get(0).player, 'F did not reach native fullscreen handler');
  p.videos.get(0).dispatchEvent(new p.window.MouseEvent('dblclick', { bubbles: true, composed: true }));
  await eventually(() => p.document.fullscreenElement === null, 'Double click did not reach native fullscreen handler');
  p.players.get(0).root.querySelector('[data-testid="fullscreen-btn"]').click();
  await eventually(() => p.document.fullscreenElement === p.players.get(0).player, 'Fullscreen button did not reach its native handler');
  assert.deepEqual(p.calls.native, ['f', 'dblclick', 'button']);
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
});

test('disabling while play() waits for buffering cancels the pending playback', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  p.setDeferredPlay(1);
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Next play() was never requested');
  p.players.get(0).root.querySelector('.bpa-toggle').click();
  p.completeDeferredPlay(1);
  await delay(80);
  assert.equal(p.videos.get(1).paused, true, 'Disabled transition started playback after buffering completed');
});

test('advancing from native fullscreen returns to window mode before the next video plays', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.ready(); await p.start();
  await p.enterWindow();
  await p.players.get(0).player.requestFullscreen();
  await p.enable();
  p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Next video did not start');
  assert.equal(p.document.fullscreenElement, null);
  assert.equal(p.calls.exit, 1);
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
  assert.equal(p.document.querySelector('[data-bpa-stage]'), p.blocks[1]);
});

test('cancel also stops playback initiated by the lazy player native Play button', async t => {
  const p = fixture({ count: 2, lazyIndex: 1 }); t.after(() => p.close());
  p.mount(p.blocks[1], 1, { lazyVideo: true });
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Lazy native Play was not clicked');
  p.players.get(0).root.querySelector('.bpa-toggle').click();
  await delay(200);
  assert.equal(p.videos.get(1).paused, true, 'Native lazy playback escaped transition cancellation');
});

test('same-post replacement of the window-mode block recovers stage by video block id', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  await p.enterWindow();
  const old = p.blocks[0];
  const replacement = p.document.createElement('div');
  replacement.id = old.id;
  old.replaceWith(replacement);
  p.blocks[0] = replacement;
  p.mount(replacement, 0);
  await eventually(() => replacement.hasAttribute('data-bpa-stage'), 'Replacement block did not recover window-mode stage');
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
  assert.equal(p.document.fullscreenElement, null);
  assert.equal(p.calls.exit, 0);
  await eventually(() => p.players.get(0).root.querySelector('.bpa-toggle'), 'Replacement player did not receive controls');
  await p.start(); p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Recovered player could not continue its queue');
});

test('a repeated rejection does not leave the queue locked after manual playback recovers', async t => {
  const p = fixture({ count: 3 }); t.after(() => p.close());
  p.setRejectPlay(key => key === 1);
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => [...p.document.querySelectorAll('#bpa-status button')].some(b => /Продолжить/.test(b.textContent)), 'Initial rejection did not expose retry');
  [...p.document.querySelectorAll('#bpa-status button')].find(b => /Продолжить/.test(b.textContent)).click();
  await eventually(() => p.calls.play.filter(key => key === 1).length >= 2, 'Retry was not attempted');
  await delay(30);
  p.setRejectPlay(null);
  await p.start(1); p.end(1);
  await eventually(() => p.calls.play.includes(2), 'Repeated rejection left the recovered queue locked');
});

test('window mode works with autoplay disabled and preserves paused playback', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.ready();
  await p.enterWindow();
  const button = p.players.get(0).root.querySelector('.bpa-window-toggle');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Вернуть в пост');
  assert.equal(p.videos.get(0).paused, true);
  assert.equal(p.calls.play.length, 0);
  assert.equal(p.storage.enabled, false);
  assert.equal(p.document.fullscreenElement, null);
});

test('turning autoplay off keeps the current video in window mode', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start(); await p.enterWindow();
  p.players.get(0).root.querySelector('.bpa-toggle').click();
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
  assert.equal(p.document.querySelector('[data-bpa-stage]'), p.blocks[0]);
  assert.equal(p.videos.get(0).paused, false);
  p.end(0); await delay(200);
  assert.equal(p.calls.play.includes(1), false);
});

test('Escape returns the active window-mode player to its post and restores button focus', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.start(); await p.enterWindow();
  const button = p.players.get(0).root.querySelector('.bpa-window-toggle');
  p.videos.get(0).dispatchEvent(new p.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, composed: true, cancelable: true,
  }));
  await eventually(() => !p.document.documentElement.hasAttribute('data-bpa-windowed'), 'Escape did not return to post');
  assert.equal(p.document.querySelector('[data-bpa-stage]'), null);
  assert.equal(p.document.querySelector('[data-bpa-path]'), null);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.getAttribute('aria-label'), 'На всё окно');
  assert.equal(p.players.get(0).root.activeElement, button);
  assert.equal(p.videos.get(0).paused, false);
});

test('clicking the window button again returns to the post without touching native fullscreen', async t => {
  const p = fixture(); t.after(() => p.close());
  await p.enterWindow();
  p.players.get(0).root.querySelector('.bpa-window-toggle').click();
  await eventually(() => !p.document.documentElement.hasAttribute('data-bpa-windowed'), 'Second click did not leave window mode');
  assert.equal(p.calls.fullscreen.length, 0);
  assert.equal(p.calls.exit, 0);
  assert.equal(p.document.querySelector('[data-bpa-stage]'), null);
});

test('Escape in native fullscreen preserves window mode and reaches the native exit handler', async t => {
  const p = fixture(); t.after(() => p.close());
  await p.enterWindow();
  await p.players.get(0).player.requestFullscreen();
  p.videos.get(0).dispatchEvent(new p.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, composed: true, cancelable: true,
  }));
  await eventually(() => p.document.fullscreenElement === null, 'Escape did not reach the native exit');
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
  assert.equal(p.calls.native.at(-1), 'escape');
  // Some native player handlers exit synchronously before document bubbling.
  // The extension must still preserve window mode for that same key event.
  await p.players.get(0).player.requestFullscreen();
  p.players.get(0).root.addEventListener('keydown', event => {
    if (event.key === 'Escape') p.document.exitFullscreen();
  }, { once: true });
  p.videos.get(0).dispatchEvent(new p.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, composed: true, cancelable: true,
  }));
  assert.equal(p.document.fullscreenElement, null);
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
});

test('SPA navigation leaves window mode and removes its layout attributes', async t => {
  const p = fixture(); t.after(() => p.close());
  await p.enterWindow();
  p.window.history.pushState({}, '', `/creator/posts/${OTHER}`);
  p.window.dispatchEvent(new p.window.PopStateEvent('popstate'));
  await eventually(() => !p.document.documentElement.hasAttribute('data-bpa-windowed'), 'Navigation retained window layout');
  assert.equal(p.document.querySelector('[data-bpa-stage]'), null);
  assert.equal(p.document.querySelector('[data-bpa-path]'), null);
  assert.equal(p.calls.fullscreen.length, 0);
  assert.equal(p.calls.exit, 0);
});

test('removing the active block without a replacement exits window mode', async t => {
  const p = fixture(); t.after(() => p.close());
  await p.enterWindow();
  p.blocks[0].remove();
  await eventually(() => !p.document.documentElement.hasAttribute('data-bpa-windowed'), 'Removed block left a blank window overlay');
  assert.equal(p.document.querySelector('[data-bpa-path]'), null);
});

test('manual selection follows a different video in window mode even with autoplay disabled', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enterWindow();
  await p.start(1);
  await eventually(() => p.document.querySelector('[data-bpa-stage]') === p.blocks[1], 'Manually selected video remained behind another window-mode block');
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true);
  assert.equal(p.storage.enabled, false);
});

test('Escape first closes a native menu, then the next Escape leaves window mode', async t => {
  const p = fixture(); t.after(() => p.close());
  await p.enterWindow();
  const root = p.players.get(0).root;
  const settings = p.document.createElement('button');
  settings.setAttribute('aria-expanded', 'true');
  const menu = p.document.createElement('div');
  menu.setAttribute('role', 'menu');
  root.append(settings, menu);
  let nativeMenuClosed = 0;
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && settings.getAttribute('aria-expanded') === 'true') {
      settings.setAttribute('aria-expanded', 'false');
      menu.remove();
      nativeMenuClosed++;
    }
  });
  const escape = () => p.videos.get(0).dispatchEvent(new p.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, composed: true, cancelable: true,
  }));
  escape();
  assert.equal(nativeMenuClosed, 1);
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), true, 'Same Escape closed both native menu and window mode');
  escape();
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), false);
});

test('hidden native menus do not block Escape from leaving window mode', async t => {
  const p = fixture(); t.after(() => p.close());
  await p.enterWindow();
  const root = p.players.get(0).root;
  const menu = p.document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  // Keep a non-empty geometry stub to verify the hidden attribute itself wins.
  menu.getClientRects = () => [{ width: 100, height: 100 }];
  root.append(menu);
  p.videos.get(0).dispatchEvent(new p.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, composed: true, cancelable: true,
  }));
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), false);
});

for (const cancellation of ['disable', 'manual', 'navigation']) {
  test(`${cancellation} cancels a next-video transition waiting for native fullscreen to exit`, async t => {
    const p = fixture({ count: 3 }); t.after(() => p.close());
    await p.enable(); await p.start(); await p.enterWindow();
    await p.players.get(0).player.requestFullscreen();
    const actualExit = p.document.exitFullscreen;
    let releaseExit;
    p.document.exitFullscreen = () => new Promise(resolve => {
      releaseExit = async () => { await actualExit(); resolve(); };
    });
    p.end(0);
    await eventually(() => releaseExit, 'Next-video transition did not request native fullscreen exit');
    assert.equal(p.calls.play.includes(1), false, 'Next video started before native fullscreen exit completed');
    if (cancellation === 'disable') {
      p.players.get(0).root.querySelector('.bpa-toggle').click();
    } else if (cancellation === 'manual') {
      await p.start(2);
    } else {
      p.window.history.pushState({}, '', `/creator/posts/${OTHER}`);
      p.window.dispatchEvent(new p.window.PopStateEvent('popstate'));
      await eventually(() => !p.document.documentElement.hasAttribute('data-bpa-windowed'), 'SPA navigation did not clear window mode');
    }
    await releaseExit();
    await delay(180);
    assert.equal(p.calls.play.includes(1), false, 'Cancelled next video started after fullscreen exit resolved');
    if (cancellation === 'manual') assert.equal(p.videos.get(2).paused, false);
  });
}

test('idle window-view scans preserve layout attributes before Play', async t => {
  const p = fixture({ count: 1 }); t.after(() => p.close());
  await p.enterWindow();
  // MutationObserver sees even same-value attribute writes. Repeated removal
  // and reapplication can restart the host site's lazy visibility lifecycle.
  await delay(180);
  const mutations = [];
  const observer = new p.window.MutationObserver(changes => mutations.push(...changes));
  observer.observe(p.document.documentElement, {
    subtree: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['data-bpa-stage', 'data-bpa-path', 'data-bpa-player-path'],
  });
  t.after(() => observer.disconnect());
  await delay(1350);
  assert.equal(mutations.length, 0, 'Idle scan rewrote stable player layout attributes');
  assert.equal(p.document.querySelector('[data-bpa-stage]'), p.blocks[0]);
  assert.equal(p.videos.get(0).paused, true);
  assert.equal(p.calls.play.length, 0);
});

test('Russian unstarted player receives controls and keyboard focus before Play', async t => {
  const p = fixture({ count: 1, regionLabel: 'Видеоплеер', controlsInitially: false, lazyVideoInitially: true });
  t.after(() => p.close());
  await p.ready();
  const root = p.players.get(0).root;
  const region = root.querySelector('.keyboard-controls');
  assert.ok(root.querySelector('.bpa-window-toggle'), 'Window control was missing in a localized unstarted player');
  assert.ok(root.querySelector('.bpa-controls.bpa-floating'), 'Unstarted player controls were not visible in the floating group');
  await p.enterWindow();
  assert.equal(root.activeElement, region, 'Window view did not focus the localized native keyboard region');
  assert.equal(p.calls.play.length, 0, 'Window view unexpectedly started the video');
  region.dispatchEvent(new p.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, composed: true, cancelable: true,
  }));
  assert.equal(p.document.documentElement.hasAttribute('data-bpa-windowed'), false);
  assert.equal(root.activeElement, root.querySelector('.bpa-window-toggle'));
});

test('late unstarted shadow roots retain wrapper layout markers and clear them on exit', async t => {
  const p = fixture({ count: 1 }); t.after(() => p.close());
  await p.enterWindow();
  p.players.get(0).player.remove();
  const outer = p.document.createElement('div');
  const inner = p.document.createElement('div');
  const player = p.document.createElement('vk-video-player');
  const holder = p.document.createElement('div');
  outer.className = 'site-lazy-container';
  inner.className = 'site-player-container';
  outer.append(inner); inner.append(player); player.append(holder);
  p.blocks[0].append(outer);
  // attachShadow() itself is not observable from the document subtree.
  await delay(160);
  const root = holder.attachShadow({ mode: 'open' });
  root.innerHTML = '<div class="keyboard-controls" role="region" aria-label="Видеоплеер" tabindex="-1"><div data-testid="unstarted-thumb"><div role="button" aria-label="Смотреть">Смотреть</div></div></div>';
  await eventually(() => root.querySelector('.bpa-window-toggle'), 'Late localized shadow root did not receive controls');
  await eventually(() => outer.hasAttribute('data-bpa-player-path') && inner.hasAttribute('data-bpa-player-path'),
    'Lazy player wrappers did not receive stable layout markers');
  assert.equal(p.document.querySelector('[data-bpa-stage]'), p.blocks[0]);
  assert.equal(player.parentNode, inner, 'Window view reparented the lazy player');
  assert.equal(p.calls.play.length, 0);
  root.querySelector('.bpa-window-toggle').click();
  assert.equal(p.document.querySelector('[data-bpa-player-path]'), null, 'Player wrapper markers leaked after returning to the post');
  assert.equal(p.document.querySelector('[data-bpa-path]'), null);
  assert.equal(p.document.querySelector('[data-bpa-stage]'), null);
});

test('prepared media still initializes VK through native Play before dismissing its preview', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  const next = p.videos.get(1);
  const thumb = p.players.get(1).root.querySelector('[data-testid="unstarted-thumb"]');
  assert.equal(next.readyState, 4);
  assert.ok(next.currentSrc);
  assert.equal(thumb.classList.contains('hidden'), false);
  p.end(0);
  await eventually(() => !next.paused, 'Prepared media never began playback');
  assert.equal(p.calls.nativePlay.filter(key => key === 1).length, 1,
    'Ready media bypassed the native player initialization');
  assert.equal(thumb.style.visibility, 'hidden', 'Audio started behind the visible VK preview');
  await delay(200);
  assert.equal(p.calls.nativePlay.filter(key => key === 1).length, 1,
    'Native Play was clicked again after the player initialized');
});

test('an initialized player does not click the hidden unstarted thumbnail again', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  const thumb = p.players.get(1).root.querySelector('[data-testid="unstarted-thumb"]');
  thumb.classList.add('hidden');
  thumb.style.visibility = 'hidden';
  p.end(0);
  await eventually(() => !p.videos.get(1).paused, 'Initialized next video did not play');
  assert.equal(p.calls.nativePlay.includes(1), false,
    'The extension clicked a hidden thumbnail of an initialized player');
});

test('retry initializes a still-visible preview through native Play as well', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  p.setRejectPlay(key => key === 1);
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => [...p.document.querySelectorAll('#bpa-status button')]
    .some(button => button.textContent === 'Продолжить'), 'Rejected play did not expose retry');
  const initialClicks = p.calls.nativePlay.filter(key => key === 1).length;
  const thumb = p.players.get(1).root.querySelector('[data-testid="unstarted-thumb"]');
  // Model VK retaining/restoring its unstarted state after the first failure.
  thumb.classList.remove('hidden');
  thumb.style.visibility = 'visible';
  p.setRejectPlay(null);
  [...p.document.querySelectorAll('#bpa-status button')]
    .find(button => button.textContent === 'Продолжить').click();
  await eventually(() => !p.videos.get(1).paused, 'Retry did not start media');
  assert.equal(p.calls.nativePlay.filter(key => key === 1).length, initialClicks + 1,
    'Retry started media directly underneath an uninitialized preview');
  assert.equal(thumb.style.visibility, 'hidden');
});

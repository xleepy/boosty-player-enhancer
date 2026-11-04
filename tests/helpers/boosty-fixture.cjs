const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const extensionRoot = path.resolve(__dirname, '../../extension');
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
  const mediaStates = new WeakMap();
  const finishes = new Map();
  const players = new Map();
  const blocks = [];
  const calls = { play: [], playStates: [], pause: [], fullscreen: [], exit: 0, scroll: [], native: [], nativePlay: [] };
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
    const state = { readyState: 4, currentSrc: `blob:https://boosty.to/${key}` };
    mediaStates.set(video, state);
    Object.defineProperties(video, {
      paused: { get: () => paused },
      ended: { get: () => ended },
      readyState: { get: () => state.readyState },
      duration: { get: () => 180 },
      currentSrc: { get: () => state.currentSrc },
    });
    video.play = () => {
      calls.play.push(key);
      calls.playStates.push({ key, video, muted: video.muted, volume: video.volume,
        playbackRate: video.playbackRate, currentTime: video.currentTime, readyState: state.readyState });
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
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  for (const script of manifest.content_scripts[0].js) {
    window.eval(fs.readFileSync(path.join(extensionRoot, script), 'utf8'));
  }
  const api = {
    dom, window, document, videos, players, blocks, post, otherPost, calls, errors, storage,
    mount,
    setScrollHook(fn) { scrollHook = fn; },
    setRejectPlay(fn) { rejectPlay = fn; },
    setDeferredPlay(key) { deferredKey = key; },
    completeDeferredPlay(key) { deferredPlays.get(key)?.resolve(); },
    deferredCompletion(key) { return deferredPlays.get(key)?.resolve; },
    setMediaState(key, values) { Object.assign(mediaStates.get(videos.get(key)), values); },
    loadMetadata(key, savedTime = 0) {
      const video = videos.get(key);
      mediaStates.get(video).readyState = 4;
      video.currentTime = savedTime;
      video.dispatchEvent(new window.Event('loadedmetadata'));
    },
    replaceVideo(key) {
      const old = videos.get(key);
      old.remove();
      return { old, next: makeVideo(key, players.get(key).root) };
    },
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

module.exports = { fixture, eventually, delay, POST, OTHER };

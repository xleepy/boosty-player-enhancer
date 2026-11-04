/*
 * Owns Boosty's VK player integration for one post. list() returns stable
 * handles in post order, including blocks whose player has not mounted yet.
 * Event callbacks observe a complete, current list() of handles.
 * Handles expose the outer element only for layout; shadow roots, media,
 * observers and controls remain private. setPost()/dispose() cancel old work.
 *
 * handle.play({ settings, signal, startAt = 0, timeoutMs = 15000 }) completes
 * native VK initialization, applies playback settings before starting existing
 * media, seeks after metadata, and resolves only for the current media element.
 * Its first available native/media start runs synchronously in the caller's
 * gesture. Abort, timeout and pause() stop pending media; media replacement is
 * prepared again under the same deadline. Rejection names distinguish AbortError,
 * TimeoutError and the browser's original play() error (e.g. NotAllowedError).
 */
(() => {
  'use strict';

  const playerSelector = 'vk-video-player';
  const regionSelector = '.keyboard-controls[role="region"], [role="region"][aria-label]';
  const shadowCSS = `
    .bpa-controls { display: flex; align-items: center; flex: none; }
    .bpa-control { display: flex; align-items: center; flex: none;
      margin: 0 0 0 4px; height: var(--controls-height, 40px); }
    .bpa-tooltip { display: flex; width: 100%; }
    .bpa-button { appearance: none; box-sizing: border-box; display: flex;
      flex-direction: row; align-items: center; justify-content: center;
      width: 40px; height: var(--controls-height, 40px); margin: 0;
      padding: 8px; border: 0; border-radius: 0; background: transparent;
      color: var(--btn-color, #fff); opacity: 1; cursor: pointer; will-change: opacity; }
    .bpa-button svg { display: block; flex: none; width: 24px; height: 24px; fill: currentColor; }
    .bpa-button[aria-pressed="true"] { color: #ff965c; }
    .bpa-button:hover { opacity: .8; }
    .bpa-button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
    .bpa-toggle .bpa-knob { transition: transform 120ms ease; }
    .bpa-toggle[aria-pressed="true"] .bpa-knob { transform: translateX(6px); }
    @media (prefers-reduced-motion: reduce) { .bpa-toggle .bpa-knob { transition: none; } }
    .bpa-controls.bpa-floating { position: absolute; top: 10px; right: 10px;
      z-index: 30; margin: 0; background: #18181cdd; border-radius: 4px; }
  `;

  function openRoots(host) {
    if (!host) return [];
    const roots = [host];
    for (let i = 0; i < roots.length; i++) {
      for (const element of [roots[i], ...roots[i].querySelectorAll('*')]) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function svgElement(tag, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function makeButton(action, callback) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `bpa-button ${action === 'autoplay' ? 'bpa-toggle' : 'bpa-window-toggle'}`;
    const svg = svgElement('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    if (action === 'autoplay') {
      const track = svgElement('rect', { x: '2', y: '5', width: '20', height: '14', rx: '7', opacity: '.35' });
      const knob = svgElement('g', { class: 'bpa-knob' });
      knob.append(svgElement('circle', { cx: '9', cy: '12', r: '5' }),
        svgElement('path', { d: 'M7.7 9v6l4.5-3z', fill: '#181818' }));
      svg.append(track, knob);
    } else {
      svg.append(svgElement('path', { 'fill-rule': 'evenodd',
        d: 'M4 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4zm0 2h16v12H4V6zm2 2h12v8H6V8z' }));
    }
    button.append(svg);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      callback(action);
    });
    return button;
  }

  // The first manifest script owns this registry in Chrome's isolated world.
  // Define an own property: Window's named DOM elements must never become it.
  const modules = Object.create(null);
  Object.defineProperty(globalThis, 'BoostyEnhancer', { value: modules });
  modules.createPlayers = function createPlayers({
    onPlay = () => {}, onEnded = () => {}, onAction = () => {}, onChange = () => {}
  } = {}) {
    const records = new Map();
    const handledPlayEvents = new WeakSet();
    let post = null;
    let postPath = null;
    let ordered = [];
    let refreshTimer = null;
    let refreshing = false;
    let disposed = false;

    function connected(record) {
      return !record.disposed && location.pathname === postPath &&
        !!post?.isConnected && post.contains(record.element);
    }

    function blocks() {
      if (!post?.isConnected) return [];
      const videos = [...post.querySelectorAll('[id^="video-"]')]
        .filter(block => block.closest('[data-post-id]') === post);
      return videos.length ? videos : [...post.querySelectorAll(playerSelector)]
        .filter(host => host.closest('[data-post-id]') === post);
    }

    function currentHost(record) {
      return record.element.matches(playerSelector) ? record.element : record.element.querySelector(playerSelector);
    }

    function currentMedia(record) {
      return openRoots(currentHost(record)).map(root => root.querySelector('video')).find(Boolean) || null;
    }

    function preview(record) {
      const thumb = record.root?.querySelector('[data-testid="unstarted-thumb"]');
      if (!thumb || thumb.hidden || thumb.classList.contains('hidden')) return null;
      const style = getComputedStyle(thumb);
      return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' ? null : thumb;
    }

    function applySettings(video, settings) {
      if (!video) return;
      // Mute first so changing volume on already started native media cannot
      // briefly expose audio that the preceding player had muted.
      video.muted = settings.muted;
      video.volume = settings.volume;
      video.playbackRate = settings.playbackRate;
    }

    function updateControls(record) {
      const { enabled, windowed } = record.controlState;
      const label = `Автопроигрывание: ${enabled ? 'включено' : 'выключено'}`;
      record.autoButton.setAttribute('aria-pressed', String(enabled));
      record.autoButton.setAttribute('aria-label', label);
      record.autoButton.title = `${label}. Следующее видео в этом посте`;
      record.windowButton.setAttribute('aria-pressed', String(windowed));
      record.windowButton.setAttribute('aria-label', windowed ? 'Вернуть в пост' : 'На всё окно');
      record.windowButton.title = windowed ? 'Вернуть в пост (Esc)' : 'На всё окно';
    }

    function stopOperation(record, error) {
      const operation = record.operation;
      if (!operation) return;
      record.operation = null;
      clearTimeout(operation.timer);
      clearTimeout(operation.deadline);
      operation.signal?.removeEventListener('abort', operation.onAbort);
      operation.media?.pause();
      const live = currentMedia(record);
      if (live && live !== operation.media) live.pause();
      operation.reject(error);
    }

    function detachHost(record) {
      for (const [root, watch] of record.watches) {
        watch.observer.disconnect();
        root.removeEventListener('play', watch.play, true);
      }
      record.watches.clear();
      record.mediaAbort?.abort();
      record.mediaAbort = null;
      record.group.remove();
      record.root = null;
      record.host = null;
      record.video = null;
    }

    function disposeRecord(record) {
      record.disposed = true;
      stopOperation(record, new DOMException('Player was removed', 'AbortError'));
      record.video?.pause();
      detachHost(record);
    }

    function scheduleRefresh() {
      if (!disposed && !refreshTimer) refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, 80);
    }

    function adoptVideo(record, video) {
      if (video === record.video) return false;
      record.mediaAbort?.abort();
      record.video = video;
      record.mediaAbort = null;
      if (video) {
        record.mediaAbort = new AbortController();
        video.addEventListener('ended', () => {
          if (connected(record) && video.isConnected && record.video === video) onEnded(record.handle);
        }, { signal: record.mediaAbort.signal });
        if (record.operation) applySettings(video, record.operation.settings);
      }
      return true;
    }

    function watchRoot(record, root) {
      if (record.watches.has(root)) return;
      const observer = new MutationObserver(changes => {
        if (changes.some(change => [...change.addedNodes, ...change.removedNodes]
          .some(node => node.nodeType === Node.ELEMENT_NODE))) scheduleRefresh();
      });
      observer.observe(root, { childList: true, subtree: true });
      const play = event => {
        if (!(event.target instanceof HTMLVideoElement) || !event.target.isConnected ||
          handledPlayEvents.has(event) || !connected(record)) return;
        handledPlayEvents.add(event);
        adoptVideo(record, event.target);
        if (record.operation) applySettings(event.target, record.operation.settings);
        onPlay(record.handle);
      };
      root.addEventListener('play', play, true);
      record.watches.set(root, { observer, play });
    }

    function refreshRecord(record) {
      const host = currentHost(record);
      let changed = host !== record.host;
      if (changed) {
        if (record.operation?.media) record.operation.media.pause();
        detachHost(record);
        record.host = host;
      }
      if (!host) return changed;
      const roots = openRoots(host);
      for (const [root, watch] of record.watches) {
        if (!roots.includes(root)) {
          watch.observer.disconnect();
          root.removeEventListener('play', watch.play, true);
          record.watches.delete(root);
        }
      }
      for (const root of roots) watchRoot(record, root);
      const video = roots.map(root => root.querySelector('video')).find(Boolean) || null;
      const mediaChanged = adoptVideo(record, video);
      if (mediaChanged && video && !video.paused) onPlay(record.handle);
      changed ||= mediaChanged;
      const root = roots.find(item => item.querySelector('[data-testid="player_controls"]'))
        || roots.find(item => item.querySelector(regionSelector)) || null;
      changed ||= root !== record.root;
      record.root = root;
      if (!root) return changed;
      if (!root.querySelector('style[data-bpa-style]')) {
        const style = document.createElement('style');
        style.setAttribute('data-bpa-style', '');
        style.textContent = shadowCSS;
        root.append(style);
      }
      const controls = root.querySelector('[data-testid="player_controls"] .controls-right')
        || root.querySelector('[data-testid="player_controls"]');
      const container = controls || root.querySelector(regionSelector);
      if (!container) return changed;
      const native = controls?.querySelector('[data-testid="fullscreen-btn"]')
        || controls?.querySelector('button:not(.bpa-button)');
      for (const control of record.controls) {
        const type = control.button === record.autoButton ? 'bpa-toggle' : 'bpa-window-toggle';
        control.button.className = `${native?.className || 'btn'} bpa-button ${type}`;
        control.container.className = `${native?.closest('.btn-container')?.className || ''} bpa-control`;
        control.tooltip.className = `${native?.closest('.tooltip-wrapper')?.className || ''} bpa-tooltip`;
      }
      record.group.classList.toggle('bpa-floating', !controls);
      if (record.group.parentNode !== container) {
        const before = native?.closest('.btn-container');
        container.insertBefore(record.group, before?.parentNode === container ? before : null);
      }
      updateControls(record);
      return changed;
    }

    function play(record, { settings = record.handle.snapshot(), signal,
      startAt = 0, timeoutMs = 15000 } = {}) {
      stopOperation(record, new DOMException('Playback was replaced', 'AbortError'));
      if (!connected(record) || signal?.aborted) return Promise.reject(new DOMException('Playback was canceled', 'AbortError'));

      return new Promise((resolve, reject) => {
        const operation = { settings, signal, startAt, resolve, reject, media: null,
          playState: null, seeked: false, timer: null, deadline: null,
          clicked: new WeakSet(), onAbort: null, running: false };
        record.operation = operation;
        operation.onAbort = () => stopOperation(record, new DOMException('Playback was canceled', 'AbortError'));
        signal?.addEventListener('abort', operation.onAbort, { once: true });
        operation.deadline = setTimeout(() => {
          if (record.operation === operation) stopOperation(record, new DOMException('Player did not become ready', 'TimeoutError'));
        }, timeoutMs);

        function finish() {
          if (record.operation !== operation) return;
          record.operation = null;
          clearTimeout(operation.timer);
          clearTimeout(operation.deadline);
          signal?.removeEventListener('abort', operation.onAbort);
          resolve();
        }

        function requestPlay(video) {
          const state = { status: 'pending', error: null };
          operation.playState = state;
          try {
            Promise.resolve(video.play()).then(() => {
              state.status = 'fulfilled';
              pump();
            }, error => {
              state.status = 'rejected';
              state.error = error;
              pump();
            });
          } catch (error) {
            state.status = 'rejected';
            state.error = error;
          }
        }

        function pump() {
          if (record.operation !== operation || operation.running) return;
          operation.running = true;
          clearTimeout(operation.timer);
          try {
            if (!connected(record) || signal?.aborted) {
              stopOperation(record, new DOMException('Playback was canceled', 'AbortError'));
              return;
            }
            refreshRecord(record);
            const video = record.video;
            if (operation.media !== video) {
              operation.media?.pause();
              operation.media = video;
              operation.playState = null;
              operation.seeked = false;
            }
            applySettings(video, settings);
            if (video && !operation.seeked && video.readyState > 0) {
              video.currentTime = startAt;
              operation.seeked = true;
            }
            // The same native button is clicked at most once per operation, but
            // an absent button does not suppress a later-rendered start control.
            const thumb = preview(record);
            const needsNative = thumb || !video || (!video.readyState && !video.currentSrc);
            const button = needsNative && (thumb?.querySelector('button, [role="button"]')
              || record.root?.querySelector('[data-testid="play-btn"]')
              || record.root?.querySelector('[role="region"] [role="button"]'));
            if (button && !operation.clicked.has(button)) {
              operation.clicked.add(button);
              button.click();
              refreshRecord(record);
              // Native initialization may restore its own saved position.
              // Reassert the requested start after that initialization as well.
              operation.seeked = false;
            }
            const live = record.video;
            if (live !== operation.media) {
              operation.media?.pause();
              operation.media = live;
              operation.playState = null;
              operation.seeked = false;
            }
            applySettings(live, settings);
            if (live && !preview(record)) {
              if (!operation.seeked && live.readyState > 0) {
                live.currentTime = startAt;
                operation.seeked = true;
              }
              if (!operation.playState) requestPlay(live);
              if (operation.playState.status === 'rejected') throw operation.playState.error;
              if (operation.playState.status === 'fulfilled' && operation.seeked &&
                live.isConnected && record.video === live) {
                finish();
                return;
              }
            }
          } catch (error) {
            stopOperation(record, error);
          } finally {
            operation.running = false;
            if (record.operation === operation) operation.timer = setTimeout(pump, 60);
          }
        }

        // No await before pump: a ready VK control/media starts within the
        // original user click, including retry after autoplay rejection.
        pump();
      });
    }

    function makeRecord(element) {
      const record = { element, disposed: false, host: null, root: null, video: null,
        mediaAbort: null, operation: null, watches: new Map(), controls: [],
        group: document.createElement('div'), controlState: { enabled: false, windowed: false } };
      record.group.className = 'bpa-controls';
      record.autoButton = makeButton('autoplay', action => onAction(record.handle, action));
      record.windowButton = makeButton('window', action => onAction(record.handle, action));
      for (const button of [record.autoButton, record.windowButton]) {
        const container = document.createElement('div');
        const tooltip = document.createElement('div');
        tooltip.append(button);
        container.append(tooltip);
        record.group.append(container);
        record.controls.push({ button, container, tooltip });
      }
      record.handle = Object.freeze({
        element,
        get connected() { return connected(record); },
        snapshot() {
          const video = currentMedia(record);
          return { volume: video?.volume ?? 1, muted: video?.muted ?? false,
            playbackRate: video?.playbackRate ?? 1 };
        },
        pause() {
          stopOperation(record, new DOMException('Playback was paused', 'AbortError'));
          currentMedia(record)?.pause();
        },
        play(options) { return play(record, options); },
        focus() {
          const region = record.root?.querySelector(regionSelector);
          (region?.hasAttribute('tabindex') ? region : record.windowButton).focus({ preventScroll: true });
        },
        focusWindowButton() { record.windowButton.focus({ preventScroll: true }); },
        hasOpenMenu() {
          const overlays = record.root?.querySelectorAll('[aria-expanded="true"], [role="dialog"], [role="menu"]') || [];
          return [...overlays].some(node => node.getAttribute('aria-expanded') === 'true' ||
            (!node.hidden && node.getClientRects().length > 0 &&
              getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none'));
        },
        setControls(state) {
          record.controlState = { enabled: state.enabled === true, windowed: state.windowed === true };
          updateControls(record);
        }
      });
      return record;
    }

    function refresh() {
      if (disposed || refreshing) return;
      refreshing = true;
      let changed = false;
      try {
        const next = blocks();
        for (const [element, record] of records) {
          if (!next.includes(element)) { disposeRecord(record); records.delete(element); changed = true; }
        }
        for (const element of next) {
          if (!records.has(element)) { records.set(element, makeRecord(element)); changed = true; }
        }
        if (next.length !== ordered.length || next.some((element, index) => ordered[index] !== element)) changed = true;
        // Publish all handles before refreshRecord can report already-playing
        // media to the coordinator; callbacks validate against this exact list.
        ordered = next;
        for (const element of next) changed = refreshRecord(records.get(element)) || changed;
      } finally {
        refreshing = false;
      }
      if (changed) onChange();
    }

    return Object.freeze({
      setPost(value) {
        if (post === value && postPath === location.pathname) return;
        for (const record of records.values()) disposeRecord(record);
        records.clear();
        ordered = [];
        post = value;
        postPath = value ? location.pathname : null;
        refresh();
      },
      refresh,
      list() { return ordered.map(element => records.get(element)?.handle).filter(Boolean); },
      dispose() {
        disposed = true;
        clearTimeout(refreshTimer);
        for (const record of records.values()) disposeRecord(record);
        records.clear();
        ordered = [];
        post = null;
        postPath = null;
      }
    });
  };
})();

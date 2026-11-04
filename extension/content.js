/*
 * Adds an opt-in queue to VK Video players on a single Boosty post page.
 * The window view fills the browser tab while preserving the original players
 * and their controls. Native fullscreen buttons and shortcuts stay native.
 * Only the user's normal Boosty session loads video; no media URLs are read.
 */
(() => {
  'use strict';

  const playerSelector = 'vk-video-player';
  const regionSelector = '.keyboard-controls[role="region"], [role="region"][aria-label]';
  const postPathPattern = /\/posts\/([a-f\d-]{36})(?:\/|$)/i;
  const records = new Map();
  const layoutPaths = new Map([
    ['data-bpa-path', new Set()],
    ['data-bpa-player-path', new Set()]
  ]);
  let enabled = false;
  let preferenceRevision = 0;
  let pageId = null;
  let post = null;
  let active = null;
  let stage = null;
  let windowed = false;
  let layoutRevision = 0;
  let generation = 0;
  let pendingBlock = null;
  let pendingVideo = null;
  let scanTimer = null;
  let statusTimer = null;

  const shadowCSS = `
    .bpa-controls { display: flex; align-items: center; flex: none; }
    .bpa-control {
      display: flex; align-items: center; flex: none; margin: 0 0 0 4px;
      height: var(--controls-height, 40px);
    }
    .bpa-tooltip { display: flex; width: 100%; }
    .bpa-button {
      appearance: none; box-sizing: border-box; display: flex;
      flex-direction: row; align-items: center; justify-content: center;
      width: 40px; height: var(--controls-height, 40px); margin: 0;
      padding: 8px; border: 0; border-radius: 0;
      background: transparent; color: var(--btn-color, #fff); opacity: 1;
      cursor: pointer; will-change: opacity;
    }
    .bpa-button svg { display: block; flex: none; width: 24px; height: 24px; fill: currentColor; }
    .bpa-button[aria-pressed="true"] { color: #ff965c; }
    .bpa-button:hover { opacity: .8; }
    .bpa-button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
    .bpa-toggle .bpa-knob { transition: transform 120ms ease; }
    .bpa-toggle[aria-pressed="true"] .bpa-knob { transform: translateX(6px); }
    @media (prefers-reduced-motion: reduce) { .bpa-toggle .bpa-knob { transition: none; } }
    .bpa-controls.bpa-floating {
      position: absolute; top: 10px; right: 10px; z-index: 30;
      margin: 0; background: #18181cdd; border-radius: 4px;
    }
  `;

  function cancelTransition() {
    generation++;
    // pause() also aborts a play() promise waiting for enough buffered data.
    // A token alone cannot cancel that media side effect.
    const pendingHost = pendingBlock?.matches(playerSelector)
      ? pendingBlock : pendingBlock?.querySelector(playerSelector);
    const media = pendingVideo || (pendingHost && openRoots(pendingHost)
      .map(root => root.querySelector('video')).find(Boolean));
    media?.pause();
    pendingVideo = null;
    pendingBlock = null;
  }

  function hideStatus() {
    clearTimeout(statusTimer);
    document.getElementById('bpa-status')?.remove();
  }

  // An actionable failure stays visible until retried, dismissed, or navigated.
  function showStatus(message, retry) {
    hideStatus();
    const box = document.createElement('div');
    box.id = 'bpa-status';
    box.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    box.append(text);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Продолжить';
      button.addEventListener('click', retry);
      box.append(button);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Закрыть уведомление');
    close.addEventListener('click', hideStatus);
    box.append(close);
    document.documentElement.append(box);
    if (!retry) statusTimer = setTimeout(hideStatus, 5000);
  }

  // Open roots are separate observation boundaries, including roots nested
  // below the custom element's light DOM (the structure used by Boosty).
  function openRoots(host) {
    const roots = [host];
    for (let i = 0; i < roots.length; i++) {
      for (const element of [roots[i], ...roots[i].querySelectorAll('*')]) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
          roots.push(element.shadowRoot);
        }
      }
    }
    return roots;
  }

  function queue() {
    if (!post?.isConnected) return [];
    const blocks = [...post.querySelectorAll('[id^="video-"]')]
      .filter(block => block.closest('[data-post-id]') === post);
    return blocks.length ? blocks : [...post.querySelectorAll(playerSelector)];
  }

  function updateButtons(record) {
    const label = `Автопроигрывание: ${enabled ? 'включено' : 'выключено'}`;
    record.button.setAttribute('aria-pressed', String(enabled));
    record.button.setAttribute('aria-label', label);
    record.button.title = `${label}. Следующее видео в этом посте`;
    const expanded = windowed && stage === record.block;
    const windowLabel = expanded ? 'Вернуть в пост' : 'На всё окно';
    record.windowButton.setAttribute('aria-pressed', String(expanded));
    record.windowButton.setAttribute('aria-label', windowLabel);
    record.windowButton.title = expanded ? 'Вернуть в пост (Esc)' : windowLabel;
  }

  function clearStage() {
    stage?.removeAttribute('data-bpa-stage');
    stage = null;
    for (const [attribute, elements] of layoutPaths) {
      for (const element of elements) element.removeAttribute(attribute);
      elements.clear();
    }
  }

  // Keep every wrapper measurable for Boosty's lazy-loading observers. Update
  // only changed paths: polling must not repeatedly tear down the active layout.
  // No player is reparented, preserving its custom-element and React lifecycle.
  function showStage(block) {
    if (stage !== block) {
      stage?.removeAttribute('data-bpa-stage');
      stage = block;
    }
    if (!block.hasAttribute('data-bpa-stage')) block.setAttribute('data-bpa-stage', '');
    const ancestors = new Set();
    const wrappers = new Set();
    for (let element = block.parentElement;
      element && element !== document.documentElement; element = element.parentElement) {
      ancestors.add(element);
    }
    const host = block.matches(playerSelector) ? block : block.querySelector(playerSelector);
    for (let element = host === block ? null : host?.parentElement;
      element && element !== block; element = element.parentElement) {
      wrappers.add(element);
    }
    for (const [attribute, desired] of [['data-bpa-path', ancestors], ['data-bpa-player-path', wrappers]]) {
      const current = layoutPaths.get(attribute);
      for (const element of current) {
        if (!desired.has(element)) { element.removeAttribute(attribute); current.delete(element); }
      }
      for (const element of desired) {
        if (!element.hasAttribute(attribute)) element.setAttribute(attribute, '');
        current.add(element);
      }
    }
    for (const record of records.values()) updateButtons(record);
  }

  // Restore the current player's controls and scroll location on user exit.
  // Navigation cleanup passes false to avoid focusing a departing post.
  function leaveWindow(restoreFocus = true) {
    const lastStage = stage;
    const record = [...records.values()].find(record => record.block === lastStage);
    layoutRevision++;
    windowed = false;
    document.documentElement.removeAttribute('data-bpa-windowed');
    clearStage();
    for (const item of records.values()) updateButtons(item);
    if (restoreFocus && lastStage?.isConnected) {
      lastStage.scrollIntoView({ block: 'center', behavior: 'instant' });
      record?.windowButton.focus({ preventScroll: true });
    }
  }

  function focusPlayer(record) {
    const region = record.root?.querySelector(regionSelector);
    (region?.hasAttribute('tabindex') ? region : record.windowButton).focus({ preventScroll: true });
  }

  // Native fullscreen belongs to VK. Exit it before changing a window-view
  // stage, since its fullscreen element would otherwise still show the old clip.
  // Return false on cancellation so a late exit cannot close a newly selected
  // fullscreen player after a toggle, manual choice, or page navigation.
  async function exitNativeFullscreen(isCurrent) {
    for (let i = 0; document.fullscreenElement && i < 8; i++) {
      if (!isCurrent()) return false;
      await document.exitFullscreen();
    }
    if (!isCurrent()) return false;
    if (document.fullscreenElement) throw new Error('fullscreen-exit-failed');
    return true;
  }

  async function toggleWindow(record) {
    const revision = ++layoutRevision;
    const mediaGeneration = generation;
    const pathname = location.pathname;
    const isCurrent = () => revision === layoutRevision && mediaGeneration === generation &&
      pathname === location.pathname && record.host.isConnected;
    if (document.fullscreenElement) {
      try {
        if (!await exitNativeFullscreen(isCurrent)) return;
      } catch {
        if (isCurrent()) showStatus('Выйдите из полного экрана кнопкой плеера или Esc и нажмите «На всё окно».');
        return;
      }
    }
    if (!isCurrent()) return;
    if (windowed && stage === record.block) { leaveWindow(); return; }
    if (active !== record) cancelTransition();
    active = record;
    windowed = true;
    showStage(record.block);
    document.documentElement.setAttribute('data-bpa-windowed', '');
    for (const other of records.values()) {
      if (other !== record && other.video && !other.video.paused) other.video.pause();
    }
    focusPlayer(record);
  }

  function setEnabled(value) {
    enabled = value === true;
    preferenceRevision++;
    for (const record of records.values()) updateButtons(record);
    if (!enabled) {
      cancelTransition();
      hideStatus();
      // Window view is independent of the autoplay preference.
    }
  }

  function makeButton(record) {
    const button = document.createElement('button');
    button.className = 'bpa-toggle';
    button.type = 'button';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [key, value] of Object.entries({x: '2', y: '5', width: '20', height: '14', rx: '7', opacity: '.35'})) {
      track.setAttribute(key, value);
    }
    const knob = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    knob.setAttribute('class', 'bpa-knob');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '9');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '5');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M7.7 9v6l4.5-3z');
    path.setAttribute('fill', '#181818');
    knob.append(circle, path);
    svg.append(track, knob);
    button.append(svg);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setEnabled(!enabled);
      chrome.storage.local.set({ enabled }).catch(() => {
        showStatus('Настройка действует в этой вкладке, но не сохранилась. Перезагрузите расширение.');
      });
    });
    return button;
  }

  function makeWindowButton(record) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bpa-window-toggle';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', 'M4 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4zm0 2h16v12H4V6zm2 2h12v8H6V8z');
    svg.append(path);
    button.append(svg);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleWindow(record);
    });
    return button;
  }

  function onPlay(record) {
    if (active !== record && pendingBlock !== record.block) cancelTransition();
    active = record;
    if (!enabled && !windowed) return;
    for (const other of records.values()) {
      if (other !== record && other.video && !other.video.paused) other.video.pause();
    }
    if (windowed && stage !== record.block) {
      showStage(record.block);
      focusPlayer(record);
    }
  }

  function mediaSettings(video) {
    return { volume: video.volume, muted: video.muted, playbackRate: video.playbackRate };
  }

  function refreshRecord(record) {
    const roots = openRoots(record.host);
    for (const root of roots) {
      if (record.observers.has(root)) continue;
      const observer = new MutationObserver(changes => {
        if (changes.some(change => [...change.addedNodes, ...change.removedNodes]
          .some(node => node.nodeType === Node.ELEMENT_NODE))) scheduleScan();
      });
      observer.observe(root, { childList: true, subtree: true });
      record.observers.set(root, observer);
    }
    const video = roots.map(root => root.querySelector('video')).find(Boolean);
    if (video !== record.video) {
      record.mediaAbort?.abort();
      record.video = video;
      if (video) {
        record.mediaAbort = new AbortController();
        const options = { signal: record.mediaAbort.signal };
        video.addEventListener('play', () => onPlay(record), options);
        video.addEventListener('ended', () => advance(record), options);
        if (!video.paused) onPlay(record);
      }
    }
    const root = roots.find(root => root.querySelector('[data-testid="player_controls"]'))
      || roots.find(root => root.querySelector(regionSelector));
    if (!root) return;
    record.root = root;
    if (!root.querySelector('style[data-bpa-style]')) {
      const style = document.createElement('style');
      style.setAttribute('data-bpa-style', '');
      style.textContent = shadowCSS;
      root.append(style);
    }
    const controls = root.querySelector('[data-testid="player_controls"] .controls-right')
      || root.querySelector('[data-testid="player_controls"]');
    const container = controls || root.querySelector(regionSelector);
    if (!container) return;
    const native = controls?.querySelector('[data-testid="fullscreen-btn"]')
      || controls?.querySelector('button:not(.bpa-button)');
    // Reuse VK's own scoped classes as well as its measured fallback metrics.
    // Each rerender can change the generated classes; read them from live DOM.
    for (const control of record.controls) {
      const type = control.button === record.button ? 'bpa-toggle' : 'bpa-window-toggle';
      control.button.className = `${native?.className || 'btn'} bpa-button ${type}`;
      control.container.className = `${native?.closest('.btn-container')?.className || ''} bpa-control`;
      control.tooltip.className = `${native?.closest('.tooltip-wrapper')?.className || ''} bpa-tooltip`;
    }
    record.group.classList.toggle('bpa-floating', !controls);
    if (record.group.parentNode !== container) {
      const before = native?.closest('.btn-container');
      container.insertBefore(record.group, before?.parentNode === container ? before : null);
    }
    updateButtons(record);
  }

  function disposeRecord(record) {
    record.group.remove();
    record.mediaAbort?.abort();
    for (const observer of record.observers.values()) observer.disconnect();
    record.observers.clear();
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 80);
  }

  function scan() {
    const nextPageId = location.pathname.match(postPathPattern)?.[1] || null;
    const nextPost = nextPageId
      ? [...document.querySelectorAll('[data-post-id]')]
        .find(element => element.getAttribute('data-post-id') === nextPageId) || null
      : null;
    if (pageId !== nextPageId || post !== nextPost) {
      cancelTransition();
      hideStatus();
      leaveWindow(false);
      for (const record of records.values()) disposeRecord(record);
      records.clear();
      active = null;
      pageId = nextPageId;
      post = nextPost;
    }
    for (const [host, record] of records) {
      if (!host.isConnected || !post?.contains(host)) {
        if (active === record) active = null;
        disposeRecord(record);
        records.delete(host);
      }
    }
    if (!post) return;
    for (const host of post.querySelectorAll(playerSelector)) {
      if (host.closest('[data-post-id]') !== post) continue;
      let record = records.get(host);
      if (!record) {
        record = { host, block: host.closest('[id^="video-"]') || host,
          observers: new Map(), video: null, root: null, mediaAbort: null, button: null,
          windowButton: null, group: document.createElement('div'), controls: [] };
        record.group.className = 'bpa-controls';
        record.button = makeButton(record);
        record.windowButton = makeWindowButton(record);
        for (const button of [record.button, record.windowButton]) {
          const container = document.createElement('div');
          const tooltip = document.createElement('div');
          tooltip.append(button);
          container.append(tooltip);
          record.group.append(container);
          record.controls.push({ button, container, tooltip });
        }
        records.set(host, record);
      }
      refreshRecord(record);
    }
    if (pendingBlock && !pendingBlock.isConnected) cancelTransition();
    if (windowed) {
      const currentStage = stage?.isConnected ? stage : queue().find(block => block.id && block.id === stage?.id);
      if (currentStage) showStage(currentStage);
      else leaveWindow(false);
    }
  }

  // A preloaded <video> can already play while VK still shows its unstarted
  // overlay. Only VK's own start control completes that player initialization.
  function unstartedPreview(record) {
    const thumb = record.root?.querySelector('[data-testid="unstarted-thumb"]');
    if (!thumb || thumb.hidden || thumb.classList.contains('hidden')) return null;
    const style = getComputedStyle(thumb);
    return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' ? null : thumb;
  }

  function nativePlay(record) {
    const root = record.root;
    const button = unstartedPreview(record)?.querySelector('button, [role="button"]')
      || root?.querySelector('[data-testid="play-btn"]')
      || root?.querySelector('[role="region"] [role="button"]');
    button?.click();
  }

  function valid(token, block) {
    return token === generation && enabled && block.isConnected && post?.contains(block) &&
      location.pathname.match(postPathPattern)?.[1] === pageId;
  }

  // Wait for lazy rendering and the actual media element. A generation token
  // invalidates late work after a toggle, manual selection, or SPA navigation.
  async function waitForVideo(block, token) {
    const deadline = Date.now() + 15000;
    let clickedHost = null;
    while (valid(token, block) && Date.now() < deadline) {
      scan();
      const host = block.matches(playerSelector) ? block : block.querySelector(playerSelector);
      const record = records.get(host);
      if (record) {
        const preview = unstartedPreview(record);
        const needsInitialization = preview || !record.video ||
          (!record.video.readyState && !record.video.currentSrc);
        if (clickedHost !== host && record.root && needsInitialization) {
          clickedHost = host;
          nativePlay(record);
          refreshRecord(record);
        }
        // Do not treat media readiness as player readiness: keep waiting while
        // the native start overlay still covers the decoded video frames.
        if (record.video && !unstartedPreview(record)) return record;
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    if (valid(token, block)) throw new Error('player-timeout');
    return null;
  }

  async function startBlock(block, settings) {
    cancelTransition();
    const token = generation;
    pendingBlock = block;
    showStatus('Загружаем следующее видео…');
    let timeout;
    try {
      if (windowed && document.fullscreenElement &&
        !await exitNativeFullscreen(() => valid(token, block))) return;
      if (!valid(token, block)) return;
      if (windowed) showStage(block);
      else block.scrollIntoView({ block: 'center', behavior: 'instant' });
      const record = await waitForVideo(block, token);
      if (!record || !valid(token, block)) return;
      const video = record.video;
      pendingVideo = video;
      video.volume = settings.volume;
      video.muted = settings.muted;
      video.playbackRate = settings.playbackRate;
      if (video.readyState > 0) video.currentTime = 0;
      else video.addEventListener('loadedmetadata', () => {
        if (valid(token, block)) video.currentTime = 0;
      }, { once: true });
      await Promise.race([
        video.play(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('play-timeout')), 15000); })
      ]);
      if (!valid(token, block)) return;
      pendingBlock = null;
      pendingVideo = null;
      active = record;
      if (windowed) focusPlayer(record);
      hideStatus();
    } catch (error) {
      if (!valid(token, block)) return;
      cancelTransition();
      const message = error?.name === 'NotAllowedError'
        ? 'Браузер просит нажать «Продолжить», чтобы запустить видео.'
        : 'Не удалось запустить следующее видео. Проверьте загрузку и доступ к нему.';
      showStatus(message, () => {
        if (!enabled || !block.isConnected) return;
        if (windowed && document.fullscreenElement) { startBlock(block, settings); return; }
        const host = block.matches(playerSelector) ? block : block.querySelector(playerSelector);
        const record = records.get(host);
        if (record && unstartedPreview(record)) { startBlock(block, settings); return; }
        // Start directly in the retry click, preserving browser user activation.
        if (record?.video) {
          cancelTransition();
          const retryToken = generation;
          pendingBlock = block;
          pendingVideo = record.video;
          record.video.volume = settings.volume;
          record.video.muted = settings.muted;
          record.video.playbackRate = settings.playbackRate;
          const retryFailed = () => {
            if (retryToken === generation) { pendingBlock = null; pendingVideo = null; }
          };
          try {
            Promise.resolve(record.video.play()).then(() => {
              if (valid(retryToken, block)) { pendingBlock = null; pendingVideo = null; hideStatus(); }
            }).catch(retryFailed);
          } catch { retryFailed(); }
        } else {
          if (record) nativePlay(record);
          startBlock(block, settings);
        }
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function advance(record) {
    if (!enabled || (active && active !== record) || pendingBlock) return;
    const blocks = queue();
    const index = blocks.indexOf(record.block);
    if (index < 0) return;
    const next = blocks[index + 1];
    if (!next) {
      showStatus('Это последнее видео в посте.');
      return;
    }
    startBlock(next, mediaSettings(record.video));
  }

  const preservedEscapes = new WeakSet();
  // Observe native fullscreen/menus before VK handles them, without intercepting
  // its key handler. The same Escape must never close two levels at once.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !windowed) return;
    if (document.fullscreenElement) { preservedEscapes.add(event); return; }
    const current = [...records.values()].find(record => record.block === stage);
    const overlays = current?.root?.querySelectorAll('[aria-expanded="true"], [role="dialog"], [role="menu"]') || [];
    if ([...overlays].some(element => element.getAttribute('aria-expanded') === 'true' ||
      (!element.hidden && element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'))) {
      preservedEscapes.add(event);
    }
  }, true);

  // Bubble after VK's controls: Escape first closes their open menus/dialogs.
  // With native fullscreen active the browser keeps its normal Escape behavior.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !windowed || document.fullscreenElement || event.defaultPrevented || preservedEscapes.has(event)) return;
    event.preventDefault();
    leaveWindow();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) setEnabled(changes.enabled.newValue);
  });
  const initialRevision = preferenceRevision;
  chrome.storage.local.get({ enabled: false }).then(settings => {
    if (initialRevision === preferenceRevision) setEnabled(settings.enabled);
  }).catch(() => {});

  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  // attachShadow itself is not a DOM mutation; poll for late-created open roots
  // and URL changes in Boosty's client-side navigation.
  setInterval(scan, 1000);
  window.addEventListener('popstate', scheduleScan);
  scan();
})();

/*
 * Connects the player adapter, queue, and window view for the current post.
 * Owns page discovery and the persisted preference; each component owns its
 * implementation state. Chrome loads the factories first in manifest order.
 */
(() => {
  'use strict';
  const { createPlayers, createAutoplay, createWindowView } = globalThis.BoostyEnhancer;
  const postPath = /\/posts\/([a-f\d-]{36})(?:\/|$)/i;
  let pageId = null;
  let post = null;
  let players;
  let autoplay;
  let scanTimer = null;
  let preferenceRevision = 0;

  function isCurrent(player) {
    return location.pathname.match(postPath)?.[1] === pageId && post?.isConnected &&
      player.connected && post.contains(player.element) && players.list().includes(player);
  }

  function updateControls() {
    if (!players || !autoplay) return;
    for (const player of players.list()) {
      player.setControls({ enabled: autoplay.enabled, windowed: view.active && view.player === player });
    }
  }

  const view = createWindowView({ isCurrent, onChange: updateControls });
  autoplay = createAutoplay({
    getPlayers: () => players.list(), isCurrent, view, onChange: updateControls
  });
  players = createPlayers({
    onPlay: player => autoplay.onPlay(player),
    onEnded: player => autoplay.onEnded(player),
    onAction(player, action) {
      if (!isCurrent(player)) return;
      if (action === 'autoplay') {
        setEnabled(!autoplay.enabled);
        chrome.storage.local.set({ enabled: autoplay.enabled }).catch(() => {
          autoplay.notify('Настройка действует в этой вкладке, но не сохранилась. Перезагрузите расширение.');
        });
      } else if (action === 'window') {
        autoplay.select(player);
        view.toggle(player).catch(error => {
          if (error?.name !== 'AbortError' && isCurrent(player)) {
            autoplay.notify('Выйдите из полного экрана кнопкой плеера или Esc и нажмите «На всё окно».');
          }
        });
      }
    },
    onChange() {
      autoplay.refresh();
      view.refresh(players.list());
      updateControls();
    }
  });

  function setEnabled(value) {
    preferenceRevision++;
    autoplay.setEnabled(value);
  }

  function scan() {
    const nextId = location.pathname.match(postPath)?.[1] || null;
    const nextPost = nextId
      ? [...document.querySelectorAll('[data-post-id]')]
        .find(element => element.getAttribute('data-post-id') === nextId) || null
      : null;
    if (nextId !== pageId || nextPost !== post) {
      autoplay.reset();
      view.close(false);
      pageId = nextId;
      post = nextPost;
      players.setPost(post);
    }
    players.refresh();
    view.refresh(players.list());
    updateControls();
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 80);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) setEnabled(changes.enabled.newValue);
  });
  const initialRevision = preferenceRevision;
  chrome.storage.local.get({ enabled: false }).then(settings => {
    if (initialRevision === preferenceRevision) setEnabled(settings.enabled);
  }).catch(() => {});

  // attachShadow() and history.pushState() do not produce document mutations.
  // A single fallback poll covers both, while DOM changes use a coalesced scan.
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const interval = setInterval(scan, 1000);
  window.addEventListener('popstate', scheduleScan);
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(scanTimer);
    autoplay.dispose();
    view.dispose();
    players.dispose();
  }, { once: true });
  scan();
})();

/*
 * Owns the tab-filling view without moving a player or replacing its controls.
 * Player handles expose only their outer element, connectivity, focus methods,
 * and open-menu state; this module never reads VK's private player records.
 *
 * toggle() changes the view after leaving native fullscreen. reveal() prepares
 * the next player's placement, respecting cancellation; closing the window view
 * while reveal() waits changes its result to normal-page placement. follow()
 * keeps an already-open view on a manually selected player. refresh() reconciles
 * lazy rendering and replacement blocks. close() restores focus unless false is
 * passed for navigation cleanup. dispose() also removes keyboard listeners.
 * reveal() rejects with AbortError when canceled. Current native-fullscreen
 * failures are propagated; stale toggle/follow requests finish without effect.
 */
(() => {
  'use strict';

  const namespace = globalThis.BoostyEnhancer ||= {};

  namespace.createWindowView = ({ isCurrent, onChange = () => {} }) => {
    const paths = new Map([
      ['data-bpa-path', new Set()],
      ['data-bpa-player-path', new Set()]
    ]);
    const preservedEscapes = new WeakSet();
    let active = false;
    let player = null;
    let stage = null;
    let uiRevision = 0;
    let selectionRevision = 0;
    let disposed = false;

    const current = candidate => !disposed && candidate?.connected && isCurrent(candidate);
    const aborted = () => new DOMException('The window view request was canceled.', 'AbortError');

    function clearStage() {
      stage?.removeAttribute('data-bpa-stage');
      stage = null;
      for (const [attribute, elements] of paths) {
        for (const element of elements) element.removeAttribute(attribute);
        elements.clear();
      }
    }

    // Preserve real wrapper boxes for Boosty's lazy-loading observers. Unchanged
    // paths must not be removed/re-added by a periodic refresh.
    function show(candidate) {
      const block = candidate.element;
      const changed = player !== candidate;
      if (stage !== block) {
        stage?.removeAttribute('data-bpa-stage');
        stage = block;
      }
      player = candidate;
      if (!block.hasAttribute('data-bpa-stage')) block.setAttribute('data-bpa-stage', '');

      const ancestors = new Set();
      const wrappers = new Set();
      for (let element = block.parentElement;
        element && element !== document.documentElement; element = element.parentElement) {
        ancestors.add(element);
      }
      const host = block.matches('vk-video-player') ? block : block.querySelector('vk-video-player');
      for (let element = host === block ? null : host?.parentElement;
        element && element !== block; element = element.parentElement) {
        wrappers.add(element);
      }
      for (const [attribute, desired] of [['data-bpa-path', ancestors], ['data-bpa-player-path', wrappers]]) {
        const previous = paths.get(attribute);
        for (const element of previous) {
          if (!desired.has(element)) { element.removeAttribute(attribute); previous.delete(element); }
        }
        for (const element of desired) {
          if (!element.hasAttribute(attribute)) element.setAttribute(attribute, '');
          previous.add(element);
        }
      }
      if (changed) onChange();
    }

    // A native fullscreen stack can have more than one entry. Check ownership
    // before every exit and after every await, including a rejected exit.
    async function leaveNativeFullscreen(valid) {
      for (let count = 0; document.fullscreenElement && count < 8; count++) {
        if (!valid()) return false;
        try {
          await document.exitFullscreen();
        } catch (error) {
          if (!valid()) return false;
          throw error;
        }
        if (!valid()) return false;
      }
      if (!valid()) return false;
      if (document.fullscreenElement) throw new Error('fullscreen-exit-failed');
      return true;
    }

    function close(restoreFocus = true) {
      const previous = player;
      const wasActive = active;
      uiRevision++;
      active = false;
      player = null;
      document.documentElement.removeAttribute('data-bpa-windowed');
      clearStage();
      if (wasActive) onChange();
      if (restoreFocus && current(previous)) {
        previous.element.scrollIntoView({ block: 'center', behavior: 'instant' });
        previous.focusWindowButton();
      }
    }

    async function toggle(candidate) {
      const revision = ++uiRevision;
      const pathname = location.pathname;
      const selection = selectionRevision;
      const valid = () => revision === uiRevision && selection === selectionRevision &&
        pathname === location.pathname && current(candidate);
      if (document.fullscreenElement && !await leaveNativeFullscreen(valid)) return;
      if (!valid()) return;
      if (active && player === candidate) { close(); return; }
      selectionRevision++;
      active = true;
      if (!document.documentElement.hasAttribute('data-bpa-windowed')) {
        document.documentElement.setAttribute('data-bpa-windowed', '');
      }
      show(candidate);
      candidate.focus();
    }

    async function reveal(candidate, signal) {
      const selection = ++selectionRevision;
      uiRevision++;
      const pathname = location.pathname;
      const valid = () => selection === selectionRevision && !signal?.aborted &&
        pathname === location.pathname && current(candidate);
      if (!valid()) throw aborted();
      if (active && document.fullscreenElement && !await leaveNativeFullscreen(valid)) throw aborted();
      if (!valid()) throw aborted();
      if (active) show(candidate);
      else candidate.element.scrollIntoView({ block: 'center', behavior: 'instant' });
    }

    async function follow(candidate) {
      if (!active || !current(candidate)) return;
      if (player === candidate) { show(candidate); return; }
      const selection = ++selectionRevision;
      uiRevision++;
      const pathname = location.pathname;
      const valid = () => selection === selectionRevision && active &&
        pathname === location.pathname && current(candidate);
      if (document.fullscreenElement && !await leaveNativeFullscreen(valid)) return;
      if (!valid()) return;
      show(candidate);
      candidate.focus();
    }

    function refresh(players) {
      if (!active || disposed) return;
      const replacement = players.find(candidate => candidate === player && current(candidate))
        || players.find(candidate => stage?.id && candidate.element.id === stage.id && current(candidate));
      if (!replacement) { close(false); return; }
      if (replacement !== player) { selectionRevision++; uiRevision++; }
      show(replacement);
    }

    function preserveEscape(event) {
      if (event.key !== 'Escape' || !active) return;
      if (document.fullscreenElement || player?.hasOpenMenu()) preservedEscapes.add(event);
    }

    function leaveOnEscape(event) {
      if (event.key !== 'Escape' || !active || document.fullscreenElement ||
        event.defaultPrevented || preservedEscapes.has(event)) return;
      event.preventDefault();
      close();
    }

    document.addEventListener('keydown', preserveEscape, true);
    document.addEventListener('keydown', leaveOnEscape);

    return {
      get active() { return active; },
      get player() { return player; },
      toggle,
      reveal,
      follow,
      refresh,
      close,
      dispose() {
        if (disposed) return;
        close(false);
        disposed = true;
        selectionRevision++;
        document.removeEventListener('keydown', preserveEscape, true);
        document.removeEventListener('keydown', leaveOnEscape);
      }
    };
  };
})();

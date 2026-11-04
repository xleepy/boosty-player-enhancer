(() => {
  'use strict';
  const modules = globalThis.BoostyEnhancer;

  /*
   * Owns the queue and one cancellable transition, including its retry action.
   * Players hide all VK/media details. First attempts and retries use the same
   * play contract (settings, startAt: 0, AbortSignal). Manual selection, disable,
   * and reset invalidate both pending playback and any old continuation button.
   */
  modules.createAutoplay = ({ getPlayers, isCurrent, view, onChange = () => {} }) => {
    let enabled = false;
    let active = null;
    let pending = null;
    let retry = null;
    let revision = 0;
    let noticeTimer = null;

    function clearNotice() {
      clearTimeout(noticeTimer);
      document.getElementById('bpa-status')?.remove();
    }

    function notice(message, continuePlayback, temporary = false) {
      clearNotice();
      const box = document.createElement('div');
      box.id = 'bpa-status';
      box.setAttribute('role', 'status');
      const text = document.createElement('span');
      text.textContent = message;
      box.append(text);
      if (continuePlayback) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Продолжить';
        button.addEventListener('click', continuePlayback);
        box.append(button);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Закрыть уведомление');
      close.addEventListener('click', clearNotice);
      box.append(close);
      document.documentElement.append(box);
      if (temporary) noticeTimer = setTimeout(clearNotice, 5000);
    }

    function cancel() {
      revision++;
      const previous = pending;
      pending = null;
      retry = null;
      previous?.controller.abort();
      clearNotice();
    }

    function pauseOthers(player) {
      for (const other of getPlayers()) if (other !== player) other.pause();
    }

    // A stale owner must release its pending state as well as stop playback;
    // an older completion must never cancel a newer attempt.
    function canContinue(attempt) {
      const ownsTransition = pending === attempt;
      const valid = ownsTransition && enabled && isCurrent(attempt.player) &&
        !attempt.controller.signal.aborted;
      if (ownsTransition && !valid) cancel();
      return valid;
    }

    async function start(player, settings) {
      cancel();
      if (!enabled || !isCurrent(player)) return;
      const attempt = { player, settings, controller: new AbortController() };
      pending = attempt;
      notice('Загружаем следующее видео…');
      try {
        await view.reveal(player, attempt.controller.signal);
        if (!canContinue(attempt)) return;
        await player.play({ settings, signal: attempt.controller.signal, startAt: 0 });
        if (!canContinue(attempt)) return;
        pending = null;
        active = player;
        clearNotice();
        if (view.active) player.focus();
        onChange();
      } catch (error) {
        if (!canContinue(attempt)) return;
        pending = null;
        attempt.controller.abort();
        if (error?.name === 'AbortError') { clearNotice(); return; }
        const failure = { player, settings, revision };
        retry = failure;
        const message = error?.name === 'NotAllowedError'
          ? 'Браузер просит нажать «Продолжить», чтобы запустить видео.'
          : 'Не удалось запустить следующее видео. Проверьте загрузку и доступ к нему.';
        notice(message, () => {
          // Check context before revealing or playing anything. A retained DOM
          // button is harmless after manual selection or client-side navigation.
          if (retry !== failure || revision !== failure.revision) return;
          if (!enabled || !isCurrent(player)) { cancel(); return; }
          start(player, settings);
        });
        onChange();
      }
    }

    return {
      get enabled() { return enabled; },
      setEnabled(value) {
        enabled = value === true;
        if (!enabled) cancel();
        onChange();
      },
      select(player) {
        if (!isCurrent(player)) return;
        if (active !== player && pending?.player !== player) cancel();
        active = player;
        pauseOthers(player);
      },
      onPlay(player) {
        if (!isCurrent(player)) return;
        if (pending?.player !== player) cancel();
        active = player;
        if (enabled || view.active) pauseOthers(player);
        if (view.active) {
          view.follow(player).catch(error => {
            if (error?.name !== 'AbortError' && isCurrent(player)) {
              notice('Не удалось изменить режим просмотра. Выйдите из полного экрана и повторите.', null, true);
            }
          });
        }
      },
      onEnded(player) {
        if (!enabled || pending || !isCurrent(player) || (active && active !== player)) return;
        const players = getPlayers();
        const index = players.indexOf(player);
        if (index < 0) return;
        const next = players[index + 1];
        if (!next) { notice('Это последнее видео в посте.', null, true); return; }
        start(next, player.snapshot());
      },
      reset() { cancel(); active = null; onChange(); },
      refresh() {
        if ((pending && !isCurrent(pending.player)) || (retry && !isCurrent(retry.player))) cancel();
        if (active && !isCurrent(active)) active = null;
      },
      notify(message) { notice(message, null, true); },
      dispose() { cancel(); active = null; }
    };
  };
})();

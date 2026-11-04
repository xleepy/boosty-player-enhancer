const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, eventually, delay, OTHER } = require('./helpers/boosty-fixture.cjs');

function retryButton(p) {
  return [...p.document.querySelectorAll('#bpa-status button')]
    .find(button => button.textContent === 'Продолжить');
}

test('the first native-triggered play receives the previous video settings', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  Object.assign(p.videos.get(0), { muted: true, volume: 0.12, playbackRate: 1.5 });
  p.end(0);
  await eventually(() => p.calls.playStates.some(call => call.key === 1), 'Next media was not started');
  const first = p.calls.playStates.find(call => call.key === 1);
  assert.deepEqual({ muted: first.muted, volume: first.volume, playbackRate: first.playbackRate },
    { muted: true, volume: 0.12, playbackRate: 1.5 },
    'The native start emitted audio before inheriting playback preferences');
});

test('retry starts from zero after metadata restores a saved playback position', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  p.setMediaState(1, { readyState: 0 });
  p.setRejectPlay(key => key === 1);
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => retryButton(p), 'First rejected play did not offer retry');
  p.loadMetadata(1, 90);
  p.setRejectPlay(null);
  const before = p.calls.playStates.length;
  retryButton(p).click();
  await eventually(() => p.calls.playStates.slice(before).some(call => call.key === 1), 'Retry never started media');
  const retried = p.calls.playStates.slice(before).find(call => call.key === 1);
  assert.equal(retried.currentTime, 0, 'Retry resumed the saved position instead of the queue start');
  assert.equal(p.videos.get(1).currentTime, 0);
});

test('replacing media while Play is pending starts the replacement in the same player', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  p.setDeferredPlay(1);
  await p.enable(); await p.start();
  Object.assign(p.videos.get(0), { muted: true, volume: 0.2, playbackRate: 1.25 });
  p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Next play was not requested');
  const resolveOld = p.deferredCompletion(1);
  p.setDeferredPlay(null);
  const { old, next } = p.replaceVideo(1);
  resolveOld?.();
  await eventually(() => p.calls.playStates.some(call => call.video === next),
    'A fulfilled old media promise hid the loading state without starting its replacement');
  await eventually(() => !next.paused, 'Replacement media remained paused');
  assert.equal(old.isConnected, false);
  assert.equal(next.muted, true);
  assert.equal(next.volume, 0.2);
  assert.equal(next.playbackRate, 1.25);
  await eventually(() => !p.document.getElementById('bpa-status'), 'Successful replacement kept a loading notification');
});

test('a native start control inserted after the player root is still activated', async t => {
  const p = fixture({ count: 2, lazyIndex: 1 }); t.after(() => p.close());
  p.mount(p.blocks[1], 1, { lazyVideo: true });
  const root = p.players.get(1).root;
  const thumb = root.querySelector('[data-testid="unstarted-thumb"]');
  thumb.remove();
  await p.enable(); await p.start(); p.end(0);
  await delay(250);
  root.querySelector('.keyboard-controls').prepend(thumb);
  await eventually(() => p.calls.nativePlay.includes(1), 'A failed early lookup permanently skipped native Play');
  await eventually(() => p.videos.has(1) && !p.videos.get(1).paused, 'Late native Play did not start the video');
  assert.equal(p.calls.nativePlay.filter(key => key === 1).length, 1);
  assert.equal(thumb.classList.contains('hidden'), true);
});

test('a cancelled retry cannot replace a video selected manually', async t => {
  const p = fixture({ count: 3 }); t.after(() => p.close());
  p.setRejectPlay(key => key === 1);
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => retryButton(p), 'Rejected second video did not expose retry');
  const obsoleteRetry = retryButton(p);
  p.setRejectPlay(null);
  await p.start(2);
  assert.equal(retryButton(p), undefined, 'Manual selection retained an obsolete retry notification');
  const plays = p.calls.play.filter(key => key === 1).length;
  obsoleteRetry.click();
  await delay(100);
  assert.equal(p.calls.play.filter(key => key === 1).length, plays, 'Cancelled retry restarted the previous target');
  assert.equal(p.videos.get(2).paused, false, 'Cancelled retry paused the manually selected video');
});

test('a retry checks navigation before starting old media even before the next page poll', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  p.setRejectPlay(key => key === 1);
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => retryButton(p), 'Rejected second video did not expose retry');
  const obsoleteRetry = retryButton(p);
  const plays = p.calls.play.filter(key => key === 1).length;
  p.setRejectPlay(null);
  // pushState itself emits no popstate; stale controls remain connected until
  // the extension discovers the changed page on its next observation/poll.
  p.window.history.pushState({}, '', `/creator/posts/${OTHER}`);
  obsoleteRetry.click();
  await delay(100);
  assert.equal(p.calls.play.filter(key => key === 1).length, plays, 'Old media started before its navigation guard');
  assert.equal(p.videos.get(1).paused, true);
  await eventually(() => !retryButton(p), 'Navigation retained an obsolete retry action');
});

test('a post DOM node reused by SPA navigation gets a working new playback scope', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  const nextPost = '24a6189b-609f-4d50-ae60-d341aa3cf1d3';
  await p.enable(); await p.start(); await p.enterWindow();
  // A SPA can reuse the outer post element while changing its id and URL.
  // Resetting the page must still reconnect media and button lifetimes.
  p.post.dataset.postId = nextPost;
  p.window.history.pushState({}, '', `/creator/posts/${nextPost}`);
  p.window.dispatchEvent(new p.window.PopStateEvent('popstate'));
  await eventually(() => !p.document.documentElement.hasAttribute('data-bpa-windowed'),
    'The new post scope did not leave the old window view');
  await eventually(() => p.players.get(0).root.querySelector('.bpa-toggle')?.getAttribute('aria-pressed') === 'true',
    'The new post scope lost the enabled autoplay control');
  p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Reused post DOM kept permanently disconnected player handles');
  assert.equal(p.videos.get(1).paused, false);
  assert.equal(p.calls.play.includes('other'), false);
});

test('removing a pending lazy target clears its action and leaves the queue usable', async t => {
  const p = fixture({ count: 3, lazyIndex: 1 }); t.after(() => p.close());
  await p.enable(); await p.start(); p.end(0);
  await eventually(() => p.document.getElementById('bpa-status')?.textContent.includes('Загружаем'),
    'The lazy target was not awaiting playback');
  p.blocks[1].remove();
  await eventually(() => !p.document.getElementById('bpa-status'),
    'Removed target retained its loading or continuation action');
  assert.equal(p.calls.play.includes(1), false);
  // The queue now contains blocks 0 and 2. Another ended notification must
  // select block 2 rather than remain locked by the removed target's operation.
  p.end(0);
  await eventually(() => p.calls.play.includes(2), 'Removed pending target left the queue locked');
  assert.equal(p.videos.get(2).paused, false);
});

test('an outer block replacement already playing before discovery can continue its queue', async t => {
  const p = fixture({ count: 2 }); t.after(() => p.close());
  await p.enable(); await p.start();
  const old = p.blocks[0];
  const replacement = p.document.createElement('div');
  replacement.id = old.id;
  old.replaceWith(replacement);
  p.blocks[0] = replacement;
  p.mount(replacement, 0);
  const root = p.players.get(0).root;
  const thumb = root.querySelector('[data-testid="unstarted-thumb"]');
  thumb.classList.add('hidden');
  thumb.style.visibility = 'hidden';
  // Start synchronously, before MutationObserver/poll discovers this host.
  // Discovery must publish the new handle before forwarding its playing state.
  await p.videos.get(0).play();
  await eventually(() => root.querySelector('.bpa-toggle'), 'Replacement player was not discovered');
  p.end(0);
  await eventually(() => p.calls.play.includes(1), 'Already playing replacement kept the old active handle');
  assert.equal(p.videos.get(1).paused, false);
});

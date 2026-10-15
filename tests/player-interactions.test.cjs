const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../js/player-core.js');
const progress = require('../js/player-progress.js');
function playerFixture({ preferences = {}, playback = {}, storage, now, tracks, lrc = '', reducedMotion = true, frameClock,
  href = 'https://music.example.com/', clipboard } = {}) {
  let storedPreferences = preferences;
  let storedPlayback = playback;
  const storageWrites = [];
  class Element {
    constructor() {
      this.events = new Map(); this.children = []; this.dataset = {}; this.value = ''; this.attributes = new Map();
      this.scrollTop = 0; this.clientHeight = 300; this.scrollHeight = 1000;
      this.style = { values: new Map(), setProperty(name, value) { this.values.set(name, String(value)); }, getPropertyValue(name) { return this.values.get(name) || ''; } };
      this.classList = { add() {}, remove() {}, toggle() { return false; } };
    }
    addEventListener(name, handler) { const handlers = this.events.get(name) || []; handlers.push(handler); this.events.set(name, handlers); }
    emit(name, event = { target: this }) { for (const handler of this.events.get(name) || []) handler(event); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    getBoundingClientRect() { return this.rect || { left: 20, top: 450, right: 62, bottom: 492, width: 42, height: 42 }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return []; }
    scrollTo(options) { this.scrollTop = options.top; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const audio = get('audio');
  get('share').disabled = true;
  get('control-tooltip').rect = { width: 220, height: 40 };
  Object.assign(audio, {
    duration: NaN, currentTime: 0, paused: true, ended: false, readyState: 0,
    pause() { this.paused = true; this.emit('pause'); },
    async play() { this.paused = false; this.ended = false; this.emit('play'); },
    load() { this.duration = NaN; this.currentTime = 0; this.readyState = 0; this.ended = false; this.emit('emptied'); this.emit('loadstart'); }
  });
  const window = new Element();
  Object.assign(window, {
    ParryMusicCore: core, ParryMusicProgress: progress, matchMedia: () => ({ matches: reducedMotion }), innerWidth: 320, innerHeight: 568,
    PARRY_MUSIC_PLAYLIST: tracks || [{ url: './music/one.mp3' }, { url: './music/two.mp3' }]
  });
  if (frameClock) {
    window.requestAnimationFrame = callback => frameClock.request(callback);
    window.cancelAnimationFrame = id => frameClock.cancel(id);
  }
  const document = Object.assign(new Element(), { baseURI: href, body: new Element(), getElementById: get,
    createElement: () => new Element(), createElementNS: () => new Element(), createDocumentFragment: () => new Element() });
  vm.runInNewContext(readFileSync(path.join(__dirname, '../js/main.js'), 'utf8'), {
    window, document,
    navigator: { clipboard }, location: new URL(href), AbortController,
    fetch: async () => ({ ok: true, text: async () => lrc }),
    localStorage: storage || {
      getItem: key => JSON.stringify(key.startsWith('parrymusic:playback:') ? storedPlayback : storedPreferences),
      setItem(key, value) {
        storageWrites.push(key);
        if (key.startsWith('parrymusic:playback:')) storedPlayback = JSON.parse(value);
        else storedPreferences = JSON.parse(value);
      }
    }, Date: now ? class extends Date { static now() { return now(); } } : Date, URL, clearTimeout, setTimeout
  });
  return { audio, get, window, document, storageWrites, getPreferences: () => storedPreferences, getPlayback: () => storedPlayback };
}

test('refresh restores the tenth song and its position while keeping playback paused', () => {
  const tracks = Array.from({ length: 12 }, (_, i) => ({ url: './music/' + (i + 1) + '.mp3' }));
  const first = playerFixture({ tracks });
  first.get('playlist').emit('click', { target: { closest: () => ({ dataset: { index: '9' } }) } });
  first.audio.duration = 180; first.audio.readyState = 1; first.audio.currentTime = 75;
  first.window.emit('pagehide');
  const restored = playerFixture({ tracks, playback: first.getPlayback() });
  assert.equal(restored.audio.src, 'https://music.example.com/music/10.mp3');
  assert.equal(restored.audio.paused, true);
  assert.equal(restored.getPlayback().time, 75);
  restored.audio.duration = 180; restored.audio.readyState = 1; restored.audio.emit('loadedmetadata');
  assert.equal(restored.audio.currentTime, 75);
  assert.equal(restored.get('current-time').textContent, '01:15');
  assert.equal(restored.audio.paused, true);
  restored.get('play').emit('click');
  assert.equal(restored.audio.paused, false);
  assert.equal(restored.audio.currentTime, 75);
  restored.get('next').emit('click');
  assert.equal(restored.audio.src, 'https://music.example.com/music/11.mp3');
});

const shareTracks = [
  { id: '7c9e2a4b1f08', url: './music/one.mp3' },
  { id: 'abcdef123456', url: './music/two.mp3' },
  { id: '123456abcdef', url: './music/three.mp3' }
];

test('share links override saved playback, start paused from zero, and follow IDs after reordering', () => {
  for (const tracks of [shareTracks, [...shareTracks].reverse()]) {
    const player = playerFixture({ tracks, href: 'https://music.example.com/?s=ABCDEF123456',
      playback: { url: 'https://music.example.com/music/one.mp3', time: 75 } });
    assert.equal(player.audio.src, 'https://music.example.com/music/two.mp3');
    player.audio.duration = 100; player.audio.readyState = 1; player.audio.emit('loadedmetadata');
    assert.equal(player.audio.currentTime, 0);
    assert.equal(player.audio.paused, true);
    assert.equal(player.getPlayback().time, 0);
    assert.equal(player.get('share').disabled, false);
  }
});

test('missing and malformed share links fall back to saved playback and show a message', () => {
  for (const query of ['s=ffffffffffff', 's=', 's=https://other.example/remote.mp3', 's=%3Cscript%3E']) {
    const player = playerFixture({ tracks: shareTracks, href: 'https://music.example.com/?' + query,
      playback: { url: 'https://music.example.com/music/three.mp3', time: 35 } });
    assert.equal(player.audio.src, 'https://music.example.com/music/three.mp3');
    player.audio.duration = 100; player.audio.readyState = 1; player.audio.emit('loadedmetadata');
    assert.equal(player.audio.currentTime, 35);
    assert.equal(player.audio.paused, true);
    assert.match(player.get('status-message').textContent, /分享的歌曲不存在或链接无效/);
  }
  const empty = playerFixture({ tracks: [], href: 'https://music.example.com/?s=abcdef123456' });
  assert.equal(empty.get('share').disabled, true);
  assert.match(empty.get('status-message').textContent, /分享的歌曲不存在/);
});

test('sharing copies the current song from a subdirectory without unrelated query parameters or progress', async () => {
  const copied = [];
  const player = playerFixture({ tracks: shareTracks, href: 'https://music.example.com/player/index.html?other=1&s=7c9e2a4b1f08#lyrics',
    clipboard: { async writeText(value) { copied.push(value); } } });
  player.get('share').emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(copied, ['https://music.example.com/player/?s=7c9e2a4b1f08']);
  assert.equal(player.audio.paused, true);
  assert.match(player.get('status-message').textContent, /链接已复制/);
  player.get('next').emit('click');
  player.audio.duration = 100; player.audio.readyState = 1; player.audio.currentTime = 45;
  player.get('share').emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied[1], 'https://music.example.com/player/?s=abcdef123456');
  assert.equal(player.audio.currentTime, 45);
  assert.equal(player.audio.paused, false);
});

test('copying unavailable or denied shows a selected link for manual copying', async () => {
  for (const clipboard of [undefined, { async writeText() { throw new Error('permission denied'); } }]) {
    const player = playerFixture({ tracks: shareTracks, clipboard });
    player.get('share').emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(player.get('share-dialog').open, true);
    assert.equal(player.get('share-url').value, 'https://music.example.com/?s=7c9e2a4b1f08');
    assert.equal(player.get('share-url').focused, true);
    assert.equal(player.get('share-url').selected, true);
    assert.equal(player.audio.paused, true);
    player.get('close-share').emit('click');
    assert.equal(player.get('share-dialog').open, false);
  }
});

test('a delayed clipboard result cannot overwrite the next song status or open a stale dialog', async () => {
  for (const failed of [true, false]) {
    let finish;
    const player = playerFixture({ tracks: shareTracks, clipboard: {
      writeText() { return new Promise((resolve, reject) => { finish = failed ? reject : resolve; }); }
    } });
    player.get('share').emit('click');
    player.get('next').emit('click');
    finish(new Error('permission denied'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(player.get('status-message').textContent, '');
    assert.notEqual(player.get('share-dialog').open, true);
    assert.equal(player.audio.src, 'https://music.example.com/music/two.mp3');
  }
});

test('old playlists, duplicate IDs and local file playback remain playable with sharing disabled', async () => {
  const cases = [
    { tracks: [{ url: './music/one.mp3' }] },
    { tracks: [{ id: '7c9e2a4b1f08', url: './music/one.mp3' }, { id: '7c9e2a4b1f08', url: './music/two.mp3' }], href: 'https://music.example.com/?s=7c9e2a4b1f08' },
    { tracks: shareTracks, href: 'file:///Users/test/player/index.html' }
  ];
  for (const options of cases) {
    const copied = [];
    const player = playerFixture({ ...options, clipboard: { async writeText(value) { copied.push(value); } } });
    assert.equal(player.get('share').disabled, true);
    player.get('share').emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(copied, []);
    player.get('play').emit('click');
    assert.equal(player.audio.paused, false);
  }
});

test('opening a shared song starts sequential and random queues at the selected song', () => {
  for (const playMode of ['sequence', 'random']) {
    const player = playerFixture({ tracks: shareTracks, preferences: { playMode }, href: 'https://music.example.com/?s=abcdef123456' });
    assert.equal(player.audio.src, 'https://music.example.com/music/two.mp3');
    player.get('next').emit('click');
    if (playMode === 'sequence') assert.equal(player.audio.src, 'https://music.example.com/music/three.mp3');
    else assert.notEqual(player.audio.src, 'https://music.example.com/music/two.mp3');
  }
});

test('restoration follows the song URL after reordering and resets when the song was removed', () => {
  const playback = { url: 'https://music.example.com/music/two.mp3', time: 40 };
  const reordered = playerFixture({ playback, tracks: [{ url: './music/two.mp3' }, { url: './music/one.mp3' }] });
  assert.equal(reordered.audio.src, playback.url);
  reordered.audio.duration = 100; reordered.audio.readyState = 1; reordered.audio.emit('loadedmetadata');
  assert.equal(reordered.audio.currentTime, 40);
  const removed = playerFixture({ playback, tracks: [{ url: './music/one.mp3' }] });
  removed.audio.duration = 100; removed.audio.readyState = 1; removed.audio.emit('loadedmetadata');
  assert.equal(removed.audio.src, 'https://music.example.com/music/one.mp3');
  assert.equal(removed.audio.currentTime, 0);
  assert.equal(removed.audio.paused, true);
  assert.equal(removed.getPlayback().time, 0);
});

test('pending restoration survives early refresh and preference changes but is cleared by switching songs', () => {
  const playback = { url: 'https://music.example.com/music/two.mp3', time: 45 };
  const player = playerFixture({ playback });
  player.audio.emit('timeupdate');
  player.get('volume').emit('input', { target: { value: '0.3' } });
  player.get('play-mode').emit('click');
  player.window.emit('pagehide');
  assert.deepEqual(player.getPlayback(), playback);
  assert.equal(player.getPreferences().volume, 0.3);
  assert.equal(player.getPreferences().playMode, 'single');
  player.get('previous').emit('click');
  assert.deepEqual(player.getPlayback(), { url: 'https://music.example.com/music/one.mp3', time: 0 });
  player.audio.duration = 100; player.audio.readyState = 1; player.audio.emit('loadedmetadata');
  assert.equal(player.audio.currentTime, 0);
});

test('restored progress waits for finite duration, clamps to duration and yields to a newer seek', () => {
  const playback = { url: 'https://music.example.com/music/one.mp3', time: 120 };
  const player = playerFixture({ playback });
  player.audio.duration = Infinity; player.audio.readyState = 1; player.audio.emit('loadedmetadata');
  assert.equal(player.audio.currentTime, 0);
  assert.equal(player.getPlayback().time, 120);
  player.audio.duration = 60; player.audio.emit('durationchange');
  assert.equal(player.audio.currentTime, 60);
  assert.equal(player.getPlayback().time, 60);
  const newerSeek = playerFixture({ playback });
  newerSeek.audio.duration = 100;
  newerSeek.get('seek').value = '25'; newerSeek.get('seek').emit('change');
  newerSeek.window.emit('pagehide');
  assert.equal(newerSeek.getPlayback().time, 25);
  newerSeek.audio.readyState = 1; newerSeek.audio.emit('loadedmetadata');
  assert.equal(newerSeek.audio.currentTime, 25);
});

test('position saves are throttled, while pause, seek and leaving the page save immediately', () => {
  let now = 10000;
  const player = playerFixture({ now: () => now });
  const writes = () => player.storageWrites.filter(key => key.startsWith('parrymusic:playback:')).length;
  assert.equal(writes(), 1);
  player.audio.duration = 100; player.audio.readyState = 1; player.audio.emit('loadedmetadata');
  player.audio.currentTime = 10; now += 1000; player.audio.emit('timeupdate');
  assert.equal(writes(), 1);
  now += 4000; player.audio.emit('timeupdate');
  assert.equal(writes(), 2);
  assert.equal(player.getPlayback().time, 10);
  player.audio.currentTime = 11; player.audio.pause();
  assert.equal(player.getPlayback().time, 11);
  player.get('seek').value = '35'; player.get('seek').emit('input');
  assert.equal(player.getPlayback().time, 35);
  player.get('seek').emit('pointerdown'); player.get('seek').value = '80'; player.get('seek').emit('input');
  player.document.visibilityState = 'hidden'; player.document.emit('visibilitychange');
  assert.equal(player.getPlayback().time, 35);
  player.window.emit('pointercancel');
  player.audio.currentTime = 37; player.window.emit('pagehide');
  assert.equal(player.getPlayback().time, 37);
});

test('invalid saved positions and unavailable storage do not prevent normal playback', () => {
  for (const time of [-10, '20', null, Infinity, NaN]) {
    const player = playerFixture({ playback: { url: 'https://music.example.com/music/two.mp3', time } });
    player.audio.duration = 100; player.audio.readyState = 1; player.audio.emit('loadedmetadata');
    assert.equal(player.audio.currentTime, 0);
    assert.equal(player.audio.src, 'https://music.example.com/music/two.mp3');
  }
  for (const storage of [
    { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('storage disabled'); } },
    { getItem() { return '{broken JSON'; }, setItem() { throw new Error('quota exceeded'); } }
  ]) {
    const player = playerFixture({ storage });
    assert.equal(player.audio.src, 'https://music.example.com/music/one.mp3');
    player.get('next').emit('click');
    assert.equal(player.audio.src, 'https://music.example.com/music/two.mp3');
    assert.equal(player.audio.paused, false);
    player.window.emit('pagehide');
  }
  const empty = playerFixture({ tracks: [], playback: { url: 'https://music.example.com/music/two.mp3', time: 40 } });
  empty.window.emit('pagehide');
  assert.equal(empty.audio.src, undefined);
});

test('saved single and random modes build their queues around the restored song', () => {
  const tracks = [1, 2, 3, 4].map(i => ({ url: './music/' + i + '.mp3' }));
  const playback = { url: 'https://music.example.com/music/3.mp3', time: 20 };
  for (const playMode of ['single', 'random']) {
    const player = playerFixture({ tracks, preferences: { playMode }, playback });
    assert.equal(player.audio.src, playback.url);
    assert.equal(player.audio.paused, true);
    player.audio.duration = 100; player.audio.readyState = 1; player.audio.emit('loadedmetadata');
    assert.equal(player.audio.currentTime, 20);
    if (playMode === 'single') {
      player.audio.ended = true; player.audio.paused = true; player.audio.emit('ended');
      assert.equal(player.audio.src, playback.url);
      assert.equal(player.audio.currentTime, 0);
    } else {
      const played = [player.audio.src];
      for (let i = 0; i < 3; i++) { player.audio.emit('ended'); played.push(player.audio.src); }
      assert.deepEqual(played.map(url => url.split('/').pop()).sort(), ['1.mp3', '2.mp3', '3.mp3', '4.mp3']);
    }
  }
});

test('progress follows playback, seeking, duration changes and media reset', () => {
  const { audio, get } = playerFixture();
  audio.duration = 100; audio.readyState = 1; audio.emit('loadedmetadata');
  assert.equal(get('seek').disabled, false);
  audio.currentTime = 65; audio.emit('seeked'); audio.emit('timeupdate');
  assert.equal(get('seek').style.getPropertyValue('--progress'), '65%');
  assert.equal(get('current-time').textContent, '01:05');
  audio.duration = 200; audio.emit('durationchange');
  assert.equal(get('seek').style.getPropertyValue('--progress'), '32.5%');
  audio.duration = NaN; audio.emit('emptied');
  assert.equal(get('seek').style.getPropertyValue('--progress'), '0%');
  assert.equal(get('seek').disabled, true);
});

test('dragging previews without being overwritten by playback and switching songs resets progress', () => {
  const { audio, get } = playerFixture();
  audio.duration = 100; audio.readyState = 1; audio.emit('loadedmetadata');
  get('seek').emit('pointerdown'); get('seek').value = '70'; get('seek').emit('input');
  assert.equal(audio.currentTime, 0);
  audio.currentTime = 10; audio.emit('timeupdate');
  assert.equal(get('seek').value, '70');
  assert.equal(get('seek').style.getPropertyValue('--progress'), '70%');
  get('seek').emit('change');
  assert.equal(audio.currentTime, 70);
  get('next').emit('click');
  assert.equal(audio.src, 'https://music.example.com/music/two.mp3');
  assert.equal(get('seek').style.getPropertyValue('--progress'), '0%');
  assert.equal(get('seek').disabled, true);
});

test('single mode button cycles three functioning modes and updates the tooltip and icon', () => {
  const { audio, get, getPreferences } = playerFixture();
  get('play-mode').emit('pointerenter');
  assert.equal(get('control-tooltip').textContent, '顺序播放');
  assert.equal(get('play-mode-icon').getAttribute('href'), '#i-order');
  assert.ok(parseFloat(get('control-tooltip').style.left) >= 8);
  assert.ok(parseFloat(get('control-tooltip').style.left) + 220 <= 312);
  get('next').emit('click');
  audio.ended = true; audio.paused = true; audio.emit('ended');
  assert.equal(audio.src, 'https://music.example.com/music/two.mp3');
  assert.equal(audio.paused, true);
  assert.equal(get('status-message').textContent, '歌单已播放完毕。');
  get('play-mode').emit('click');
  assert.equal(get('control-tooltip').textContent, '单曲循环');
  assert.equal(get('play-mode-one').hidden, false);
  get('next').emit('click');
  assert.equal(audio.src, 'https://music.example.com/music/one.mp3');
  audio.duration = 60; audio.readyState = 1; audio.currentTime = 60; audio.ended = true; audio.paused = true;
  audio.emit('ended');
  assert.equal(audio.src, 'https://music.example.com/music/one.mp3');
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.paused, false);
  get('play-mode').emit('click');
  assert.equal(get('control-tooltip').textContent, '随机播放');
  assert.equal(get('play-mode-icon').getAttribute('href'), '#i-shuffle');
  assert.equal(get('play-mode-one').hidden, true);
  assert.equal(getPreferences().playMode, 'random');
  get('play-mode').emit('click');
  assert.equal(get('control-tooltip').textContent, '顺序播放');
  assert.equal(get('play-mode-icon').getAttribute('href'), '#i-order');
  get('play-mode').emit('pointerleave');
  assert.equal(get('control-tooltip').hidden, true);
  assert.equal(get('play-mode').getAttribute('aria-describedby'), null);
});

test('automatic sequential playback reaches every song in order and stops at the end', () => {
  const { audio, get } = playerFixture({ tracks: [1, 2, 3].map(i => ({url: './music/' + i + '.mp3'})) });
  const played = [audio.src];
  for (let i = 0; i < 2; i++) {
    audio.ended = true; audio.paused = true; audio.emit('ended'); played.push(audio.src);
  }
  assert.deepEqual(played.map(url => url.split('/').pop()), ['1.mp3', '2.mp3', '3.mp3']);
  audio.ended = true; audio.paused = true; audio.emit('ended');
  assert.equal(audio.src, played[2]);
  assert.equal(audio.paused, true);
  assert.equal(get('status-message').textContent, '歌单已播放完毕。');
});

test('random playback visits all songs once per round and avoids repeats across round boundaries', () => {
  const tracks = [1,2,3,4].map(i => ({url: './music/' + i + '.mp3'}));
  const { audio, get } = playerFixture({tracks});
  get('play-mode').emit('click'); get('play-mode').emit('click');
  const played = [audio.src];
  for (let i = 0; i < 11; i++) {
    audio.ended = true; audio.paused = true; audio.emit('ended'); played.push(audio.src);
  }
  for (let offset = 0; offset < 12; offset += 4) {
    assert.deepEqual(played.slice(offset,offset+4).map(url => url.split('/').pop()).sort(), ['1.mp3','2.mp3','3.mp3','4.mp3']);
    if (offset) assert.notEqual(played[offset], played[offset-1]);
  }
});

test('saved mode and legacy preferences map to the single mode button', () => {
  for (const [preferences, label] of [
    [{playMode:'random'}, '随机播放'],
    [{playMode:'single'}, '单曲循环'],
    [{loop:'one',shuffle:true}, '单曲循环'],
    [{loop:'all',shuffle:true}, '随机播放'],
    [{loop:'all',shuffle:false}, '顺序播放']
  ]) {
    const { get, getPreferences } = playerFixture({preferences});
    assert.equal(get('play-mode').getAttribute('aria-label'), label);
    assert.equal('loop' in getPreferences(), false);
    assert.equal('shuffle' in getPreferences(), false);
  }
});

test('lyric clicks defer a seek until duration becomes available and start playback', async () => {
  const { audio, get } = playerFixture({ tracks: [{ url: './music/song.mp3', lrc: './music/song.lrc' }], lrc: '[00:00]开头\n[00:30]目标歌词' });
  await new Promise(resolve => setImmediate(resolve));
  audio.duration = Infinity; audio.readyState = 1;
  get('lyrics-content').emit('click', { target: { closest: () => ({ dataset: { lyric: '1' } }) } });
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.paused, false);
  audio.duration = 60; audio.emit('durationchange');
  assert.equal(audio.currentTime, 30);
  assert.equal(get('seek').value, 50);
  get('seek').value = '75'; get('seek').emit('input');
  assert.equal(audio.currentTime, 45);
  assert.equal(get('current-time').textContent, '00:45');
});

test('drag release and change event order both commit the intended position once', () => {
  for (const releaseFirst of [true, false]) {
    const { audio, get, window } = playerFixture();
    audio.duration = 100; audio.readyState = 4; audio.emit('loadedmetadata');
    let time = 0;
    let writes = 0;
    Object.defineProperty(audio, 'currentTime', { get: () => time, set: value => { time = value; writes++; } });
    get('seek').emit('pointerdown'); get('seek').value = '70'; get('seek').emit('input');
    if (releaseFirst) window.emit('pointerup');
    get('seek').emit('change');
    if (!releaseFirst) window.emit('pointerup');
    assert.equal(time, 70);
    assert.equal(writes, 1);
  }
});

test('cancelled dragging restores actual playback position without seeking', () => {
  const { audio, get, window } = playerFixture();
  audio.duration = 100; audio.readyState = 4; audio.currentTime = 20; audio.emit('loadedmetadata');
  get('seek').emit('pointerdown'); get('seek').value = '80'; get('seek').emit('input');
  assert.equal(get('current-time').textContent, '01:20');
  window.emit('pointercancel');
  assert.equal(audio.currentTime, 20);
  assert.equal(get('seek').value, 20);
  assert.equal(get('current-time').textContent, '00:20');
});

test('latest pending seek wins and switching tracks clears pending seeks', () => {
  const { audio, get } = playerFixture();
  get('seek').value = '30';
  audio.duration = 100; audio.readyState = 0; get('seek').emit('change');
  get('seek').value = '80'; get('seek').emit('change');
  audio.readyState = 4; audio.emit('loadedmetadata');
  assert.equal(audio.currentTime, 80);
  audio.readyState = 0; get('seek').value = '40'; get('seek').emit('change');
  get('next').emit('click');
  audio.duration = 100; audio.readyState = 4; audio.emit('loadedmetadata');
  assert.equal(audio.currentTime, 0);
});

test('progress rendering never reads buffered ranges', () => {
  const { audio, get } = playerFixture();
  Object.defineProperty(audio, 'buffered', { get() { throw new Error('buffered ranges must not be read'); } });
  audio.duration = 100; audio.readyState = 4; audio.currentTime = 40;
  audio.emit('loadedmetadata'); audio.emit('timeupdate'); audio.emit('seeked');
  assert.equal(get('seek').value, 40);
});

test('lyric scrolling takes 500ms, changes target smoothly and stops for manual scrolling or song changes', async () => {
  let id = 0;
  const frames = new Map();
  const clock = {
    request(callback) { frames.set(++id, callback); return id; },
    cancel(frame) { frames.delete(frame); },
    tick(time) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); }
  };
  const { audio, get } = playerFixture({ reducedMotion: false, frameClock: clock,
    tracks: [{ url: './music/one.mp3', lrc: './music/one.lrc' }, { url: './music/two.mp3' }],
    lrc: '[00:00]第一行\n[00:10]第二行\n[00:20]第三行' });
  await new Promise(resolve => setImmediate(resolve));
  get('lyrics-content').children = [get('line-0'), get('line-1'), get('line-2')];
  get('line-1').rect = { top: 800 };
  get('line-2').rect = { top: 1000 };
  const container = get('lyrics-scroll');
  audio.currentTime = 10; audio.emit('timeupdate');
  clock.tick(0); clock.tick(250);
  assert.ok(container.scrollTop > 0 && container.scrollTop < 260);
  clock.tick(500);
  assert.equal(container.scrollTop, 260);
  assert.equal(frames.size, 0);
  audio.currentTime = 20; audio.emit('timeupdate');
  assert.equal(frames.size, 1);
  get('lyrics-scroll').emit('wheel');
  assert.equal(frames.size, 0);
  get('next').emit('click');
  assert.equal(frames.size, 0);
  assert.equal(container.scrollTop, 0);
});

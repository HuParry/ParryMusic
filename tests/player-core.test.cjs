const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../js/player-core.js");

test("filename metadata handles artist-first names, collaborators, annotations and hyphens", function () {
  const cases = [
    ["NewJeans（xxx） - ASAP.flac", "ASAP", "NewJeans"],
    ["The Chainsmokers - Closer.mp3", "Closer", "The Chainsmokers"],
    ["G-DRAGON&JENNIE - Black.flac", "Black", "G-DRAGON&JENNIE"],
    ["G-DRAGON - Black.flac", "Black", "G-DRAGON"],
    ["G-Dragon（Live）& JENNIE - Black.mp3", "Black", "G-Dragon&JENNIE"],
    ["G-DRAGON&T-Pain - Black.mp3", "Black", "G-DRAGON&T-Pain"],
    ["IN-K&安苏羽&傅梦彤 - 潮汐(Natural).flac", "潮汐(Natural)", "IN-K&安苏羽&傅梦彤"],
    ["IN-K - 歌名.mp3", "歌名", "IN-K"],
    ["歌手-A&歌手-B - 歌名.mp3", "歌名", "歌手-A&歌手-B"],
    ["Singer-One-Two&Another-Artist - 歌名.mp3", "歌名", "Singer-One-Two&Another-Artist"],
    ["(G)I-DLE - 歌名.mp3", "歌名", "(G)I-DLE"],
    ["  歌手1 & 歌手2  -  歌名  .MP3", "歌名", "歌手1&歌手2"],
    ["歌手1（备注 - 1）& 歌手2 [备注 - 2] - 歌名.mp3", "歌名", "歌手1&歌手2"],
    ["歌手 - 歌名（Live - 上海）.flac", "歌名（Live - 上海）", "歌手"],
    ["Singer - Song (Remix [Part - 2]).mp3", "Song (Remix [Part - 2])", "Singer"],
    ["歌手 - 歌名-另一段.mp3", "歌名-另一段", "歌手"],
    ["歌手 - 歌名 - Live.mp3", "歌名 - Live", "歌手"],
    ["歌手 - 歌名 & 另一首.mp3", "歌名 & 另一首", "歌手"],
    ["歌手（未闭合 - 歌名.mp3", "歌名", "歌手（未闭合"],
    ["只有歌名.mp3", "只有歌名", "未知歌手"],
    ["歌手-歌名.mp3", "歌手-歌名", "未知歌手"],
    ["歌手 -歌名.mp3", "歌手 -歌名", "未知歌手"],
    ["歌手- 歌名.mp3", "歌手- 歌名", "未知歌手"],
    ["歌手 - .mp3", "歌手 -", "未知歌手"],
    [" - 歌名.mp3", "- 歌名", "未知歌手"]
  ];
  for (const [filename, name, artist] of cases) {
    assert.deepEqual(core.songMetadata(filename), { name: name, artist: artist }, filename);
  }
});

test("browser fills omitted metadata with the shared parser while preserving explicit fields", function () {
  const base = "https://music.example.com/";
  const url = "./music/" + encodeURIComponent("NewJeans（xxx）&歌手2 - ASAP.mp3");
  const tracks = core.normalizePlaylist([{ url: url }, { url: url, name: "自定义歌名", artist: "自定义歌手" }], base, "").tracks;
  assert.equal(tracks[0].name, "ASAP");
  assert.equal(tracks[0].artist, "NewJeans&歌手2");
  assert.equal(tracks[1].name, "自定义歌名");
  assert.equal(tracks[1].artist, "自定义歌手");
  const complex = core.normalizePlaylist([{ url: "./music/" + encodeURIComponent("IN-K&安苏羽&傅梦彤 - 潮汐(Natural).flac") }], base, "").tracks[0];
  assert.equal(complex.name, "潮汐(Natural)");
  assert.equal(complex.artist, "IN-K&安苏羽&傅梦彤");
});

test("LRC parses BOM, metadata, multiple timestamps, fractional seconds and offsets", function () {
  const result = core.parseLrc("\uFEFF[ar:歌手]\r\n[offset:-500]\r\n[00:02.50][00:05.125]重复歌词\r\n[00:00.00]开始\r\n[00:03]另一行\r\n[00:60]无效\r\n[00:04.00]  ");
  assert.deepEqual(result, [
    { time: 0, text: "开始" },
    { time: 2, text: "重复歌词" },
    { time: 2.5, text: "另一行" },
    { time: 4.625, text: "重复歌词" }
  ]);
  assert.equal(core.lyricIndex(result, 1), 0);
  assert.equal(core.lyricIndex(result, 2.5), 2);
  assert.equal(core.lyricIndex(result, 99), 3);
  assert.equal(core.lyricIndex([{ time: 5, text: "later" }], 0), -1);
  assert.equal(core.lyricIndex([], 10), -1);
});

test("relative music paths preserve a nested static hosting prefix and encoded filenames", function () {
  const base = "https://music.example.com/player/";
  const filename = "./music/" + encodeURIComponent("歌手 - 歌曲 #100%?.mp3");
  const result = core.normalizePlaylist([{ url: filename }, { url: "javascript:alert(1)" }, null, { url: "https://other.example/remote.mp3" }], base, base + "img/default.svg");
  assert.equal(result.tracks.length, 1);
  assert.equal(result.invalidCount, 3);
  assert.equal(result.tracks[0].name, "歌曲 #100%?");
  assert.equal(result.tracks[0].artist, "歌手");
  assert.equal(result.tracks[0].url, new URL(filename, base).href);
  assert.equal(result.tracks[0].cover, base + "img/default.svg");
  assert.equal(result.tracks[0].lrc, "");
  assert.throws(function () { core.normalizePlaylist({}, base, ""); }, TypeError);
});

test("playlist text is preserved as data and file:// playback can resolve local tracks", function () {
  const base = "file:///Users/test/site/";
  const result = core.normalizePlaylist([{ name: "<img onerror=alert(1)>", artist: "歌手", url: "./music/a.mp3" }], base, base + "img/cover.svg");
  assert.equal(result.tracks[0].name, "<img onerror=alert(1)>");
  assert.equal(result.tracks[0].url, base + "music/a.mp3");
  assert.equal(core.assetURL("data:text/html,a", base), "");
});

test("ordered playback stops at the end while list loop wraps and manual switching works", function () {
  assert.equal(core.advanceQueue(2, 3, 1, "off", true), -1);
  assert.equal(core.advanceQueue(2, 3, 1, "all", true), 0);
  assert.equal(core.advanceQueue(0, 3, -1, "all", false), 2);
  assert.equal(core.advanceQueue(0, 3, 1, "off", true), 1);
  assert.equal(core.advanceQueue(2, 3, 1, "one", false), 0);
  assert.equal(core.advanceQueue(0, 0, 1, "all", true), -1);
});

test("a shuffled round contains every track once and starts at the selected track", function () {
  const result = core.buildPlayOrder(8, 3, true, function () { return 0.4; });
  assert.equal(result[0], 3);
  assert.deepEqual([...result].sort(function (a, b) { return a - b; }), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(core.buildPlayOrder(3, 1, false), [0, 1, 2]);
  assert.deepEqual(core.buildPlayOrder(1, 0, true), [0]);
});

test("unknown duration and time formatting are safe", function () {
  assert.equal(core.formatTime(NaN), "00:00");
  assert.equal(core.formatTime(Infinity), "00:00");
  assert.equal(core.formatTime(-1), "00:00");
  assert.equal(core.formatTime(125.9), "02:05");
  assert.equal(core.formatTime(3600), "60:00");
});

test("cover colour sampling favours a representative saturated colour and builds a dark palette", function () {
  const pixels = [];
  for (let i = 0; i < 90; i += 1) pixels.push(0, 0, 0, 255);
  for (let i = 0; i < 20; i += 1) pixels.push(220, 42, 38, 255);
  pixels.push(255, 255, 255, 0);
  const color = core.dominantColor(Uint8ClampedArray.from(pixels));
  assert.deepEqual(color, [220, 42, 38]);
  const palette = core.ambientPalette(color);
  const channels = value => value.match(/\d+/g).map(Number);
  assert.ok(channels(palette.primary)[0] > 106);
  assert.ok(channels(palette.base)[0] > channels(palette.base)[2]);
  assert.ok(channels(core.ambientPalette([20, 60, 200]).base)[2] > channels(core.ambientPalette([20, 60, 200]).base)[0]);
  const gray = channels(core.ambientPalette([255, 255, 255]).base);
  assert.equal(gray[0], gray[1]);
  assert.equal(gray[1], gray[2]);
  for (const input of [[255, 255, 255], [0, 255, 0], [255, 0, 0], [0, 0, 255], [0, 0, 0]]) {
    const rgb = channels(core.ambientPalette(input).primary).map(value => value / 255);
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    assert.ok(linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 <= 0.087);
  }
  assert.equal(core.dominantColor(null), null);
  assert.deepEqual(core.ambientPalette(null), {
    primary: "rgb(57, 82, 94)",
    secondary: "rgb(37, 55, 65)",
    base: "rgb(30, 43, 51)"
  });
});

test("near-black covers and subtle gray colour casts produce neutral backgrounds", function () {
  for (const color of [[0, 0, 0], [2, 4, 3], [0, 1, 0], [12, 1, 8], [100, 102, 101]]) {
    const pixels = Uint8ClampedArray.from(Array.from({ length: 36 }, () => [...color, 255]).flat());
    const palette = core.ambientPalette(core.dominantColor(pixels));
    for (const tone of Object.values(palette)) {
      const [red, green, blue] = tone.match(/\d+/g).map(Number);
      assert.equal(red, green, "Unexpected colour cast for " + color);
      assert.equal(green, blue, "Unexpected colour cast for " + color);
    }
  }
  const green = core.ambientPalette([24, 100, 40]).base.match(/\d+/g).map(Number);
  assert.ok(green[1] > green[0] && green[1] > green[2]);
});

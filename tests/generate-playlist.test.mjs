import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { collectTracks, generatePlaylist, serializePlaylist, assignSongIds, musicURL, assetRequestURL, LYRICS_API, COVER_API } from "../scripts/generate-playlist.mjs";

async function musicFixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "parrymusic-order-"));
  t.after(function () { return rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, "music"));
  for (const file of files) {
    const destination = path.join(root, "music", file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "fixture");
  }
  return root;
}

test("generation preserves manual order, appends new songs and removes deleted or renamed paths", async function (t) {
  const root = await musicFixture(t, ["Singer - 10.mp3", "Singer - 2.mp3", "Singer - 1.mp3"]);
  const music = path.join(root, "music");
  const destination = path.join(music, "playlist.js");
  const options = { fetchMissing: false };
  const initial = await generatePlaylist(root, options);
  assert.deepEqual(initial.map(track => track.name), ["1", "2", "10"]);
  await writeFile(destination, serializePlaylist([initial[2], initial[0], initial[1]]));
  assert.deepEqual((await generatePlaylist(root, options)).map(track => track.name), ["10", "1", "2"]);
  await rm(path.join(music, "Singer - 1.mp3"));
  await writeFile(path.join(music, "Singer - 0.mp3"), "fixture");
  await writeFile(path.join(music, "Singer - 3.mp3"), "fixture");
  const updated = await generatePlaylist(root, options);
  assert.deepEqual(updated.map(track => track.name), ["10", "2", "0", "3"]);
  const source = await readFile(destination, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.PARRY_MUSIC_PLAYLIST)), updated);
  assert.deepEqual(await generatePlaylist(root, options), updated);
  assert.equal(await readFile(destination, "utf8"), source);
  await rm(path.join(music, "Singer - 2.mp3"));
  await writeFile(path.join(music, "Singer - 20.mp3"), "fixture");
  assert.deepEqual((await generatePlaylist(root, options)).map(track => track.name), ["10", "0", "3", "20"]);
});

test("order matches normalized paths, keeps nested names and audio formats distinct, and ignores duplicate or missing entries", async function (t) {
  const root = await musicFixture(t, [
    "Singer - Same.mp3", "Singer - Same.flac",
    "专辑 A/Singer - Same.mp3", "专辑 B/Singer&Other - #100%?.mp3"
  ]);
  const special = musicURL("专辑 B/Singer&Other - #100%?.mp3");
  const entries = [
    { url: special.replace("./", "").replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()) },
    { url: "./music/专辑 A/Singer - Same.mp3" },
    { url: "./music/Singer - Same.mp3" },
    { url: "./music/Singer - Same.mp3" },
    { url: "./music/removed.mp3" },
    { url: "https://other.example/music/Singer%20-%20Same.flac" },
    { url: "./music/%broken.mp3" }, null, {}, { url: 42 }
  ];
  await writeFile(path.join(root, "music", "playlist.js"), serializePlaylist(entries));
  const tracks = await generatePlaylist(root, { fetchMissing: false });
  assert.deepEqual(tracks.map(track => track.url), [
    special, musicURL("专辑 A/Singer - Same.mp3"), musicURL("Singer - Same.mp3"), musicURL("Singer - Same.flac")
  ]);
});

test("regeneration keeps only custom order while refreshing metadata, lyrics and covers from local files", async function (t) {
  const root = await musicFixture(t, ["Singer - A.mp3", "Singer - A.jpg", "Singer - B.mp3"]);
  const music = path.join(root, "music");
  const initial = await generatePlaylist(root, { fetchMissing: false });
  await writeFile(path.join(music, "playlist.js"), serializePlaylist([
    { ...initial[1], name: "custom title", artist: "custom artist", lrc: "./music/missing.lrc" },
    initial[0]
  ]));
  await rm(path.join(music, "Singer - A.jpg"));
  await writeFile(path.join(music, "Singer - A.png"), "new cover");
  await writeFile(path.join(music, "Singer - B.lrc"), "[00:00]local lyrics");
  const tracks = await generatePlaylist(root, { fetchMissing: false });
  assert.deepEqual(tracks.map(track => track.name), ["B", "A"]);
  assert.equal(tracks[0].artist, "Singer");
  assert.equal(tracks[0].lrc, musicURL("Singer - B.lrc"));
  assert.equal(tracks[1].cover, musicURL("Singer - A.png"));
});

test("invalid existing playlists are not executed or overwritten and do not trigger asset downloads", async function (t) {
  const root = await musicFixture(t, ["Singer - A.mp3"]);
  const destination = path.join(root, "music", "playlist.js");
  const sources = [
    "window.PARRY_MUSIC_PLAYLIST = [{broken JSON];",
    "window.PARRY_MUSIC_PLAYLIST = {};",
    "window.PARRY_MUSIC_PLAYLIST = []; throw new Error('must not execute');",
    "window.PARRY_MUSIC_PLAYLIST = (() => { while (true) {} })();"
  ];
  for (const source of sources) {
    await writeFile(destination, source);
    await assert.rejects(generatePlaylist(root, { fetchImpl() { assert.fail("invalid playlists must fail before downloading"); } }), /无法读取.*原文件未修改/);
    assert.equal(await readFile(destination, "utf8"), source);
  }
});

test("empty and deleted playlists generate normally, and removing all audio produces an empty playlist", async function (t) {
  const root = await musicFixture(t, ["Singer - A.mp3"]);
  const destination = path.join(root, "music", "playlist.js");
  await writeFile(destination, " \n");
  assert.equal((await generatePlaylist(root, { fetchMissing: false })).length, 1);
  await rm(destination);
  assert.equal((await generatePlaylist(root, { fetchMissing: false })).length, 1);
  await rm(path.join(root, "music", "Singer - A.mp3"));
  assert.deepEqual(await generatePlaylist(root), []);
  assert.match(await readFile(destination, "utf8"), /window\.PARRY_MUSIC_PLAYLIST = \[\];/);
});

test("artist and title hyphens survive generation and API query encoding", async function (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "parrymusic-artist-"));
  t.after(function () { return rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, "music"));
  const cases = [
    ["G-DRAGON&JENNIE - Black.flac", "Black", "G-DRAGON&JENNIE"],
    ["IN-K&安苏羽&傅梦彤 - 潮汐(Natural).flac", "潮汐(Natural)", "IN-K&安苏羽&傅梦彤"],
    ["歌手-A&歌手-B - 歌名.mp3", "歌名", "歌手-A&歌手-B"],
    ["Singer-One&Another-Artist - Song-Part - Live.mp3", "Song-Part - Live", "Singer-One&Another-Artist"]
  ];
  for (const [filename] of cases) await writeFile(path.join(root, "music", filename), "fixture");
  const tracks = await generatePlaylist(root, { fetchMissing: false });
  assert.equal(tracks.length, cases.length);
  for (const [filename, name, artist] of cases) {
    const track = tracks.find(function (entry) { return entry.url === musicURL(filename); });
    assert.ok(track);
    assert.equal(track.name, name);
    assert.equal(track.artist, artist);
    for (const endpoint of [LYRICS_API, COVER_API]) {
      const query = new URL(assetRequestURL(endpoint, track)).searchParams;
      assert.equal(query.get("title"), name);
      assert.equal(query.get("artist"), artist);
    }
  }
});

test("generator scans nested music, pairs optional assets and encodes exact OSS filenames", async function (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "parrymusic-test-"));
  t.after(function () { return rm(root, { recursive: true, force: true }); });
  const music = path.join(root, "music");
  await mkdir(path.join(music, "专辑 #1"), { recursive: true });
  await mkdir(path.join(music, ".hidden"));
  const files = [
    "歌手 - 音乐 #100%?.MP3", "歌手 - 音乐 #100%?.JPG", "歌手 - 音乐 #100%?.LRC",
    "没有歌手.wav", "cover.webp", "不是音频.txt",
    "专辑 #1/歌手 - 另一首.flac", "专辑 #1/cover.png",
    ".hidden/hidden.mp3", ".hidden.mp3"
  ];
  await Promise.all(files.map(function (file) { return writeFile(path.join(music, file), "fixture"); }));
  await symlink(path.join(music, "没有歌手.wav"), path.join(music, "链接.mp3"));
  const tracks = await collectTracks(music);
  assert.equal(tracks.length, 3);
  const song = tracks.find(function (track) { return track.name === "音乐 #100%?"; });
  assert.equal(song.artist, "歌手");
  assert.equal(song.url, musicURL("歌手 - 音乐 #100%?.MP3"));
  assert.match(song.url, /%23/);
  assert.match(song.url, /%25/);
  assert.match(song.url, /%3F/);
  assert.equal(song.cover, musicURL("歌手 - 音乐 #100%?.JPG"));
  assert.equal(song.lrc, musicURL("歌手 - 音乐 #100%?.LRC"));
  const nested = tracks.find(function (track) { return track.name === "另一首"; });
  assert.equal(nested.cover, musicURL(path.join("专辑 #1", "cover.png")));
  assert.equal("lrc" in nested, false);
  const unknown = tracks.find(function (track) { return track.name === "没有歌手"; });
  assert.equal(unknown.artist, "未知歌手");
  assert.equal(unknown.cover, "./music/cover.webp");
  const generated = await generatePlaylist(root, { fetchMissing: false });
  assert.ok(generated.every(track => /^[0-9a-f]{12}$/.test(track.id)));
  const source = await readFile(path.join(music, "playlist.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.PARRY_MUSIC_PLAYLIST)), generated);
  assert.deepEqual(generated.map(({ id, ...track }) => track), tracks);
  await generatePlaylist(root, { fetchMissing: false });
  assert.equal(await readFile(path.join(music, "playlist.js"), "utf8"), source);
});

test("empty directory produces a valid empty playlist", async function (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "parrymusic-empty-"));
  t.after(function () { return rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await generatePlaylist(root), []);
  assert.match(await readFile(path.join(root, "music", "playlist.js"), "utf8"), /window\.PARRY_MUSIC_PLAYLIST = \[\];/);
});

test("IDs live only on playlist entries and survive reordering, new songs and metadata updates", async function (t) {
  const root = await musicFixture(t, ["Singer - A.mp3", "Singer - B.mp3"]);
  const options = { fetchMissing: false };
  const original = await generatePlaylist(root, options);
  assert.ok(original.every(track => /^[0-9a-f]{12}$/.test(track.id)));
  assert.notEqual(original[0].id, original[1].id);
  const destination = path.join(root, "music", "playlist.js");
  await writeFile(destination, serializePlaylist([original[1], original[0]]));
  await writeFile(path.join(root, "music", "Singer - 0.mp3"), "fixture");
  await writeFile(path.join(root, "music", "Singer - B.jpg"), "cover");
  const next = await generatePlaylist(root, options);
  assert.deepEqual(next.map(track => track.name), ["B", "A", "0"]);
  assert.equal(next[0].id, original[1].id);
  assert.equal(next[1].id, original[0].id);
  assert.equal(new Set(next.map(track => track.id)).size, next.length);
  assert.equal(next[0].cover, musicURL("Singer - B.jpg"));
  const source = await readFile(destination, "utf8");
  assert.deepEqual(await generatePlaylist(root, options), next);
  assert.equal(await readFile(destination, "utf8"), source);
  assert.deepEqual((await readdir(path.join(root, "music"))).sort(), ["Singer - 0.mp3", "Singer - A.mp3", "Singer - B.jpg", "Singer - B.mp3", "playlist.js"]);
});

test("random ID collisions are retried against existing IDs and other newly assigned IDs", function () {
  const previous = [{ url: musicURL("Singer - A.mp3"), id: "111111111111" }, { url: musicURL("Singer - Deleted.mp3"), id: "222222222222" }];
  const tracks = ["A", "B", "C"].map(name => ({ url: musicURL("Singer - " + name + ".mp3") }));
  const candidates = ["111111111111", "222222222222", "333333333333", "333333333333", "444444444444"];
  assignSongIds(tracks, previous, () => candidates.shift());
  assert.deepEqual(tracks.map(track => track.id), ["111111111111", "333333333333", "444444444444"]);
  assert.equal(candidates.length, 0);
  assert.throws(() => assignSongIds([{ url: musicURL("Singer - New.mp3") }], previous, () => "111111111111"), /连续冲突/);
});

test("conflicting existing IDs fail before downloading or overwriting the playlist", async function (t) {
  const root = await musicFixture(t, ["Singer - A.mp3", "Singer - B.mp3"]);
  const source = serializePlaylist(["A", "B"].map(name => ({ url: musicURL("Singer - " + name + ".mp3"), id: "abcdef123456" })));
  const destination = path.join(root, "music", "playlist.js");
  await writeFile(destination, source);
  await assert.rejects(generatePlaylist(root, { fetchImpl() { assert.fail("must fail before downloading"); } }), /ID 存在冲突/);
  assert.equal(await readFile(destination, "utf8"), source);
});

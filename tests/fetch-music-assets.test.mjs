import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePlaylist, musicURL, assetRequestURL, LYRICS_API, COVER_API } from "../scripts/generate-playlist.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS8sAAAAASUVORK5CYII=", "base64");
const LRC = "[00:00.00]A test line\n[00:05.50]Another test line\n";

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "parrymusic-api-"));
  t.after(function () { return rm(root, { recursive: true, force: true }); });
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(root, "music", relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return root;
}

test("missing assets are fetched with encoded metadata, saved beside audio and reused on reruns", async function (t) {
  const basename = "专辑 #1/歌手1（备注 - 1）&歌手2 +（备注 - 2） - 歌名 #100%?";
  const root = await fixture(t, { [basename + ".flac"]: "audio" });
  const requests = [];
  const fetchImpl = async function (address, options) {
    const url = new URL(address);
    requests.push(address);
    assert.equal(url.origin, "https://api.lrc.cx");
    assert.equal(url.searchParams.get("title"), "歌名 #100%?");
    assert.equal(url.searchParams.get("artist"), "歌手1&歌手2 +");
    assert.equal(url.searchParams.get("album"), "");
    assert.equal(url.searchParams.has("path"), false);
    assert.equal(options.redirect, "follow");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname === "/lyrics") return new Response(LRC, { headers: { "content-type": "text/html; charset=utf-8" } });
    assert.equal(url.pathname, "/cover");
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  };
  const tracks = await generatePlaylist(root, { fetchImpl: fetchImpl });
  assert.equal(requests.length, 2);
  assert.equal(tracks[0].name, "歌名 #100%?");
  assert.equal(tracks[0].artist, "歌手1&歌手2 +");
  assert.equal(tracks[0].lrc, musicURL(basename + ".lrc"));
  assert.equal(tracks[0].cover, musicURL(basename + ".png"));
  assert.equal(await readFile(path.join(root, "music", basename + ".lrc"), "utf8"), LRC);
  assert.deepEqual(await readFile(path.join(root, "music", basename + ".png")), PNG);
  const source = await readFile(path.join(root, "music", "playlist.js"), "utf8");
  assert.equal(source.includes("api.lrc.cx"), false);
  assert.deepEqual(await generatePlaylist(root, { fetchImpl: fetchImpl }), tracks);
  assert.equal(requests.length, 2);
});

test("local lyrics, matching covers and folder covers take priority over the API", async function (t) {
  const root = await fixture(t, {
    "歌手 - 本地.mp3": "audio", "歌手 - 本地.LRC": "original lyrics", "歌手 - 本地.JPG": "original cover",
    "专辑/歌手 - 共享封面.mp3": "audio", "专辑/cover.webp": "album cover"
  });
  const requests = [];
  const tracks = await generatePlaylist(root, {
    fetchImpl: async function (address) {
      requests.push(new URL(address));
      return new Response(LRC);
    }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, "/lyrics");
  assert.equal(requests[0].searchParams.get("title"), "共享封面");
  assert.equal(await readFile(path.join(root, "music", "歌手 - 本地.LRC"), "utf8"), "original lyrics");
  assert.equal(await readFile(path.join(root, "music", "歌手 - 本地.JPG"), "utf8"), "original cover");
  assert.equal(tracks.find(function (track) { return track.name === "共享封面"; }).cover, musicURL("专辑/cover.webp"));
});

test("multiple audio formats of one song share downloaded files without duplicate API calls", async function (t) {
  const root = await fixture(t, { "歌手 - 歌名.mp3": "audio", "歌手 - 歌名.flac": "audio" });
  let requests = 0;
  const tracks = await generatePlaylist(root, {
    fetchImpl: async function (address) {
      requests += 1;
      return new URL(address).pathname === "/lyrics" ? new Response(LRC) : new Response(PNG);
    }
  });
  assert.equal(requests, 2);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].lrc, tracks[1].lrc);
  assert.equal(tracks[0].cover, tracks[1].cover);
});

test("API 404 does not prevent a successful cover download or playlist generation", async function (t) {
  const root = await fixture(t, { "歌手 - 歌名.mp3": "audio" });
  const warnings = [];
  const tracks = await generatePlaylist(root, {
    warn: function (message) { warnings.push(message); },
    fetchImpl: async function (address) {
      return new URL(address).pathname === "/lyrics" ? new Response("Lyrics not found.", { status: 404 }) : new Response(PNG);
    }
  });
  assert.equal(tracks[0].lrc, undefined);
  assert.equal(tracks[0].cover, musicURL("歌手 - 歌名.png"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /没有找到匹配结果/);
  assert.match(await readFile(path.join(root, "music", "playlist.js"), "utf8"), /PARRY_MUSIC_PLAYLIST/);
});

test("HTML and unsynchronized lyrics are rejected rather than cached as valid assets", async function (t) {
  const root = await fixture(t, { "只有歌名.mp3": "audio" });
  const warnings = [];
  const tracks = await generatePlaylist(root, {
    warn: function (message) { warnings.push(message); },
    fetchImpl: async function (address) {
      const url = new URL(address);
      assert.equal(url.searchParams.get("artist"), "");
      const content = url.pathname === "/lyrics" ? "Plain lyrics without timestamps" : "<html>Service error</html>";
      return new Response(content, { headers: { "content-type": "image/jpeg" } });
    }
  });
  assert.equal(tracks[0].lrc, undefined);
  assert.equal(tracks[0].cover, undefined);
  assert.equal(warnings.length, 2);
  assert.deepEqual((await readdir(path.join(root, "music"))).sort(), ["playlist.js", "只有歌名.mp3"]);
});

test("timeouts release the request and still generate the playable audio entry", async function (t) {
  const root = await fixture(t, { "超时.mp3": "audio" });
  const warnings = [];
  const tracks = await generatePlaylist(root, {
    timeoutMs: 10,
    warn: function (message) { warnings.push(message); },
    fetchImpl: function (_, options) {
      return new Promise(function (_, reject) {
        options.signal.addEventListener("abort", function () { reject(new Error("abort")); }, { once: true });
      });
    }
  });
  assert.equal(tracks.length, 1);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(function (message) { return message.includes("请求超时"); }));
});

test("oversized responses are rejected without publishing downloaded files", async function (t) {
  const root = await fixture(t, { "过大.mp3": "audio" });
  const warnings = [];
  const tracks = await generatePlaylist(root, {
    warn: function (message) { warnings.push(message); },
    fetchImpl: async function () {
      return new Response("large", { headers: { "content-length": String(100 * 1024 * 1024) } });
    }
  });
  assert.equal(tracks[0].cover, undefined);
  assert.equal(tracks[0].lrc, undefined);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(function (message) { return message.includes("响应文件过大"); }));
});

test("a local file added while the request is running is never overwritten", async function (t) {
  const root = await fixture(t, { "歌手 - 竞态.mp3": "audio", "歌手 - 竞态.jpg": "local cover" });
  const warnings = [];
  await generatePlaylist(root, {
    warn: function (message) { warnings.push(message); },
    fetchImpl: async function () {
      await writeFile(path.join(root, "music", "歌手 - 竞态.lrc"), "locally added");
      return new Response(LRC);
    }
  });
  assert.equal(await readFile(path.join(root, "music", "歌手 - 竞态.lrc"), "utf8"), "locally added");
  assert.equal(warnings.length, 1);
  assert.equal((await readdir(path.join(root, "music"))).some(function (file) { return file.endsWith(".tmp"); }), false);
});

test("offline mode never calls the API and request metadata can include an album", async function (t) {
  const root = await fixture(t, { "离线.flac": "audio" });
  const tracks = await generatePlaylist(root, {
    fetchMissing: false,
    fetchImpl: function () { assert.fail("offline must not call fetch"); }
  });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].cover, undefined);
  const url = new URL(assetRequestURL(COVER_API, { name: "歌名", artist: "歌手", album: "专辑" }));
  assert.equal(url.searchParams.get("album"), "专辑");
  assert.equal(new URL(assetRequestURL(LYRICS_API, { name: "歌名", artist: "未知歌手" })).searchParams.get("artist"), "");
});

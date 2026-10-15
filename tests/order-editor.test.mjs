import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createOrderEditorServer } from "../scripts/order-editor.mjs";
import { readPlaylist, serializePlaylist, generatePlaylist, musicURL } from "../scripts/generate-playlist.mjs";
import core from "../js/player-core.js";

const songs = [
  { id: "111111111111", name: "One", artist: "Singer", url: musicURL("Singer - One.mp3"), cover: "./music/one.jpg", lrc: "./music/one.lrc", album: "Album", extra: { keep: true } },
  { id: "222222222222", name: "Two", artist: "Singer&Other", url: musicURL("Singer&Other - Two.mp3"), cover: "./music/two.jpg" },
  { name: "Three", artist: "Singer", url: musicURL("Singer - Three.flac") }
];

async function fixture(t, tracks = songs, host = "127.0.0.1") {
  const root = await mkdtemp(path.join(os.tmpdir(), "parrymusic-editor-"));
  const music = path.join(root, "music");
  await mkdir(music);
  const playlist = path.join(music, "playlist.js");
  const original = "// Original comment retained in backup\n" + serializePlaylist(tracks);
  await writeFile(playlist, original);
  const server = createOrderEditorServer(root);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const snapshot = await (await fetch(base + "/api/playlist")).json();
  const save = (payload, headers = {}) => fetch(base + "/api/order", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Order-Token": snapshot.token, ...headers },
    body: JSON.stringify(payload)
  });
  return { root, music, playlist, original, base, snapshot, save, address: server.address() };
}

test("sorting preserves every track field, creates an exact backup and remains compatible with regeneration and sharing", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.snapshot.tracks, songs);
  const response = await f.save({ revision: f.snapshot.revision, order: [2, 0, 1] });
  assert.equal(response.status, 200);
  const data = await response.json();
  const expected = [songs[2], songs[0], songs[1]];
  assert.deepEqual(data.tracks, expected);
  assert.deepEqual(readPlaylist(await readFile(f.playlist, "utf8")), expected);
  assert.equal(await readFile(path.join(f.root, data.backup), "utf8"), f.original);
  assert.notEqual(data.revision, f.snapshot.revision);
  const normalized = core.normalizePlaylist(data.tracks, "https://music.example.com/", "").tracks;
  assert.equal(normalized.find(track => track.id === "111111111111").name, "One");
  for (const song of songs) await writeFile(path.join(f.music, decodeURIComponent(song.url.slice("./music/".length))), "audio");
  const generated = await generatePlaylist(f.root, { fetchMissing: false });
  assert.deepEqual(generated.map(track => track.name), ["Three", "One", "Two"]);
  assert.equal(generated[1].id, songs[0].id);
  assert.equal(generated[2].id, songs[1].id);
});

test("external file changes refuse a stale save without changing the file or creating a backup", async t => {
  const f = await fixture(t);
  const changed = serializePlaylist([...songs].reverse());
  await writeFile(f.playlist, changed);
  const response = await f.save({ revision: f.snapshot.revision, order: [2, 0, 1] });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /其他程序修改/);
  assert.equal(await readFile(f.playlist, "utf8"), changed);
  assert.deepEqual(await readdir(f.music), ["playlist.js"]);
});

test("concurrent saves with the same revision allow only one change", async t => {
  const f = await fixture(t);
  const responses = await Promise.all([[2, 0, 1], [1, 2, 0]].map(order => f.save({ revision: f.snapshot.revision, order })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = await responses.find(response => response.status === 200).json();
  assert.deepEqual(readPlaylist(await readFile(f.playlist, "utf8")), winner.tracks);
  assert.equal((await readdir(path.join(f.music, ".playlist-backups"))).length, 1);
});

test("invalid orders cannot add, remove or duplicate songs, and unchanged orders leave the file intact", async t => {
  const f = await fixture(t);
  for (const order of [[0, 0, 2], [0, 1], [0, 1, 3], [0, 1, -1], [0, 1, 1.5], ["0", 1, 2]]) {
    const response = await f.save({ revision: f.snapshot.revision, order });
    assert.equal(response.status, 400);
    assert.equal(await readFile(f.playlist, "utf8"), f.original);
  }
  const response = await f.save({ revision: f.snapshot.revision, order: [0, 1, 2], tracks: [] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).backup, null);
  assert.equal(await readFile(f.playlist, "utf8"), f.original);
  assert.deepEqual(await readdir(f.music), ["playlist.js"]);
});

test("backup failures leave the original playlist untouched", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.music, ".playlist-backups"), "not a directory");
  const response = await f.save({ revision: f.snapshot.revision, order: [2, 0, 1] });
  assert.equal(response.status, 500);
  assert.equal(await readFile(f.playlist, "utf8"), f.original);
  assert.equal((await readdir(f.music)).some(name => name.endsWith(".tmp")), false);
});

test("missing or invalid playlists report errors without executing JavaScript", async t => {
  const f = await fixture(t);
  const invalid = "window.PARRY_MUSIC_PLAYLIST = (() => { while (true) {} })();";
  await writeFile(f.playlist, invalid);
  const response = await fetch(f.base + "/api/playlist");
  assert.equal(response.status, 400);
  assert.equal(await readFile(f.playlist, "utf8"), invalid);
  await rm(f.playlist);
  assert.equal((await fetch(f.base + "/api/playlist")).status, 404);
});

test("empty playlists and fixed editor assets load without exposing other project files", async t => {
  const f = await fixture(t, []);
  assert.deepEqual(f.snapshot.tracks, []);
  assert.equal((await f.save({ revision: f.snapshot.revision, order: [] })).status, 200);
  for (const [url, type] of [["/", "text/html"], ["/editor.css", "text/css"], ["/editor.mjs", "text/javascript"], ["/brand.webp", "image/webp"], ["/favicon-circle.png", "image/png"]]) {
    const response = await fetch(f.base + url);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith(type));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(f.base + "/music/playlist.js")).status, 404);
  assert.equal((await fetch(f.base + "/upload-oss.sh")).status, 404);
});

test("saving requires the session token and matching origin", async t => {
  const f = await fixture(t);
  const payload = { revision: f.snapshot.revision, order: [2, 0, 1] };
  assert.equal((await f.save(payload, { "X-Order-Token": "wrong" })).status, 403);
  assert.equal((await f.save(payload, { Origin: "https://other.example" })).status, 403);
  assert.equal((await f.save(payload, { "Content-Type": "text/plain" })).status, 415);
  assert.equal(await readFile(f.playlist, "utf8"), f.original);
});

function remoteRequest(base, route, method, host, origin, token, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : "";
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (token) headers["X-Order-Token"] = token;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const request = http.request(base + route, { method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("external IP and domain hosts can read and save, including an HTTPS proxy", async t => {
  const f = await fixture(t, songs, "0.0.0.0");
  assert.equal(f.address.address, "0.0.0.0");
  let order = [2, 0, 1];
  for (const [host, origin] of [
    ["192.0.2.10:8081", "http://192.0.2.10:8081"],
    ["editor.example", "https://editor.example"]
  ]) {
    const snapshot = await remoteRequest(f.base, "/api/playlist", "GET", host);
    assert.equal(snapshot.status, 200);
    const response = await remoteRequest(f.base, "/api/order", "POST", host, origin, snapshot.data.token,
      { revision: snapshot.data.revision, order });
    assert.equal(response.status, 200);
    assert.deepEqual(readPlaylist(await readFile(f.playlist, "utf8")), response.data.tracks);
    order = [1, 2, 0];
  }
  const ip = Object.values(os.networkInterfaces()).flat().find(address => address && !address.internal && address.family === "IPv4");
  if (ip) assert.equal((await fetch("http://" + ip.address + ":" + f.address.port + "/api/playlist")).status, 200);
});

test("external access still rejects cross-origin saves and malformed origins", async t => {
  const f = await fixture(t);
  const payload = { revision: f.snapshot.revision, order: [2, 0, 1] };
  for (const origin of ["https://other.example", "null", "https://editor.example/path", "http://editor.example:9999"]) {
    const response = await remoteRequest(f.base, "/api/order", "POST", "editor.example", origin, f.snapshot.token, payload);
    assert.equal(response.status, 403);
  }
  assert.equal(await readFile(f.playlist, "utf8"), f.original);
});

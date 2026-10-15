#!/usr/bin/env node
// Run locally before uploading. This script is never executed by OSS.
import { readdir, readFile, writeFile, rename, mkdir, rm, link } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import playerCore from "../js/player-core.js";

export const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac", ".webm"]);
const COVER_EXTENSIONS = [".webp", ".jpg", ".jpeg", ".png", ".avif", ".gif"];
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const LYRICS_API = "https://api.lrc.cx/lyrics";
export const COVER_API = "https://api.lrc.cx/cover";
const REQUEST_TIMEOUT = 45000;
const MAX_LYRICS_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 10 * 1024 * 1024;

export function assetRequestURL(endpoint, track) {
  const url = new URL(endpoint);
  url.searchParams.set("title", track.name);
  url.searchParams.set("artist", track.artist === "未知歌手" ? "" : track.artist);
  url.searchParams.set("album", track.album || "");
  // No local path or audio file is sent to the public service.
  return url.href;
}

async function responseBytes(response, maximum) {
  const length = Number(response.headers.get("content-length"));
  if (length > maximum) throw new Error("响应文件过大");
  if (!response.body) throw new Error("接口返回了空内容");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) throw new Error("响应文件过大");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(function () {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error("接口返回了空内容");
  return Buffer.concat(chunks, total);
}

export function coverExtension(bytes) {
  // Inspect the actual file signature, not the redirect URL or just its MIME.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return ".gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp") {
    for (let position = 8; position + 4 <= Math.min(bytes.length, 64); position += 4) {
      if (["avif", "avis"].includes(bytes.toString("ascii", position, position + 4))) return ".avif";
    }
  }
  throw new Error("接口没有返回支持的封面图片");
}

async function downloadAsset(kind, track, options) {
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, options.timeoutMs);
  try {
    const endpoint = kind === "lrc" ? LYRICS_API : COVER_API;
    const response = await options.fetchImpl(assetRequestURL(endpoint, track), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: kind === "lrc" ? "text/plain, text/html;q=0.9" : "image/*",
        "User-Agent": "ParryMusic-playlist-generator"
      }
    });
    if (!response.ok) throw new Error(response.status === 404 ? "没有找到匹配结果" : "接口返回 HTTP " + response.status);
    const bytes = await responseBytes(response, kind === "lrc" ? MAX_LYRICS_BYTES : MAX_COVER_BYTES);
    if (kind === "cover") return { extension: coverExtension(bytes), data: bytes };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").trim();
    // The lyrics endpoint uses text/html even for LRC, so validate timestamps.
    if (/^\s*</.test(text) || !playerCore.parseLrc(text).length) throw new Error("接口没有返回带时间戳的 LRC 歌词");
    return { extension: ".lrc", data: text + "\n" };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时（" + options.timeoutMs / 1000 + " 秒）");
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function saveAsset(destination, data) {
  // Publish a complete file without overwriting a concurrently added local file.
  const temporary = path.join(path.dirname(destination), "." + path.basename(destination) + "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await link(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function localAssets(files, stem) {
  const findFile = function (name) { return files.get(name.toLocaleLowerCase()); };
  return {
    cover: COVER_EXTENSIONS.map(function (extension) { return findFile(stem + extension); }).find(Boolean) ||
      COVER_EXTENSIONS.map(function (extension) { return findFile("cover" + extension); }).find(Boolean),
    lrc: findFile(stem + ".lrc")
  };
}

export async function fetchMissingAssets(tracks, musicDirectory, options = {}) {
  const settings = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT,
    log: options.log || function () {},
    warn: options.warn || function () {}
  };
  if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) throw new Error("请求超时必须是正数");
  const directories = new Map();
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track.cover && track.lrc) continue;
    const relative = decodeURIComponent(track.url.slice("./music/".length)).split("/").join(path.sep);
    const relativeDirectory = path.dirname(relative);
    const directory = path.join(musicDirectory, relativeDirectory);
    const filename = path.basename(relative);
    const stem = filename.slice(0, -path.extname(filename).length);
    if (!directories.has(directory)) {
      const entries = await readdir(directory, { withFileTypes: true });
      directories.set(directory, new Map(entries.filter(function (entry) { return entry.isFile(); }).map(function (entry) {
        return [entry.name.toLocaleLowerCase(), entry.name];
      })));
    }
    const files = directories.get(directory);
    // Reuse resources downloaded for another format of the same song.
    const existing = localAssets(files, stem);
    for (const kind of ["lrc", "cover"]) {
      if (!track[kind] && existing[kind]) track[kind] = musicURL(path.join(relativeDirectory, existing[kind]));
    }
    const missing = ["lrc", "cover"].filter(function (kind) { return !track[kind]; });
    if (!missing.length) continue;
    settings.log("[" + (index + 1) + "/" + tracks.length + "] 补全资源：" + track.artist + " - " + track.name);
    // At most two requests are active; songs are processed one at a time.
    await Promise.all(missing.map(async function (kind) {
      const label = kind === "lrc" ? "歌词" : "封面";
      try {
        const asset = await downloadAsset(kind, track, settings);
        const basename = stem + asset.extension;
        await saveAsset(path.join(directory, basename), asset.data);
        files.set(basename.toLocaleLowerCase(), basename);
        track[kind] = musicURL(path.join(relativeDirectory, basename));
        settings.log("  已保存" + label + "：" + path.join(relativeDirectory, basename));
      } catch (error) {
        settings.warn("  " + track.name + "：" + label + "补全失败（" + error.message + "），继续生成歌单。");
      }
    }));
  }
  return tracks;
}

export function musicURL(relativePath) {
  const encoded = relativePath.split(path.sep).map(function (part) {
    return encodeURIComponent(part).replace(/[!'()*]/g, function (character) {
      return "%" + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }).join("/");
  return "./music/" + encoded;
}

function songMetadata(filename) {
  return playerCore.songMetadata(filename);
}

export async function collectTracks(musicDirectory) {
  const tracks = [];
  async function walk(relativeDirectory) {
    const entries = await readdir(path.join(musicDirectory, relativeDirectory), { withFileTypes: true });
    entries.sort(function (a, b) { return a.name.localeCompare(b.name, "zh-CN", { numeric: true }); });
    const files = new Map(entries.filter(function (entry) { return entry.isFile(); }).map(function (entry) {
      return [entry.name.toLocaleLowerCase(), entry.name];
    }));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      // Do not follow symlinks: uploads must contain actual files inside music/.
      if (!entry.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stem = entry.name.slice(0, -path.extname(entry.name).length);
      const track = { ...songMetadata(entry.name), url: musicURL(relative) };
      const assets = localAssets(files, stem);
      const cover = assets.cover;
      if (cover) track.cover = musicURL(path.join(relativeDirectory, cover));
      const lrc = assets.lrc;
      if (lrc) track.lrc = musicURL(path.join(relativeDirectory, lrc));
      tracks.push(track);
    }
  }
  await walk("");
  return tracks;
}

export function serializePlaylist(tracks) {
  // Escape line separators so the generated JS also parses in older browsers.
  const json = JSON.stringify(tracks, null, 2).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return "window.PARRY_MUSIC_PLAYLIST = " + json + ";\n";
}

export function readPlaylist(source) {
  // Read the generated data without executing JavaScript from the playlist.
  const assignment = /^\s*(?:(?:\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)\s*)*window\.PARRY_MUSIC_PLAYLIST\s*=\s*/.exec(source);
  let previous;
  try {
    if (!assignment) throw new Error("找不到歌单数组");
    previous = JSON.parse(source.slice(assignment[0].length).trim().replace(/;$/, ""));
    if (!Array.isArray(previous)) throw new Error("歌单必须是数组");
  } catch (error) {
    throw new Error("无法读取 music/playlist.js 的歌曲顺序，原文件未修改；请保留生成文件的 JSON 数组格式。" + error.message);
  }
  return previous;
}

function songPath(value) {
  const url = playerCore.assetURL(value, "https://parrymusic.invalid/");
  try { return url ? decodeURIComponent(new URL(url).pathname) : ""; } catch { return ""; }
}

function preservePlaylistOrder(tracks, previous) {
  const remaining = new Map(tracks.map(function (track) { return [songPath(track.url), track]; }));
  const ordered = [];
  for (const entry of previous) {
    const key = songPath(entry && entry.url);
    if (!remaining.has(key)) continue;
    ordered.push(remaining.get(key));
    remaining.delete(key);
  }
  return ordered.concat(Array.from(remaining.values()));
}

export function assignSongIds(tracks, previous, createId = function () { return randomBytes(6).toString("hex"); }) {
  const ids = new Map();
  const used = new Set();
  // Reuse the IDs stored on the existing playlist entries.
  for (const entry of previous) {
    const key = songPath(entry && entry.url);
    if (!key.startsWith("/music/") || !entry || typeof entry.id !== "string" || !/^[0-9a-f]{12}$/.test(entry.id) || ids.has(key)) continue;
    if (used.has(entry.id)) throw new Error("现有歌单的歌曲 ID 存在冲突，原歌单未修改。");
    ids.set(key, entry.id);
    used.add(entry.id);
  }
  for (const track of tracks) {
    const key = songPath(track.url);
    if (!ids.has(key)) {
      let id;
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        id = createId();
        if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) throw new Error("无法生成有效的歌曲 ID。");
        if (!used.has(id)) break;
      }
      if (used.has(id)) throw new Error("歌曲 ID 连续冲突，原歌单未修改，请重新运行。");
      ids.set(key, id);
      used.add(id);
    }
    track.id = ids.get(key);
  }
}

async function publishFile(destination, content) {
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function generatePlaylist(root = projectRoot, options = {}) {
  const musicDirectory = path.join(root, "music");
  await mkdir(musicDirectory, { recursive: true });
  const destination = path.join(musicDirectory, "playlist.js");
  let previous = "";
  try { previous = await readFile(destination, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const previousTracks = previous.trim() ? readPlaylist(previous) : [];
  const tracks = preservePlaylistOrder(await collectTracks(musicDirectory), previousTracks);
  assignSongIds(tracks, previousTracks);
  if (options.fetchMissing !== false) await fetchMissingAssets(tracks, musicDirectory, options);
  const content = serializePlaylist(tracks);
  if (previous !== content) await publishFile(destination, content);
  return tracks;
}

const runningAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (runningAsScript) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("用法：node scripts/generate-playlist.mjs [--offline]\n扫描 music/（含子目录），从 LrcApi 下载缺失的歌词和封面，生成 music/playlist.js。\n命名：歌手 - 歌名.mp3；分隔符两侧需有空格，多个歌手用 & 分隔。\n--offline：仅使用本地资源，不调用 API。无需安装 npm 依赖。");
  } else {
    try {
      const flags = process.argv.slice(2);
      if (flags.some(function (flag) { return flag !== "--offline"; })) throw new Error("未知参数，请使用 --help 查看用法。");
      const tracks = await generatePlaylist(projectRoot, {
        fetchMissing: !flags.includes("--offline"),
        log: console.log,
        warn: console.warn
      });
      console.log("已生成 music/playlist.js，共 " + tracks.length + " 首歌曲。");
      if (!tracks.length) console.log("请先将音乐放入 music/，然后再次运行此命令。");
      console.log("上传 index.html、config.js、manifest.json、css/、js/、img/ 和 music/ 即可部署。");
    } catch (error) {
      console.error("生成歌单失败：" + error.message);
      process.exitCode = 1;
    }
  }
}

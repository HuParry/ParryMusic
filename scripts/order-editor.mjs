#!/usr/bin/env node
import http from "node:http";
import { readFile, writeFile, mkdir, rename, rm, lstat } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPlaylist, serializePlaylist } from "./generate-playlist.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const assetsRoot = fileURLToPath(new URL("./order-editor/", import.meta.url));
const revisionOf = source => createHash("sha256").update(source).digest("hex");

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createOrderEditorServer(root = projectRoot) {
  const playlistPath = path.join(path.resolve(root), "music", "playlist.js");
  const token = randomBytes(24).toString("hex");
  let saving = Promise.resolve();

  async function snapshot() {
    const info = await lstat(playlistPath);
    if (!info.isFile()) throw problem(400, "playlist.js 必须是普通文件。");
    const source = await readFile(playlistPath, "utf8");
    try { return { source, tracks: readPlaylist(source), revision: revisionOf(source), mode: info.mode & 0o777 }; }
    catch { throw problem(400, "无法读取歌单，请检查 playlist.js 是否保留生成文件的 JSON 数组格式。原文件未修改。"); }
  }

  async function save(payload) {
    if (!payload || typeof payload.revision !== "string" || !Array.isArray(payload.order)) throw problem(400, "保存请求无效。");
    const current = await snapshot();
    if (payload.revision !== current.revision) throw problem(409, "歌单已被其他程序修改，请重新读取后再调整。原文件未修改。");
    const order = payload.order;
    if (order.length !== current.tracks.length || new Set(order).size !== order.length ||
        order.some(index => !Number.isInteger(index) || index < 0 || index >= current.tracks.length)) {
      throw problem(400, "歌曲顺序不完整或存在重复，原文件未修改。");
    }
    if (order.every((index, position) => index === position)) return { tracks: current.tracks, revision: current.revision, backup: null };
    const tracks = order.map(index => current.tracks[index]);
    const content = serializePlaylist(tracks);
    const backupDirectory = path.join(path.dirname(playlistPath), ".playlist-backups");
    const name = "playlist-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID() + ".js";
    const temporary = playlistPath + "." + randomUUID() + ".tmp";
    await mkdir(backupDirectory, { recursive: true });
    // Save the exact original file, including any comments, before publishing.
    await writeFile(path.join(backupDirectory, name), current.source, { flag: "wx", mode: current.mode });
    try {
      await writeFile(temporary, content, { flag: "wx", mode: current.mode });
      if (revisionOf(await readFile(playlistPath, "utf8")) !== current.revision) {
        throw problem(409, "歌单已被其他程序修改，请重新读取后再调整。原文件未修改。");
      }
      await rename(temporary, playlistPath);
    } finally {
      await rm(temporary, { force: true });
    }
    return { tracks, revision: revisionOf(content), backup: "music/.playlist-backups/" + name };
  }

  const files = {
    "/": [path.join(assetsRoot, "index.html"), "text/html; charset=utf-8"],
    "/editor.css": [path.join(assetsRoot, "editor.css"), "text/css; charset=utf-8"],
    "/editor.mjs": [path.join(assetsRoot, "editor.mjs"), "text/javascript; charset=utf-8"],
    "/brand.webp": [fileURLToPath(new URL("../img/icon-r_mini.webp", import.meta.url)), "image/webp"],
    "/favicon-circle.png": [fileURLToPath(new URL("../img/favicon-circle.png", import.meta.url)), "image/png"]
  };
  const server = http.createServer(async (request, response) => {
    function send(status, value, type = "application/json; charset=utf-8") {
      response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(type.startsWith("application/json") ? JSON.stringify(value) : value);
    }
    try {
      let url;
      try {
        const base = new URL("http://" + request.headers.host);
        url = new URL(request.url, base);
        if (url.origin !== base.origin) throw new Error("无效地址");
      } catch { throw problem(400, "请求地址无效。"); }
      if (request.method === "GET" && url.pathname === "/api/playlist") {
        const current = await snapshot();
        return send(200, { tracks: current.tracks, revision: current.revision, token });
      }
      if (request.method === "POST" && url.pathname === "/api/order") {
        let sameOrigin = !request.headers.origin;
        if (request.headers.origin) {
          try {
            const origin = new URL(request.headers.origin);
            // Also support HTTPS reverse proxies that preserve the Host header.
            sameOrigin = ["http:", "https:"].includes(origin.protocol) && origin.host === url.host && origin.origin === request.headers.origin;
          } catch { sameOrigin = false; }
        }
        if (request.headers["x-order-token"] !== token || !sameOrigin) throw problem(403, "保存请求来源无效，请重新读取页面。");
        if (!(request.headers["content-type"] || "").startsWith("application/json")) throw problem(415, "保存请求必须使用 JSON。");
        let body = "";
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) throw problem(413, "歌曲顺序数据过大。");
          body += chunk.toString("utf8");
        }
        let payload;
        try { payload = JSON.parse(body); } catch { throw problem(400, "保存请求不是有效 JSON。"); }
        // Two browser tabs must not overwrite each other's saved order.
        const pending = saving.then(() => save(payload));
        saving = pending.catch(() => {});
        return send(200, await pending);
      }
      if (request.method === "GET" && files[url.pathname]) {
        const [filename, type] = files[url.pathname];
        return send(200, await readFile(filename), type);
      }
      throw problem(request.method === "GET" ? 404 : 405, "请求不存在或不支持。");
    } catch (error) {
      const missing = error.code === "ENOENT";
      send(error.status || (missing ? 404 : 500), { error: error.status ? error.message : missing ?
        "找不到 music/playlist.js，请先生成歌单。" : "保存或读取失败，请检查文件权限后重试。" });
    }
  });
  server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法：node scripts/order-editor.mjs [端口] [监听地址]\n默认监听 0.0.0.0:8081，允许外部访问。仅需本机访问时指定 127.0.0.1。读取并调整 music/playlist.js，不生成歌单或上传文件。");
  } else {
    const port = Number(args[0] || 8081);
    const host = args[1] || "0.0.0.0";
    if (args.length > 2 || !Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("端口必须是 1–65535 的整数。");
      process.exitCode = 1;
    } else {
      const server = createOrderEditorServer();
      server.on("error", error => { console.error("排序工具启动失败：" + error.message); process.exitCode = 1; });
      server.listen(port, host, () => {
        console.log("ParryMusic 歌单排序已启动，监听 " + host + ":" + port);
        if (["0.0.0.0", "::"].includes(host)) {
          console.log("本机访问：http://127.0.0.1:" + port + "/\n外部访问：http://服务器IP:" + port + "/（替换为实际 IP）");
        } else {
          const address = host.includes(":") ? "[" + host + "]" : host;
          console.log("访问地址：http://" + address + ":" + port + "/");
        }
        console.log("保存前会备份到 music/.playlist-backups/；Ctrl+C 停止服务。");
      });
    }
  }
}

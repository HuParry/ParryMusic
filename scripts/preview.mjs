import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.lrc': 'text/plain; charset=utf-8' };

export function createPreviewServer(root) {
  const base = path.resolve(root);
  const canonicalBase = realpath(base);
  return http.createServer(async (request, response) => {
    function fail(status) { response.writeHead(status); response.end(); }
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405);
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let filename = path.resolve(base, '.' + pathname);
      if (filename !== base && !filename.startsWith(base + path.sep)) return fail(403);
      let info = await stat(filename);
      if (info.isDirectory()) { filename = path.join(filename, 'index.html'); info = await stat(filename); }
      const resolved = await realpath(filename);
      if (!resolved.startsWith((await canonicalBase) + path.sep) || !info.isFile()) return fail(403);
      const headers = { 'Content-Type': types[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      let start = 0;
      let end = info.size - 1;
      let status = 200;
      // Ignore unsupported/malformed range syntax and serve the full file.
      const range = request.headers.range && /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (range && (range[1] || range[2]) && !request.headers['if-range'] && request.method === 'GET') {
        if (range[1]) {
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), end) : end;
        } else start = Math.max(0, info.size - Number(range[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
          response.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + info.size });
          return response.end();
        }
        status = 206;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + info.size;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      response.writeHead(status, headers);
      if (request.method === 'HEAD' || info.size === 0) return response.end();
      // pipeline closes the file stream when a seek cancels the old request.
      pipeline(createReadStream(filename, { start, end }), response, () => {});
    } catch (error) {
      if (!response.headersSent) fail(error instanceof URIError ? 400 : 404);
      else response.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8080);
  const host = process.argv[3] || '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const server = createPreviewServer(root);
  server.on('error', error => { console.error('预览启动失败：' + error.message); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log('ParryMusic 预览服务已启动，监听 ' + host + ':' + port + '（支持音频分段请求）');
    if (host === '0.0.0.0') {
      console.log('本机访问：http://localhost:' + port + '/');
      console.log('其他机器访问：http://服务器IP:' + port + '/（替换为实际 IP）');
    } else {
      const address = host.includes(':') ? '[' + host + ']' : host;
      console.log('访问地址：http://' + address + ':' + port + '/');
    }
  });
}

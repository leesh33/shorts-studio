/**
 * tools/serve.mjs — 로컬 미리보기 서버 (배포용이 아닙니다)
 *   node tools/serve.mjs  →  http://localhost:4310
 *   · 정적 파일(index.html, app.js, lib/engine.js …)을 그대로 서빙
 *   · /api/* 요청은 Vercel 함수와 같은 핸들러로 넘깁니다
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 4310;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.replace(/^\/api\//, '').replace(/\.js$/, '');
    try {
      const mod = await import(path.join(root, 'api', `${name}.js`));
      await mod.default(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'local-server', message: String(err?.message || err) }));
    }
    return;
  }
  const filePath = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!filePath.startsWith(root)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('not found');
  }
});

server.listen(port, () => {
  console.log(`shorts-studio local: http://localhost:${port}`);
});

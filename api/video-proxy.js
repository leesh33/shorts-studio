/**
 * api/video-proxy.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * GET /api/video-proxy?u=<https 원본 주소>
 *   · 스톡 영상 클립 바이트를 **같은 출처**로 흘려보냅니다.
 *     같은 출처여야 <video> 로 재생한 프레임을 9:16 캔버스에 drawImage 해도
 *     캔버스가 오염(tainted)되지 않고 MP4/WebM 녹화가 깨지지 않습니다.
 *   · Range 요청을 그대로 업스트림에 넘기고 206/Content-Range 를 그대로 돌려줍니다
 *     — <video> 탐색(seek)과 이어보기가 동작합니다.
 *   · 호스트 허용 목록(lib/stock-video.js ALLOWED_VIDEO_HOSTS) 밖의 주소는 403.
 *     리다이렉트를 따라간 뒤의 최종 주소도 다시 확인합니다(열린 프록시·SSRF 방지).
 *   · 성공을 꾸미지 않습니다 — 업스트림이 실패하면 그 상태 코드를 그대로 알립니다.
 */
import { Readable } from 'node:stream';
import { isAllowedVideoUrl, VIDEO_UA } from '../lib/stock-video.js';

const MAX_REDIRECTS = 3;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 허용 호스트로만 리다이렉트를 따라갑니다. */
async function fetchUpstream(target, headers, method) {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(url, { method, headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { res, url };
      const next = new URL(location, url).toString();
      if (!isAllowedVideoUrl(next)) return { blocked: next };
      url = next;
      continue;
    }
    return { res, url };
  }
  return { tooManyRedirects: true };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  let target = '';
  try {
    target = new URL(req.url, 'http://localhost').searchParams.get('u') || '';
  } catch {
    target = '';
  }
  if (!target) return send(res, 400, { ok: false, error: 'no-url' });
  if (!isAllowedVideoUrl(target)) return send(res, 403, { ok: false, error: 'blocked-host' });

  const range = String(req.headers?.range || '');
  const headers = {
    'User-Agent': VIDEO_UA,
    Accept: 'video/webm,video/mp4,video/*;q=0.9,image/*;q=0.8,*/*;q=0.5',
    ...(range ? { Range: range } : {}),
  };

  let upstream;
  let finalUrl;
  try {
    const out = await fetchUpstream(target, headers, req.method);
    if (out.blocked) return send(res, 403, { ok: false, error: 'blocked-redirect' });
    if (out.tooManyRedirects) return send(res, 502, { ok: false, error: 'too-many-redirects' });
    upstream = out.res;
    finalUrl = out.url;
  } catch (err) {
    return send(res, 502, {
      ok: false,
      error: 'upstream-failed',
      message: String(err?.message || err).slice(0, 160),
    });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return send(res, upstream.status || 502, { ok: false, error: `upstream-${upstream.status}` });
  }

  const type = String(upstream.headers.get('content-type') || '');
  // 영상 클립과 그 포스터(첫 프레임 jpg) 둘 다 이 프록시를 지나갑니다.
  if (!/^(video\/|image\/(jpeg|png|webp)|application\/octet-stream)/i.test(type)) {
    return send(res, 502, { ok: false, error: 'not-a-video', type: type.slice(0, 60) });
  }

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', type);
  // 영상은 한 번 받으면 다시 쓰는 편이 낫습니다 — 브라우저·CDN 캐시.
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
  res.setHeader('X-Video-Proxy-Host', new URL(finalUrl).hostname);
  for (const key of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }

  try {
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* 이미 닫혔습니다 */
      }
    });
    req.on('close', () => {
      try {
        stream.destroy();
      } catch {
        /* noop */
      }
    });
    stream.pipe(res);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'stream-failed', message: String(err?.message || err).slice(0, 160) }));
  }
}

/**
 * api/analyze-and-generate.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/analyze-and-generate
 *   body: { url, topic, tone?, length?, facts?, referenceText?, reference? }
 *   응답: { ok, analysis: { source, attempts, blueprint }, package }
 *
 * 하는 일
 *   ① 레퍼런스 쇼츠의 공개 메타데이터를 가져옵니다.
 *      - 유튜브 영상 페이지(제목·길이·설명글) → oEmbed(제목·채널·썸네일) → 실패해도 계속
 *      - YOUTUBE_API_KEY 가 있으면 Data API v3 로 한 번 더 보강
 *   ② 그 정보로 '레퍼런스 블루프린트'(훅 유형·리듬·컷 수·자막 스타일·템포)를 만듭니다.
 *   ③ 주제 한 줄로 새 쇼츠 패키지(6~8컷)를 만듭니다.
 *
 * 원칙
 *   · 어떤 업스트림이 실패해도 500으로 죽지 않습니다. 정보가 없으면 '추정'으로 표시합니다.
 *   · 키는 서버 환경변수에만 있고 응답에 담지 않습니다.
 *   · CORS 를 열지 않아 이 사이트에서만 호출됩니다.
 */
import { analyzeReference, generatePackage, parseYouTubeUrl } from '../lib/engine.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const FETCH_TIMEOUT_MS = 6500;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err?.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: String(err?.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 영상 페이지 HTML 에서 ytInitialPlayerResponse 안의 videoDetails 를 꺼냅니다. */
export function extractPlayerDetails(html) {
  if (!html) return null;
  const marker = 'ytInitialPlayerResponse';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const braceAt = html.indexOf('{', at);
  if (braceAt < 0) return null;
  // 문자열을 세면서 첫 번째 균형 잡힌 JSON 객체를 잘라냅니다.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceAt; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(braceAt, i + 1));
          const vd = parsed?.videoDetails || {};
          return {
            title: String(vd.title || ''),
            durationSec: Number(vd.lengthSeconds) || 0,
            description: String(vd.shortDescription || ''),
            keywords: Array.isArray(vd.keywords) ? vd.keywords : [],
            channel: String(vd.author || ''),
            thumbnail: String(vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || ''),
            isLive: Boolean(vd.isLiveContent),
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchReference(videoId, canonical) {
  const attempts = [];
  let meta = { title: '', channel: '', description: '', durationSec: 0, tags: [], thumbnail: '', fetchedBy: 'none' };

  const page = await getText(`https://www.youtube.com/shorts/${videoId}`);
  if (page.ok) {
    const details = extractPlayerDetails(page.text);
    if (details && details.title) {
      meta = {
        title: details.title,
        channel: details.channel,
        description: details.description,
        durationSec: details.durationSec,
        tags: details.keywords,
        thumbnail: details.thumbnail,
        fetchedBy: 'page',
      };
      attempts.push({ step: 'youtube-page', ok: true });
    } else {
      attempts.push({ step: 'youtube-page', ok: false, reason: 'no-player-response' });
    }
  } else {
    attempts.push({ step: 'youtube-page', ok: false, reason: page.status ? `http-${page.status}` : page.error || 'failed' });
  }

  if (!meta.title) {
    const oembed = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`);
    if (oembed.ok) {
      meta = {
        ...meta,
        title: String(oembed.data.title || ''),
        channel: String(oembed.data.author_name || ''),
        thumbnail: String(oembed.data.thumbnail_url || ''),
        fetchedBy: 'oembed',
      };
      attempts.push({ step: 'oembed', ok: true });
    } else {
      attempts.push({ step: 'oembed', ok: false, reason: oembed.status ? `http-${oembed.status}` : oembed.error || 'failed' });
    }
  }

  const key = process.env.YOUTUBE_API_KEY || process.env.EXPO_PUBLIC_YOUTUBE_API_KEY || '';
  if (key) {
    const api = await getJson(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet%2CcontentDetails&id=${videoId}&key=${encodeURIComponent(key)}`,
    );
    if (api.ok && api.data?.items?.[0]) {
      const item = api.data.items[0];
      const snippet = item.snippet || {};
      const iso = String(item.contentDetails?.duration || '');
      const m = iso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      const dur = m ? (Number(m[1] || 0) * 60) + Number(m[2] || 0) : meta.durationSec;
      meta = {
        ...meta,
        title: meta.title || String(snippet.title || ''),
        channel: meta.channel || String(snippet.channelTitle || ''),
        description: meta.description || String(snippet.description || ''),
        durationSec: meta.durationSec || dur,
        tags: meta.tags.length ? meta.tags : Array.isArray(snippet.tags) ? snippet.tags : [],
        thumbnail: meta.thumbnail || String(snippet.thumbnails?.high?.url || ''),
        fetchedBy: meta.fetchedBy === 'none' ? 'data-api' : meta.fetchedBy,
      };
      attempts.push({ step: 'youtube-data-api', ok: true });
    } else {
      attempts.push({ step: 'youtube-data-api', ok: false, reason: api.status ? `http-${api.status}` : 'no-items' });
    }
  } else {
    attempts.push({ step: 'youtube-data-api', ok: false, reason: 'no-key' });
  }

  return { meta, attempts };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 405, { ok: false, error: 'method-not-allowed' });

  let body = {};
  if (req.method === 'POST') {
    body = await readBody(req);
  } else if (req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    body = Object.fromEntries(q.entries());
  } else {
    return send(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  const url = String(body.url || '').trim();
  const topic = String(body.topic || '').trim();
  const parsed = parseYouTubeUrl(url);
  if (!parsed.ok) {
    return send(res, 400, {
      ok: false,
      error: parsed.error,
      message: '유튜브 쇼츠 주소를 확인해 주세요. (예: https://www.youtube.com/shorts/영상ID)',
    });
  }
  if (!topic) {
    return send(res, 400, { ok: false, error: 'no-topic', message: '만들 주제를 한 줄로 입력해 주세요.' });
  }

  // ① 레퍼런스 분석 (클라이언트가 이미 받아둔 blueprint 가 있으면 재사용)
  let blueprint = body.reference && typeof body.reference === 'object' ? body.reference : null;
  let analysis = { source: 'client-cache', attempts: [{ step: 'client-cache', ok: true }] };

  if (!blueprint || !blueprint.source) {
    const { meta, attempts } = await fetchReference(parsed.videoId, parsed.canonical);
    blueprint = analyzeReference({
      url: parsed.canonical,
      topic,
      title: meta.title,
      channel: meta.channel,
      description: meta.description,
      durationSec: meta.durationSec,
      tags: meta.tags,
      thumbnail: meta.thumbnail,
      referenceText: String(body.referenceText || '').slice(0, 4000),
      fetchedBy: meta.fetchedBy,
    });
    analysis = { source: meta.fetchedBy, attempts };
  }

  // ② 새 쇼츠 패키지
  let pkg;
  try {
    pkg = generatePackage({
      topic,
      tone: String(body.tone || 'auto'),
      length: Number(body.length) || 0,
      facts: String(body.facts || '').slice(0, 4000),
      blueprint,
    });
  } catch (err) {
    return send(res, 500, { ok: false, error: 'generate-failed', message: '생성 중 문제가 생겼습니다. 주제를 조금 바꿔 다시 시도해 주세요.' });
  }

  return send(res, 200, { ok: true, analysis: { ...analysis, blueprint }, package: pkg });
}

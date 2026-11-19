/**
 * api/find-video.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/find-video
 *   body: { photoKo?, photoEn?, videoEn?, videoKind?, keyword?, fallbackPhoto?, fallbackPhotoEn?, cutIndex?, exclude?[] }
 *   응답:  { ok: true, kind:'video', videoUrl:'/api/video-proxy?u=…', posterUrl?, provider, providerLabel,
 *           videoId, title, page, license, artist, duration, width, height, credit, query, relevance, attempts, ms }
 *         | { ok:false, error:'no-video'|'no-relevant-video', message, attempts }
 *           ← 화면이 실제 사진(켄번즈) → AI 로 폴백합니다. 무관한 클립은 일부러 돌려주지 않습니다.
 *
 * 순서 (lib/stock-video.js)
 *   ① PIXABAY_API_KEY 가 있으면 Pixabay Videos — **영어 검색어**로 묻고, 돌려받은 tags 와
 *      컷의 핵심 피사체가 겹치지 않으면 버립니다(무관한 횡단보도·요트 클립 차단).
 *   ② PEXELS_API_KEY 가 있으면 Pexels Videos (Pexels 는 신규 키 발급을 잠시 멈춰 두었습니다)
 *   ③ 위키미디어 커먼즈 영상(filetype:video, webm 트랜스코드) — 한국어 지명 검색이 됩니다.
 *   ④ 그래도 **주제에 맞는** 클립이 없으면 no-relevant-video — 컷은 '실제 사진(켄번즈) → 무료 AI' 로 채웁니다.
 *
 * · 영상 바이트는 응답에 담지 않습니다(수 MB). 같은 출처 프록시 주소만 돌려줍니다.
 * · 키 값은 쿼리/헤더로만 나가고 응답·로그에 담지 않습니다.
 *
 * GET /api/find-video → { ok, hasPixabayKey, hasPexelsKey, providers, relevance, mediaHosts }  (키 값은 절대 포함하지 않음)
 */
import { findStockVideo, videoCredit } from '../lib/stock-video.js';

const MAX_PROMPT_CHARS = 400;

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

function pexelsKey() {
  return String(process.env.PEXELS_API_KEY || process.env.PEXELS_KEY || '').trim();
}

function pixabayKey() {
  return String(process.env.PIXABAY_API_KEY || process.env.PIXABAY_KEY || '').trim();
}

/** 함수 한도(30초) 안에서 검색·확인을 끝냅니다. */
const SEARCH_BUDGET_MS = 20_000;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const hasPixabayKey = Boolean(pixabayKey());
    const hasPexelsKey = Boolean(pexelsKey());
    const providers = [...(hasPixabayKey ? ['pixabay'] : []), ...(hasPexelsKey ? ['pexels'] : []), 'wikimedia-commons'];
    return send(res, 200, {
      ok: true,
      hasPixabayKey,
      hasPexelsKey,
      providers,
      relevance: 'strict-tags-2',
      note: hasPixabayKey
        ? 'PIXABAY_API_KEY 가 설정되어 있어 Pixabay 스톡 영상을 1순위로 찾습니다. 없으면 위키미디어 커먼즈 영상으로 넘어갑니다.'
        : hasPexelsKey
          ? 'PEXELS_API_KEY 가 설정되어 있어 Pexels 스톡 영상을 1순위로 찾습니다. 없으면 위키미디어 커먼즈 영상으로 넘어갑니다.'
          : 'PIXABAY_API_KEY 가 없어 위키미디어 커먼즈 영상으로 찾습니다. 키를 넣으면 세로 HD 스톡 클립(Pixabay)이 1순위가 됩니다.',
      mediaHosts: ['cdn.pixabay.com', 'videos.pexels.com', 'upload.wikimedia.org', 'thumb.wikimedia.org'],
    });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' });

  const body = await readBody(req);
  const photoKo = String(body.photoKo || body.keyword || body.clipKo || '').slice(0, 60);
  const photoEn = String(body.photoEn || body.clipEn || '').slice(0, 80);
  // 영상 검색 전용 영어 시각어(2~3단어) — 사진 검색어와 다를 수 있습니다.
  const videoEn = String(body.videoEn || body.videoQuery || '').slice(0, 80);
  // Gemini 가 표식을 빼먹어도, 영상 검색어가 대상 이름 그대로면 랜드마크로 봅니다(무관한 클립 차단).
  const kindRaw = String(body.videoKind || body.clipKind || '').slice(0, 24);
  const videoKind =
    kindRaw || (videoEn && photoEn && videoEn.trim().toLowerCase() === photoEn.trim().toLowerCase() ? 'specific_landmark' : '');
  const fallback = String(body.fallbackPhoto || body.fallbackClip || body.topic || '').slice(0, MAX_PROMPT_CHARS);
  const fallbackEn = String(body.fallbackPhotoEn || '').slice(0, 80);
  const cutIndex = Math.max(0, Math.round(Number(body.cutIndex ?? String(body.cutId || '').replace(/\D/g, '')) || 0));
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.map((id) => String(id || '').slice(0, 160)).filter(Boolean).slice(0, 40)
    : [];

  const video = await findStockVideo({
    keywords: { ko: photoKo, en: photoEn, videoEn, fallback, fallbackEn, kind: videoKind },
    index: cutIndex,
    exclude,
    apiKey: pixabayKey(),
    pexelsKey: pexelsKey(),
    budgetMs: SEARCH_BUDGET_MS,
  });

  if (!video.ok) {
    return send(res, 404, {
      ok: false,
      error: video.reason === 'no-keyword' ? 'no-keyword' : video.reason === 'no-relevant-video' ? 'no-relevant-video' : 'no-video',
      message:
        video.reason === 'no-keyword'
          ? '이 컷에는 영상 검색어가 없습니다. 대본을 다시 생성하면 컷마다 검색어도 함께 만들어집니다.'
          : video.reason === 'no-relevant-video'
            ? '이 컷에 주제가 맞는 스톡 클립이 없습니다. 무관한 클립을 넣지 않고 실제 사진(줌·이동)으로 채웁니다.'
            : '이 컷에 맞는 움직이는 스톡 클립을 찾지 못했습니다. 실제 사진(켄번즈) 또는 AI 이미지로 채웁니다.',
      attempts: (video.attempts || []).slice(0, 8),
      ms: video.ms,
    });
  }

  return send(res, 200, {
    ok: true,
    kind: 'video',
    videoId: video.videoId,
    videoUrl: video.videoUrl,
    posterUrl: video.posterUrl,
    provider: video.provider,
    providerLabel: video.providerLabel,
    title: video.title,
    page: video.page,
    license: video.license,
    artist: video.artist,
    duration: video.duration,
    width: video.width,
    height: video.height,
    credit: videoCredit(video),
    query: video.query,
    videoKind: video.kind || '',
    relevance: video.relevance || 0,
    ms: video.ms,
    attempts: (video.attempts || []).slice(0, 8),
  });
}

/**
 * api/generate-image.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-image
 *   body: { prompt, aspectRatio?, style?, cutId?, photoKo?, photoEn?, keyword?, cutIndex?, exclude?[] , realPhoto? }
 *   응답:  { ok, kind:'photo'|'ai', image: "data:image/…;base64,…", mimeType, model, provider, seed, ms, cutId, credit? }
 *
 * 순서
 *   ⓪ style:'real'(📷 실제 사진) 이면 **실제 사진부터** 찾습니다.
 *      · 위키미디어 커먼즈 → 위키백과 문서 사진 (키·결제 없음, lib/real-photo.js)
 *      · 사진 바이트를 서버에서 받아 data URL 로 돌려줍니다(CORS 없음).
 *      · realPhoto:'only' 면 사진이 없을 때 AI 로 넘어가지 않고 실패를 그대로 알립니다(컷 토글용).
 *   ① GEMINI_API_KEY 가 있으면 Gemini 이미지 모델을 시도합니다
 *      (나중에 이 프로젝트에 빌링을 켜면 자동으로 Gemini 결과가 쓰입니다).
 *   ② Gemini 가 429(무료 등급 이미지 한도 0)·404·장애로 실패하면 **무료 경로로 자동 폴백**합니다.
 *      · Pollinations(IP당 45초 1장, 실측 5초·image/jpeg) → HF FLUX.1-schnell(실측 9초·image/webp)
 *      · 사진을 못 찾은 '실제 사진' 스타일도 이 경로로 폴백합니다(포토리얼 프롬프트로).
 *   ③ 바이트는 **서버에서** 받아 data URL 로 돌려줍니다 → 브라우저 캔버스가 오염되지 않아
 *      🎬 영상 파일 다운로드가 CORS 오류 없이 합성됩니다.
 *   ④ 성공을 꾸미지 않습니다 — 무료 업스트림이 모두 막히면 컷별로 정직한 오류(429 free-busy
 *      + retryAfterMs)를 돌려주고, 화면이 그 초만큼 쉬었다가 다시 시도합니다.
 * · 키는 `x-goog-api-key` 헤더로만 나가고 응답·로그에 담지 않습니다.
 * · 응답 본문 한도(4.5MB)를 넘지 않도록 base64 길이를 확인하고, 넘으면 413 으로 알립니다.
 *
 * GET /api/generate-image → { ok, hasGeminiKey, models, imagens, freeProviders }  (키 값은 절대 포함하지 않음)
 */
import { IMAGE_MODEL_FALLBACKS, IMAGEN_MODEL_FALLBACKS } from '../lib/gemini.js';
import { generateSceneImage } from '../lib/gemini-api.js';
import { FREE_PROVIDERS, generateFreeImage } from '../lib/free-image.js';
import { enhanceImagePrompt, aiFallbackPrompt, isPhotoStyle, normalizeStyle, styleCatalog } from '../lib/visual-style.js';
import { findRealPhoto, photoCredit } from '../lib/real-photo.js'

const MAX_PROMPT_CHARS = 1200;
/** 스타일 접미사를 붙인 뒤의 상한 — 모델이 읽는 길이를 관리합니다. */
const MAX_STYLED_PROMPT_CHARS = 1800;
/** Vercel 함수 응답 한도(4.5MB) 안 — base64 3.6M자 ≈ 원본 2.7MB */
const MAX_BASE64_CHARS = 3_600_000;
/** Gemini 는 '먼저 한 번'만 보고 빨리 무료 경로로 넘어갑니다(함수 60초 안에서 무료 경로 시간을 남김). */
const GEMINI_BUDGET_MS = 14_000;
/** 무료 경로에 주는 시간 — Gemini 시도 여부에 따라 다르게 */
const FREE_BUDGET_WITH_KEY_MS = 38_000;
const FREE_BUDGET_NO_KEY_MS = 48_000;

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

function geminiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '').trim();
}

function imageModels() {
  const preferred = String(process.env.GEMINI_IMAGE_MODEL || '').trim();
  const list = [];
  [preferred, ...IMAGE_MODEL_FALLBACKS].forEach((m) => {
    const name = String(m || '').trim();
    if (name && list.indexOf(name) < 0) list.push(name);
  });
  return list;
}

const PROVIDER_LABEL = {
  'pollinations-free': 'Pollinations 무료',
  'hf-flux-free': 'FLUX.1-schnell 무료',
  gemini: 'Gemini',
  'wikimedia-commons': '실제 사진 · 위키미디어 커먼즈',
  'wikipedia-ko': '실제 사진 · 위키백과',
  'wikipedia-en': '실제 사진 · Wikipedia (EN)',
};

/** 실제 사진과 AI 를 함께 시도할 때의 시간 배분 — 함수 한도 60초 안에서 */
const PHOTO_BUDGET_MS = 12_000;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      hasGeminiKey: Boolean(geminiKey()),
      aspectRatios: ['9:16', '1:1', '16:9'],
      visualStyles: styleCatalog(),
      photoSources: ['wikimedia-commons', 'wikipedia-ko', 'wikipedia-en'],
      models: imageModels(),
      imagens: IMAGEN_MODEL_FALLBACKS,
      freeProviders: FREE_PROVIDERS,
      note: 'GEMINI_API_KEY 는 서버 환경변수에만 있습니다. 이 응답에는 키 값이 담기지 않습니다. 무료 경로는 키 없이도 동작합니다.',
    });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' });

  const body = await readBody(req);
  const rawPrompt = String(body.prompt || '').replace(/\s+/g, ' ').trim();
  const aspectRatio = ['9:16', '1:1', '16:9'].includes(String(body.aspectRatio || '')) ? String(body.aspectRatio) : '9:16';
  const cutId = String(body.cutId || '').slice(0, 20);
  const visualStyle = normalizeStyle(body.style);
  const realPhotoMode = isPhotoStyle(visualStyle);
  const realPhoto = realPhotoMode ? String(body.realPhoto || 'first') : 'skip';
  const cutIndex = Math.max(0, Math.round(Number(body.cutIndex ?? String(cutId).replace(/\D/g, '')) || 0));
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.map((t) => String(t || '').slice(0, 160)).filter(Boolean).slice(0, 40)
    : [];
  const photoKo = String(body.photoKo || body.keyword || '').slice(0, 60);
  const photoEn = String(body.photoEn || '').slice(0, 80);

  if (rawPrompt.length < 8 && !realPhotoMode) {
    return send(res, 400, { ok: false, error: 'no-prompt', message: '이미지 프롬프트가 비어 있습니다.' });
  }
  if (rawPrompt.length > MAX_PROMPT_CHARS) {
    return send(res, 400, { ok: false, error: 'prompt-too-long', message: `프롬프트는 ${MAX_PROMPT_CHARS}자 이내로 보내주세요.` });
  }

  const attempts = [];

  /* ⓪ 실제 사진 먼저 — '롯데타워'를 AI 가 상상으로 그리던 문제를 해결합니다. */
  if (realPhotoMode && realPhoto !== 'skip') {
    const photo = await findRealPhoto({
      keywords: { ko: photoKo, en: photoEn, fallback: String(body.keyword || '') },
      index: cutIndex,
      exclude,
      budgetMs: PHOTO_BUDGET_MS,
    });
    (photo.attempts || []).forEach((a) => attempts.push({ provider: 'real-photo', step: a.source, query: a.query, status: a.ok ? 200 : 0, reason: a.reason }));
    if (photo.ok) {
      return send(res, 200, {
        ok: true,
        kind: 'photo',
        image: photo.dataUrl,
        mimeType: photo.mimeType,
        model: photo.provider,
        provider: photo.provider,
        providerLabel: photo.providerLabel || PROVIDER_LABEL[photo.provider] || '실제 사진',
        visualStyle,
        photo: {
          title: photo.title,
          page: photo.page,
          license: photo.license,
          artist: photo.artist,
          width: photo.width,
          height: photo.height,
          query: photo.query,
          credit: photoCredit(photo),
        },
        credit: photoCredit(photo),
        ms: photo.ms,
        cutId,
        attempts: attempts.slice(0, 8),
      });
    }
    if (realPhoto === 'only') {
      return send(res, 404, {
        ok: false,
        error: 'no-real-photo',
        message: '이 컷에 맞는 실제 사진을 커먼즈·위키백과에서 찾지 못했습니다. AI 이미지로 대신하거나 다른 검색어를 써 보세요.',
        attempts: attempts.slice(0, 8),
      });
    }
  }

  // AI 경로 프롬프트 — '실제 사진'의 AI 폴백은 포토리얼 언어로 다시 정리합니다.
  const prompt = (realPhotoMode
    ? aiFallbackPrompt(rawPrompt, visualStyle)
    : enhanceImagePrompt(rawPrompt, visualStyle)
  ).slice(0, MAX_STYLED_PROMPT_CHARS);

  const apiKey = geminiKey();
  let geminiNote = '';

  /* ① Gemini — 키가 있을 때만 먼저 시도 (빌링을 켜면 자동으로 이 결과가 쓰임) */
  if (apiKey) {
    try {
      const result = await generateSceneImage({
        apiKey,
        prompt,
        aspectRatio,
        models: imageModels(),
        timeoutMs: 12_000,
        budgetMs: realPhotoMode ? 8_000 : GEMINI_BUDGET_MS,
      });
      (result.attempts || []).forEach((a) => attempts.push({ provider: 'gemini', step: a.step, model: a.model, status: a.status, reason: a.reason }));
      if (result.ok && result.base64.length <= MAX_BASE64_CHARS) {
        return send(res, 200, {
          ok: true,
          kind: 'ai',
          image: `data:${result.mimeType};base64,${result.base64}`,
          mimeType: result.mimeType,
          model: result.model,
          provider: 'gemini',
          providerLabel: PROVIDER_LABEL.gemini,
          visualStyle,
          ms: result.ms,
          cutId,
          attempts: attempts.slice(0, 8),
        });
      }
      geminiNote = result.ok ? 'image-too-large' : result.reason || 'gemini-failed';
    } catch {
      geminiNote = 'gemini-crashed';
    }
  } else {
    geminiNote = 'no-key';
  }

  /* ② 무료 경로 — 키가 없거나 Gemini 가 막혔을 때 (이 앱의 기본 동작) */
  const free = await generateFreeImage({
    prompt,
    aspectRatio,
    budgetMs: apiKey ? (realPhotoMode ? 30_000 : FREE_BUDGET_WITH_KEY_MS) : FREE_BUDGET_NO_KEY_MS,
  });
  (free.attempts || []).forEach((a) => attempts.push({ provider: a.provider, status: a.status, reason: a.reason }));

  if (free.ok) {
    if (free.base64.length > MAX_BASE64_CHARS) {
      return send(res, 413, {
        ok: false,
        error: 'image-too-large',
        message: '이미지가 너무 커서 브라우저로 보낼 수 없습니다. 이 컷은 장면 그라데이션으로 유지합니다.',
        model: free.model,
      });
    }
    return send(res, 200, {
      ok: true,
      kind: 'ai',
      image: `data:${free.mimeType};base64,${free.base64}`,
      mimeType: free.mimeType,
      model: free.model,
      provider: free.provider,
      providerLabel: PROVIDER_LABEL[free.provider] || '무료 AI',
      visualStyle,
      seed: free.seed,
      free: true,
      geminiNote: realPhotoMode ? `사진 없음 → AI (${geminiNote || 'free'})` : geminiNote,
      ms: free.ms,
      cutId,
      attempts: attempts.slice(0, 8),
    });
  }

  if (free.reason === 'free-busy') {
    const waitSec = Math.round((free.retryAfterMs || 45_000) / 1000);
    return send(res, 429, {
      ok: false,
      error: 'free-busy',
      retryAfterMs: free.retryAfterMs || 45_000,
      message: `무료 AI 이미지 대기열이 잠시 꽉 찼습니다(익명 IP당 45초에 1장). 약 ${waitSec}초 뒤 자동으로 다시 시도합니다.`,
      attempts: attempts.slice(0, 8),
    });
  }

  return send(res, 502, {
    ok: false,
    error: 'image-failed',
    message: '무료 AI 이미지 경로가 지금은 응답하지 않았습니다. 잠시 뒤 🎨 버튼으로 다시 시도해 주세요.',
    attempts: attempts.slice(0, 8),
  });
}

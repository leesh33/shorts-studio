/**
 * api/generate-image.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-image
 *   body: { prompt, aspectRatio?: "9:16", cutId?: "cut-3" }
 *   응답:  { ok, image: "data:image/…;base64,…", mimeType, model, provider, seed, ms, cutId }
 *
 * 순서 (100% 무료 구성을 기본으로)
 *   ① GEMINI_API_KEY 가 있으면 Gemini 이미지 모델을 **먼저** 시도합니다
 *      (나중에 이 프로젝트에 빌링을 켜면 자동으로 Gemini 결과가 쓰입니다).
 *   ② Gemini 가 429(무료 등급 이미지 한도 0)·404·장애로 실패하면 **무료 경로로 자동 폴백**합니다.
 *      · Pollinations(IP당 45초 1장, 실측 5초·image/jpeg) → HF FLUX.1-schnell(실측 9초·image/webp)
 *      · 키가 아예 없어도 ①을 건너뛰고 바로 무료 경로로 갑니다 — 빌링 없이 동작합니다.
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

const MAX_PROMPT_CHARS = 1200;
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
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      hasGeminiKey: Boolean(geminiKey()),
      aspectRatios: ['9:16', '1:1', '16:9'],
      models: imageModels(),
      imagens: IMAGEN_MODEL_FALLBACKS,
      freeProviders: FREE_PROVIDERS,
      note: 'GEMINI_API_KEY 는 서버 환경변수에만 있습니다. 이 응답에는 키 값이 담기지 않습니다. 무료 경로는 키 없이도 동작합니다.',
    });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' });

  const body = await readBody(req);
  const prompt = String(body.prompt || '').replace(/\s+/g, ' ').trim();
  const aspectRatio = ['9:16', '1:1', '16:9'].includes(String(body.aspectRatio || '')) ? String(body.aspectRatio) : '9:16';
  const cutId = String(body.cutId || '').slice(0, 20);

  if (prompt.length < 8) {
    return send(res, 400, { ok: false, error: 'no-prompt', message: '이미지 프롬프트가 비어 있습니다.' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return send(res, 400, { ok: false, error: 'prompt-too-long', message: `프롬프트는 ${MAX_PROMPT_CHARS}자 이내로 보내주세요.` });
  }

  const apiKey = geminiKey();
  const attempts = [];
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
        budgetMs: GEMINI_BUDGET_MS,
      });
      (result.attempts || []).forEach((a) => attempts.push({ provider: 'gemini', step: a.step, model: a.model, status: a.status, reason: a.reason }));
      if (result.ok && result.base64.length <= MAX_BASE64_CHARS) {
        return send(res, 200, {
          ok: true,
          image: `data:${result.mimeType};base64,${result.base64}`,
          mimeType: result.mimeType,
          model: result.model,
          provider: 'gemini',
          providerLabel: PROVIDER_LABEL.gemini,
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
    budgetMs: apiKey ? FREE_BUDGET_WITH_KEY_MS : FREE_BUDGET_NO_KEY_MS,
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
      image: `data:${free.mimeType};base64,${free.base64}`,
      mimeType: free.mimeType,
      model: free.model,
      provider: free.provider,
      providerLabel: PROVIDER_LABEL[free.provider] || '무료 AI',
      seed: free.seed,
      free: true,
      geminiNote,
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

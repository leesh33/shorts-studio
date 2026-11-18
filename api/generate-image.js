/**
 * api/generate-image.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-image
 *   body: { prompt, aspectRatio?: "9:16", cutId?: "cut-3" }
 *   응답:  { ok, image: "data:image/png;base64,…", mimeType, model, ms, cutId }
 *
 * · GEMINI_API_KEY 가 없으면 **503 `gemini-not-configured`** — 화면은 안내 배너를 띄우고
 *   그라데이션 장면으로 계속 미리보기 합니다(조용히 실패하지 않습니다).
 * · 키는 `x-goog-api-key` 헤더로만 나가고 응답·로그에 담지 않습니다.
 * · 이미지 모델이 없으면(404/400) 다음 후보로, 마지막에 Imagen(:predict)까지 시도합니다.
 * · 응답 본문 한도(4.5MB)를 넘지 않도록 base64 길이를 확인하고, 넘으면 413 으로 알립니다.
 *
 * GET /api/generate-image → { ok, hasGeminiKey, models, imagens }  (키 값은 절대 포함하지 않음)
 */
import { IMAGE_MODEL_FALLBACKS, IMAGEN_MODEL_FALLBACKS } from '../lib/gemini.js';
import { generateSceneImage } from '../lib/gemini-api.js';

const MAX_PROMPT_CHARS = 1200;
/** Vercel 함수 응답 한도(4.5MB) 안 — base64 3.6M자 ≈ 원본 2.7MB */
const MAX_BASE64_CHARS = 3_600_000;

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

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      hasGeminiKey: Boolean(geminiKey()),
      aspectRatios: ['9:16', '1:1', '16:9'],
      models: imageModels(),
      imagens: IMAGEN_MODEL_FALLBACKS,
      note: 'GEMINI_API_KEY 는 서버 환경변수에만 있습니다. 이 응답에는 키 값이 담기지 않습니다.',
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
  if (!apiKey) {
    return send(res, 503, {
      ok: false,
      error: 'gemini-not-configured',
      message: 'GEMINI_API_KEY 가 Vercel 환경변수에 아직 없습니다. Project → Settings → Environment Variables 에 추가하고 재배포하면 컷 이미지가 생성됩니다.',
    });
  }

  try {
    const result = await generateSceneImage({ apiKey, prompt, aspectRatio, models: imageModels() });
    if (!result.ok) {
      const rateLimited = result.reason === 'rate-limited';
      return send(res, rateLimited ? 429 : 502, {
        ok: false,
        error: rateLimited ? 'rate-limited' : 'image-failed',
        message: rateLimited
          ? 'Gemini 이미지 생성 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요.'
          : '이미지를 만들지 못했습니다. 프롬프트를 조금 바꿔 다시 시도해 주세요.',
        attempts: (result.attempts || []).slice(0, 8).map((a) => ({ step: a.step, model: a.model, status: a.status, reason: a.reason })),
      });
    }

    if (result.base64.length > MAX_BASE64_CHARS) {
      return send(res, 413, {
        ok: false,
        error: 'image-too-large',
        message: '이미지가 너무 커서 브라우저로 보낼 수 없습니다. 이 컷은 그라데이션 장면으로 유지합니다.',
        model: result.model,
      });
    }

    return send(res, 200, {
      ok: true,
      image: `data:${result.mimeType};base64,${result.base64}`,
      mimeType: result.mimeType,
      model: result.model,
      ms: result.ms,
      cutId,
    });
  } catch (err) {
    return send(res, 500, { ok: false, error: 'image-crashed', message: '이미지 생성 중 문제가 생겼습니다.' });
  }
}

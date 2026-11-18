/**
 * lib/gemini-api.js — Gemini REST 호출 (서버 전용)
 * ─────────────────────────────────────────────────────────────
 * · 키는 `x-goog-api-key` 헤더로만 보냅니다(URL·Referer·로그에 남지 않게).
 * · 모델이 없으면(404/400) 다음 모델로, 영상 입력을 못 받으면 텍스트만으로 다시 시도합니다.
 * · 실패해도 **키·업스트림 본문**을 응답에 담지 않습니다. 상태 코드와 짧은 사유만 남깁니다.
 * · 시간 예산(budgetMs)을 넘으면 더 시도하지 않고 실패로 돌려줍니다 — Vercel 함수 시간 안에서 끝나야 합니다.
 */
import { GEMINI_ENDPOINT, IMAGE_MODEL_FALLBACKS, IMAGEN_MODEL_FALLBACKS, textFromGemini } from './gemini.js';

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

function errMessage(json) {
  try {
    return String(json?.error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** Gemini 1회 호출. 경로(suffix)는 'generateContent' 또는 'predict'. */
export async function callGemini({ apiKey, model, body, suffix = 'generateContent', timeoutMs = 20000, fetchImpl = DEFAULT_FETCH }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetchImpl(`${GEMINI_ENDPOINT}${encodeURIComponent(model)}:${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return {
      ok: Boolean(res.ok),
      status: Number(res.status) || 0,
      json,
      message: res.ok ? '' : errMessage(json),
      text: res.ok ? textFromGemini(json) : '',
      ms: Date.now() - started,
    };
  } catch (err) {
    const reason = String(err?.name === 'AbortError' ? 'timeout' : (err?.message || err)).slice(0, 120);
    return { ok: false, status: 0, json: null, message: reason, text: '', ms: Date.now() - started, aborted: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 모델 × 입력모드(video → text) 사다리.
 *   buildBody({ model, mode }) → 본문 또는 null(그 모드는 지원 안 함)
 */
export async function callGeminiLadder({
  apiKey,
  models,
  buildBody,
  modes = ['video', 'text'],
  timeoutMs = 18000,
  budgetMs = 26000,
  fetchImpl = DEFAULT_FETCH,
}) {
  const started = Date.now();
  const attempts = [];
  let usedMode = '';

  for (const model of models) {
    for (const mode of modes) {
      const body = buildBody({ model, mode });
      if (!body) continue;
      const remaining = budgetMs - (Date.now() - started);
      if (remaining < 2500) {
        attempts.push({ step: 'budget', model, status: 0, reason: 'time-budget' });
        return { ok: false, attempts, ms: Date.now() - started, reason: 'time-budget' };
      }
      const res = await callGemini({
        apiKey,
        model,
        body,
        timeoutMs: Math.min(timeoutMs, remaining),
        fetchImpl,
      });
      attempts.push({ step: mode === 'video' ? 'video' : 'text', model, status: res.status, reason: res.message || '' });
      if (res.ok && res.text) {
        return { ok: true, model, mode, json: res.json, text: res.text, attempts, ms: Date.now() - started, usedMode: mode };
      }
      if (res.aborted) {
        // 시간 초과 — 같은 모델의 다른 모드를 또 기다리면 예산이 사라집니다.
        usedMode = mode;
        continue;
      }
      if (res.status === 404) break; // 이 모델 자체가 없음 → 다음 모델
      if (res.status === 400) continue; // 입력/옵션 문제 → 같은 모델의 다음 모드(텍스트)로
      if (res.status === 429 || res.status === 500 || res.status === 503) continue; // 한도·업스트림 장애 → 다음 시도
    }
  }
  return { ok: false, attempts, ms: Date.now() - started, reason: attempts[attempts.length - 1]?.reason || 'gemini-failed' };
}

/** 응답에서 인라인 이미지를 꺼냅니다(데이터 URL). */
export function imageFromGemini(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    const inline = p?.inlineData || p?.inline_data;
    const data = inline?.data;
    if (typeof data === 'string' && data.length > 100) {
      return { base64: data, mimeType: String(inline.mimeType || inline.mime_type || 'image/png') };
    }
  }
  return null;
}

/** Imagen(:predict) 응답에서 이미지를 꺼냅니다. */
export function imageFromImagen(json) {
  const pred = json?.predictions?.[0];
  const data = pred?.bytesBase64Encoded || pred?.image?.bytesBase64Encoded;
  if (typeof data === 'string' && data.length > 100) {
    return { base64: data, mimeType: String(pred?.mimeType || 'image/png') };
  }
  return null;
}

/**
 * 9:16 장면 이미지 1장 생성.
 *   ① Gemini 이미지 모델(generateContent · responseModalities IMAGE)
 *   ② 안 되면 Imagen(predict)
 */
export async function generateSceneImage({
  apiKey,
  prompt,
  aspectRatio = '9:16',
  models = IMAGE_MODEL_FALLBACKS,
  imagenModels = IMAGEN_MODEL_FALLBACKS,
  timeoutMs = 30000,
  budgetMs = 45000,
  fetchImpl = DEFAULT_FETCH,
}) {
  const started = Date.now();
  const attempts = [];

  for (const model of models) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining < 4000) break;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio },
      },
    };
    const res = await callGemini({ apiKey, model, body, timeoutMs: Math.min(timeoutMs, remaining), fetchImpl });
    const found = res.ok ? imageFromGemini(res.json) : null;
    attempts.push({ step: 'image', model, status: res.status, reason: found ? '' : res.message || 'no-image' });
    if (found) return { ok: true, model, ...found, attempts, ms: Date.now() - started };
    if (res.status === 429 || res.status === 500 || res.status === 503) continue;
  }

  for (const model of imagenModels) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining < 4000) break;
    const body = { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio } };
    const res = await callGemini({ apiKey, model, body, suffix: 'predict', timeoutMs: Math.min(timeoutMs, remaining), fetchImpl });
    const found = res.ok ? imageFromImagen(res.json) : null;
    attempts.push({ step: 'imagen', model, status: res.status, reason: found ? '' : res.message || 'no-image' });
    if (found) return { ok: true, model, ...found, attempts, ms: Date.now() - started };
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    attempts,
    ms: Date.now() - started,
    reason: last?.status === 429 ? 'rate-limited' : last?.reason || 'image-failed',
  };
}

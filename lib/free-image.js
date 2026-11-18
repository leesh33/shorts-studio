/**
 * lib/free-image.js — 무료(키·빌링 없이) 이미지 생성 경로
 * ─────────────────────────────────────────────────────────────
 * Gemini 이미지 모델은 이 프로젝트(무료 등급)에서 할당량이 0이라 늘 429 입니다.
 * 그래서 **서버가 직접** 무료 업스트림에서 이미지 바이트를 받아 base64 로 돌려줍니다
 * (브라우저가 외부 URL 을 그리면 캔버스가 오염되어 영상 다운로드가 깨집니다).
 *
 * 검증한 무료 경로 (2026-11-19 curl 실측)
 *   ① Pollinations  GET https://image.pollinations.ai/prompt/{prompt}
 *      · 실측 성공: 200 · image/jpeg · 41KB · 5.2s (576×1024, 모델 x-model-used: sana)
 *      · 익명 한도: **IP당 45초에 1장** → 402 FREE_LIMIT + "Retry after Ns"
 *   ② Hugging Face Space FLUX.1-schnell  POST /gradio_api/call/infer
 *      · 실측 성공: 9s · image/webp · 68KB · 720×1280 (ZeroGPU 익명 쿼터가 남아 있을 때)
 *      · 쿼터가 비면 `event: error / data: null` 로 즉시 실패
 *
 * 원칙
 *   · 성공을 꾸미지 않습니다 — 이미지가 아니면(JSON·HTML) 실패로 돌려줍니다.
 *   · 실패 사유와 재시도 시점(retryAfterMs)을 그대로 알려 화면이 정직하게 안내합니다.
 *   · 네트워크는 fetchImpl 로 주입할 수 있게 해 테스트에서 실제로 나가지 않습니다.
 */

export const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/';
export const HF_FLUX_SPACE = 'black-forest-labs-flux-1-schnell.hf.space';

/** 무료 경로 후보 — 앞에서부터 시도합니다. */
export const FREE_PROVIDERS = ['pollinations-free', 'hf-flux-free'];

/** 익명 Pollinations 한도(IP당 1장/45초) — 402 응답에 초가 없을 때 쓰는 기본값 */
export const POLLINATIONS_WINDOW_MS = 45_000;

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

/** 화면 비율 → 픽셀 크기 (9:16 숏츠 기본) */
export function sizeFor(aspectRatio) {
  if (aspectRatio === '1:1') return { width: 1024, height: 1024 };
  if (aspectRatio === '16:9') return { width: 1280, height: 720 };
  return { width: 720, height: 1280 };
}

/** 같은 프롬프트 → 같은 시드(재시도해도 같은 장면, 캐시 적중 시 즉시 반환) */
export function seedForPrompt(prompt) {
  const s = String(prompt || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 1_000_000;
}

/** 앞 바이트로 실제 이미지인지 확인합니다(업스트림이 JSON 오류를 200 으로 줄 때 방어). */
export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return '';
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  return '';
}

function toBytes(buffer) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

/** 실패 결과의 공통 모양 */
function fail(provider, reason, extra = {}) {
  return { ok: false, provider, reason, ...extra };
}

/** 이미지 응답 → { base64, mimeType } (아니면 null) */
function imageFromResponse(res, bytes) {
  const contentLength = bytes.length;
  if (!res.ok) return null;
  if (contentLength < 2000) return null; // 아이콘·빈 응답은 장면이 아닙니다
  const mimeType = sniffImageMime(bytes) || String(res.headers?.get?.('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) return null;
  return { base64: Buffer.from(bytes).toString('base64'), mimeType, bytes: contentLength };
}

/* ───────────────────── ① Pollinations (무료) ───────────────────── */

export async function fetchPollinations({
  prompt,
  aspectRatio = '9:16',
  seed = seedForPrompt(prompt),
  timeoutMs = 25_000,
  fetchImpl = DEFAULT_FETCH,
}) {
  const { width, height } = sizeFor(aspectRatio);
  const started = Date.now();
  const qs = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: 'flux',
    nologo: 'true',
    seed: String(seed),
  });
  const url = `${POLLINATIONS_BASE}${encodeURIComponent(prompt)}?${qs.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(4000, timeoutMs));

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'image/*', 'User-Agent': 'shorts-studio/1.0 (free image fallback)' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const waitFromBody = Number((String(text).match(/retry after\s+(\d+)\s*s/i) || [])[1] || 0);
      const waitFromHeader = Number(res.headers?.get?.('retry-after') || 0);
      const retryAfterMs = (waitFromBody || waitFromHeader || POLLINATIONS_WINDOW_MS / 1000) * 1000;
      const limited = res.status === 402 || res.status === 429;
      return fail('pollinations-free', limited ? 'free-busy' : `http-${res.status}`, {
        status: res.status,
        retryAfterMs: limited ? Math.min(120_000, Math.max(5_000, retryAfterMs)) : 0,
        detail: String(text).slice(0, 160),
        ms: Date.now() - started,
      });
    }
    const bytes = toBytes(new Uint8Array(await res.arrayBuffer()));
    const found = imageFromResponse(res, bytes);
    if (!found) {
      return fail('pollinations-free', 'not-an-image', { status: res.status, ms: Date.now() - started });
    }
    return {
      ok: true,
      provider: 'pollinations-free',
      model: String(res.headers?.get?.('x-model-used') || 'flux'),
      ...found,
      seed,
      status: res.status,
      attempts: [],
      ms: Date.now() - started,
    };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : 'network';
    return fail('pollinations-free', reason, { status: 0, ms: Date.now() - started, detail: String(err?.message || err).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────── ② Hugging Face FLUX.1-schnell ─────────────────── */

export async function fetchHuggingFaceFlux({
  prompt,
  aspectRatio = '9:16',
  seed = seedForPrompt(prompt),
  timeoutMs = 26_000,
  fetchImpl = DEFAULT_FETCH,
}) {
  const { width, height } = sizeFor(aspectRatio);
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(4000, timeoutMs));

  try {
    const post = await fetchImpl(`https://${HF_FLUX_SPACE}/gradio_api/call/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [prompt, seed, false, width, height, 4] }),
      signal: ctrl.signal,
    });
    if (!post.ok) {
      return fail('hf-flux-free', `http-${post.status}`, { status: post.status, ms: Date.now() - started });
    }
    const { event_id: eventId } = await post.json().catch(() => ({}));
    if (!eventId) return fail('hf-flux-free', 'no-event-id', { status: post.status, ms: Date.now() - started });

    const stream = await fetchImpl(`https://${HF_FLUX_SPACE}/gradio_api/call/infer/${eventId}`, { signal: ctrl.signal });
    const text = await stream.text();
    const fileUrl = (String(text).match(/"url":\s*"([^"]+)"/) || [])[1];
    if (!fileUrl) {
      // ZeroGPU 익명 쿼터가 비면 `event: error` + `data: null`
      const reason = /event:\s*error/.test(text) ? 'gpu-quota' : 'no-image';
      return fail('hf-flux-free', reason, { status: stream.status, retryAfterMs: 0, ms: Date.now() - started });
    }

    const file = await fetchImpl(fileUrl, { signal: ctrl.signal });
    const bytes = toBytes(new Uint8Array(await file.arrayBuffer()));
    const found = imageFromResponse(file, bytes);
    if (!found) return fail('hf-flux-free', 'not-an-image', { status: file.status, ms: Date.now() - started });

    return {
      ok: true,
      provider: 'hf-flux-free',
      model: 'FLUX.1-schnell',
      ...found,
      seed,
      status: file.status,
      attempts: [],
      ms: Date.now() - started,
    };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : 'network';
    return fail('hf-flux-free', reason, { status: 0, ms: Date.now() - started, detail: String(err?.message || err).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }
}

const RUNNERS = {
  'pollinations-free': fetchPollinations,
  'hf-flux-free': fetchHuggingFaceFlux,
};

/**
 * 무료 사다리 — 앞 후보가 실패하면 다음 후보로, 예산을 넘으면 멈춥니다.
 *   성공: { ok:true, base64, mimeType, provider, model, seed, attempts, ms }
 *   실패: { ok:false, reason:'free-busy'|'free-failed', retryAfterMs, attempts, ms }
 */
export async function generateFreeImage({
  prompt,
  aspectRatio = '9:16',
  budgetMs = 34_000,
  providers = FREE_PROVIDERS,
  fetchImpl = DEFAULT_FETCH,
}) {
  const started = Date.now();
  const attempts = [];
  const seed = seedForPrompt(prompt);
  let busy = false;
  let retryAfterMs = 0;

  for (const provider of providers) {
    const runner = RUNNERS[provider];
    if (!runner) continue;
    const remaining = budgetMs - (Date.now() - started);
    if (remaining < 6000) {
      attempts.push({ provider, status: 0, reason: 'time-budget' });
      break;
    }
    const result = await runner({
      prompt,
      aspectRatio,
      seed,
      timeoutMs: Math.min(provider === 'hf-flux-free' ? 22_000 : 24_000, remaining - 1200),
      fetchImpl,
    });
    attempts.push({ provider, status: result.status || 0, reason: result.ok ? '' : result.reason, ms: result.ms });
    if (result.ok) {
      return { ...result, provider, attempts, ms: Date.now() - started };
    }
    if (result.reason === 'free-busy' || result.reason === 'gpu-quota' || result.reason === 'timeout') {
      busy = true;
      retryAfterMs = Math.max(retryAfterMs, Number(result.retryAfterMs) || 0);
    }
  }

  return {
    ok: false,
    reason: busy ? 'free-busy' : 'free-failed',
    retryAfterMs: busy ? Math.max(8_000, retryAfterMs || POLLINATIONS_WINDOW_MS) : 0,
    attempts,
    ms: Date.now() - started,
  };
}

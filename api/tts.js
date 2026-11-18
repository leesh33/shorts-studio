/**
 * api/tts.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/tts
 *   body: { text, voice?: "deep"|"docu", speed?: 0.7~1.35 }
 *   응답: audio/mpeg (실제 MP3 바이트) · 헤더에 X-TTS-Voice · X-TTS-Ms
 *   실패: JSON { ok:false, error, message } (400 잘못된 요청 · 502 음성 서비스 실패)
 *
 * GET /api/tts → { ok, engine, voices:[…], limits:{ maxChars } }  (키 값 없음)
 *
 * 왜 서버에서 만드나
 *   · 브라우저의 Web Speech 는 아이폰에서 목소리가 여성 위주이고, 녹화(MediaRecorder)로
 *     잡히지 않습니다. 그래서 '중후한 남성' 음성을 서버에서 MP3 로 만들어 내려받고,
 *     재생·영상 합성 모두 Web Audio 로 다룹니다.
 *   · 같은 문장은 인스턴스 캐시에 남겨 재생·내보내기에서 두 번 합성하지 않습니다.
 */

import { TTS_ENGINE, TTS_MAX_CHARS, TTS_TIMEOUT_MS, synthesize, voiceCatalog } from '../lib/tts.js';

function sendJson(res, status, payload) {
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

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      engine: TTS_ENGINE,
      voices: voiceCatalog(),
      limits: { maxChars: TTS_MAX_CHARS, timeoutMs: TTS_TIMEOUT_MS },
      note: 'Microsoft Edge 읽어주기 음성을 서버에서 MP3 로 만듭니다. API 키·결제가 필요 없습니다.',
    });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });

  const body = await readBody(req);
  const text = String(body.text || '');
  if (!text.trim()) {
    return sendJson(res, 400, { ok: false, error: 'empty', message: '읽을 문장이 비어 있습니다.' });
  }
  if (text.length > TTS_MAX_CHARS * 2) {
    return sendJson(res, 400, {
      ok: false,
      error: 'too-long',
      message: `한 문장은 ${TTS_MAX_CHARS}자 이내로 보내주세요(받은 ${text.length}자).`,
    });
  }

  const speed = Number(body.speed);
  const result = await synthesize({
    text,
    voice: body.voice,
    speed: Number.isFinite(speed) ? Math.min(1.35, Math.max(0.7, speed)) : 1,
    timeoutMs: TTS_TIMEOUT_MS,
  });

  if (!result.ok) {
    const status = result.error === 'too-long' ? 400 : 502;
    return sendJson(res, status, {
      ok: false,
      error: result.error,
      message: result.message,
      retryable: result.error === 'timeout' || result.error === 'upstream',
      ms: result.ms,
    });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', result.mimeType || 'audio/mpeg');
  res.setHeader('Content-Length', String(result.audio.length));
  // 같은 문장 → 같은 음성. CDN·브라우저가 하루 동안 재사용해도 안전합니다.
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, immutable');
  res.setHeader('X-TTS-Voice', String(result.voiceName || ''));
  res.setHeader('X-TTS-Profile', String(result.voice || ''));
  res.setHeader('X-TTS-Ms', String(result.ms));
  res.setHeader('X-TTS-Cached', result.cached ? '1' : '0');
  res.end(result.audio);
}

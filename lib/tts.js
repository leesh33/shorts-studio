/**
 * lib/tts.js — 무료 '중후한 남성' 한국어 TTS
 * ─────────────────────────────────────────────────────────────
 * Microsoft Edge 브라우저의 '읽어주기' 음성(ko-KR-InJoonNeural · ko-KR-HyunsuMultilingualNeural)을
 * 그대로 쓰는 무료 경로입니다. 키도, 결제도, 별도 계정도 필요 없습니다.
 *   · 프로토콜·Sec-MS-GEC v2 토큰 처리는 MIT 라이선스 `node-edge-tts` 패키지가 맡습니다
 *     (Vercel Node 런타임에서 그대로 동작 — 서버리스 번들에 포함).
 *   · 낭독 톤은 voice 별 prosody(rate·pitch)로 만듭니다. 기본값은 조금 느리고 낮게 —
 *     다큐 내레이터처럼 가라앉은 중후함을 노립니다.
 *   · 실패는 꾸미지 않습니다: 빈 오디오·타임아웃·업스트림 거부를 그대로 돌려주고,
 *     화면은 브라우저 음성(Web Speech)으로 조용히 폴백합니다.
 *
 * 반환
 *   { ok:true, audio:Buffer, mimeType:'audio/mpeg', voice, label, chars, ms, cached:boolean }
 *   { ok:false, error:'empty'|'too-long'|'timeout'|'upstream'|'empty-audio', message, ms }
 */

import { EdgeTTS } from 'node-edge-tts';

export const TTS_ENGINE = 'edge-readaloud';

/** 고를 수 있는 낭독 톤 — 화면의 음성 pill 과 1:1로 맞춥니다. */
export const TTS_VOICES = {
  deep: {
    id: 'deep',
    label: '중후한 남성 · 기본',
    voice: 'ko-KR-InJoonNeural',
    lang: 'ko-KR',
    rate: '-8%',
    pitch: '-10%',
    note: '낮고 묵직한 다큐 내레이터 톤',
  },
  docu: {
    id: 'docu',
    label: '차분한 다큐 톤',
    voice: 'ko-KR-HyunsuMultilingualNeural',
    lang: 'ko-KR',
    rate: '-14%',
    pitch: '-4%',
    note: '조금 느리고 담백한 설명 톤',
  },
};

export const TTS_DEFAULT_VOICE = 'deep';
export const TTS_MAX_CHARS = 400;
export const TTS_TIMEOUT_MS = 20_000;
export const TTS_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** 캐시 — 같은 컷을 다시 재생·내보내기 할 때 업스트림을 두 번 부르지 않습니다. */
const CACHE_MAX = 80;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

/** 음성 이름 검증 — 화면에서 온 값을 그대로 SSML 에 넣지 않습니다. */
export function voiceProfile(name) {
  const key = String(name || '').trim();
  if (key === 'browser') return null;
  return TTS_VOICES[key] || TTS_VOICES[TTS_DEFAULT_VOICE];
}

/**
 * 대본 자막 → 읽을 문장.
 *   · [강조] 대괄호는 화면 표기용이므로 읽지 않습니다.
 *   · 줄바꿈·연속 공백 정리, 말줄임표는 쉼으로.
 */
export function sanitizeNarration(text) {
  return String(text == null ? '' : text)
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/[#*_`>]/g, '')
    .replace(/[.…]{2,}|…/g, ', ')
    .replace(/\s*,\s*,+/g, ',')
    .replace(/\s*\.\s*\.+/g, '.')
    .replace(/\s*,\s*$/, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 음성 프로필의 기준 rate(%)에 화면 속도 배율을 곱합니다(범위 제한). */
export function scaleRate(baseRate, speed) {
  const base = Number(String(baseRate || '0').replace('%', '')) || 0;
  const factor = Math.min(1.35, Math.max(0.7, Number(speed) || 1));
  const percent = Math.round(base * factor);
  return `${Math.max(-45, Math.min(20, percent))}%`;
}

/** 앞 바이트로 실제 MP3 인지 확인합니다(업스트림이 빈 응답·오류를 줄 때 방어). */
export function looksLikeMp3(buffer) {
  if (!buffer || buffer.length < 2000) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // ID3
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0; // MPEG frame sync
}

/** 기본 러너 — Edge 읽어주기 WebSocket으로 실제 음성을 받습니다. */
export async function edgeRunner({ voice, lang, rate, pitch, text, timeoutMs = TTS_TIMEOUT_MS }) {
  const tts = new EdgeTTS({
    voice,
    lang,
    rate,
    pitch,
    volume: '+0%',
    outputFormat: TTS_OUTPUT_FORMAT,
    saveSubtitles: false,
    timeout: timeoutMs,
  });
  const chunks = [];
  for await (const chunk of tts.streamAudio(text)) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.audio;
}

function cacheSet(key, audio) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { audio, at: Date.now() });
}

/**
 * 문장 하나를 음성으로 만듭니다.
 *   runner 를 주입하면 네트워크 없이 테스트합니다(테스트에서 실제로 나가지 않음).
 */
export async function synthesize({ text, voice, speed = 1, runner = edgeRunner, timeoutMs = TTS_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const plain = sanitizeNarration(text);
  if (!plain) return { ok: false, error: 'empty', message: '읽을 문장이 비어 있습니다.', ms: 0 };
  if (plain.length > TTS_MAX_CHARS) {
    return { ok: false, error: 'too-long', message: `한 번에 ${TTS_MAX_CHARS}자까지만 읽습니다.`, ms: 0 };
  }

  const profile = voiceProfile(voice);
  if (!profile) return { ok: false, error: 'browser-voice', message: '브라우저 음성은 서버에서 만들지 않습니다.', ms: 0 };

  const rate = scaleRate(profile.rate, speed);
  const key = `${profile.id}|${profile.voice}|${rate}|${profile.pitch}|${plain}`;
  const cached = cacheGet(key);
  if (cached) {
    return {
      ok: true,
      audio: cached,
      mimeType: 'audio/mpeg',
      voice: profile.id,
      voiceName: profile.voice,
      label: profile.label,
      chars: plain.length,
      text: plain,
      ms: Date.now() - started,
      cached: true,
    };
  }

  let audio;
  try {
    audio = await Promise.race([
      runner({ voice: profile.voice, lang: profile.lang, rate, pitch: profile.pitch, text: plain, timeoutMs }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('tts-timeout'), { code: 'timeout' })), timeoutMs + 3000)),
    ]);
  } catch (err) {
    const timeout = err?.code === 'timeout' || /timeout|timed out/i.test(String(err?.message || ''));
    return {
      ok: false,
      error: timeout ? 'timeout' : 'upstream',
      message: timeout
        ? `음성 합성이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`
        : `음성 서비스가 응답하지 않았습니다: ${String(err?.message || err).slice(0, 120)}`,
      ms: Date.now() - started,
    };
  }

  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (!looksLikeMp3(buffer)) {
    return {
      ok: false,
      error: 'empty-audio',
      message: '음성 서비스가 빈 오디오를 돌려줬습니다.',
      bytes: buffer.length,
      ms: Date.now() - started,
    };
  }

  cacheSet(key, buffer);
  return {
    ok: true,
    audio: buffer,
    mimeType: 'audio/mpeg',
    voice: profile.id,
    voiceName: profile.voice,
    label: profile.label,
    rate,
    chars: plain.length,
    text: plain,
    ms: Date.now() - started,
    cached: false,
  };
}

/** GET /api/tts 안내용 목록 (음성 이름은 공개 정보) */
export function voiceCatalog() {
  return Object.values(TTS_VOICES).map((v) => ({
    id: v.id,
    label: v.label,
    voice: v.voice,
    lang: v.lang,
    rate: v.rate,
    pitch: v.pitch,
    note: v.note,
  }));
}

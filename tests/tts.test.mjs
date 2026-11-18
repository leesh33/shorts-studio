/**
 * tests/tts.test.mjs — 중후한 남성 TTS 의 순수 함수와 엔드포인트 계약
 *   · [강조] 대괄호는 읽지 않고, 말줄임표는 쉼으로 바꾼다
 *   · 같은 문장은 캐시에서 다시 쓰고(업스트림 1회), 실패는 성공으로 꾸미지 않는다
 *   · /api/tts GET 은 목소리 목록만, 빈 본문은 400 (네트워크를 타지 않음)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import ttsHandler from '../api/tts.js';
import {
  TTS_DEFAULT_VOICE,
  TTS_VOICES,
  looksLikeMp3,
  sanitizeNarration,
  scaleRate,
  synthesize,
  voiceProfile,
} from '../lib/tts.js';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(k, v) {
      res.headers[String(k).toLowerCase()] = v;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    get body() {
      return Buffer.concat(res.chunks);
    },
  };
  return res;
}

function mockReq({ method = 'POST', body = {} } = {}) {
  return { method, body, url: '/api/tts', headers: {} };
}

/** MP3 프레임 싱크로 시작하는 가짜 음성 */
function mp3Bytes(size = 6000) {
  const buf = Buffer.alloc(size, 0x11);
  buf[0] = 0xff;
  buf[1] = 0xf3;
  return buf;
}

test('sanitizeNarration: 대괄호 강조는 읽지 않고 말줄임표는 쉼이 된다', () => {
  assert.equal(sanitizeNarration('[검단] 신도시, [2028년]에 판이 바뀝니다.'), '검단 신도시, 2028년에 판이 바뀝니다.');
  assert.equal(sanitizeNarration('잠깐… 이게 핵심입니다'), '잠깐, 이게 핵심입니다');
  assert.equal(sanitizeNarration('  여러   줄\n\n 텍스트  '), '여러 줄 텍스트');
  assert.equal(sanitizeNarration(''), '');
  assert.equal(sanitizeNarration(null), '');
});

test('voiceProfile: 기본은 중후한 남성, 브라우저 음성은 서버에서 만들지 않는다', () => {
  assert.equal(TTS_DEFAULT_VOICE, 'deep');
  assert.equal(voiceProfile('deep').voice, 'ko-KR-InJoonNeural');
  assert.equal(voiceProfile('docu').voice, TTS_VOICES.docu.voice);
  assert.equal(voiceProfile('없는목소리').id, 'deep');
  assert.equal(voiceProfile('browser'), null);
});

test('scaleRate: 속도 배율이 기준 rate(%)에 곱해지고 범위를 벗어나지 않는다', () => {
  assert.equal(scaleRate('-8%', 1), '-8%');
  assert.equal(scaleRate('-8%', 0.7), '-6%');
  assert.equal(scaleRate('-8%', 1.35), '-11%');
  assert.equal(scaleRate('default', 1), '0%');
  assert.equal(scaleRate('-40%', 0.7), '-28%');
  assert.equal(scaleRate('-40%', 1.35), '-45%'); // 하한 -45%
});

test('looksLikeMp3: 프레임 싱크가 없는 응답은 음성으로 인정하지 않는다', () => {
  assert.equal(looksLikeMp3(mp3Bytes()), true);
  assert.equal(looksLikeMp3(Buffer.from('{"ok":false}')), false);
  assert.equal(looksLikeMp3(mp3Bytes(120)), false);
  assert.equal(looksLikeMp3(null), false);
});

test('synthesize: 주입한 러너의 음성을 돌려주고 같은 문장은 캐시에서 재사용한다', async () => {
  let calls = 0;
  const runner = async ({ voice, rate, pitch, text }) => {
    calls += 1;
    assert.equal(voice, 'ko-KR-InJoonNeural');
    assert.equal(rate, '-8%');
    assert.equal(pitch, '-10%');
    assert.match(text, /^검단 신도시/);
    return mp3Bytes(5000);
  };

  const first = await synthesize({ text: '[검단] 신도시, 2028년입니다.', voice: 'deep', runner });
  assert.equal(first.ok, true);
  assert.equal(first.mimeType, 'audio/mpeg');
  assert.equal(first.cached, false);
  assert.equal(first.chars, '검단 신도시, 2028년입니다.'.length);

  const second = await synthesize({ text: '[검단] 신도시, 2028년입니다.', voice: 'deep', runner });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(calls, 1, '같은 문장은 업스트림을 두 번 부르지 않습니다');
});

test('synthesize: 빈 응답·업스트림 오류·빈 문장은 성공으로 꾸미지 않는다', async () => {
  const empty = await synthesize({ text: '읽을 문장', runner: async () => Buffer.alloc(0) });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'empty-audio');

  const failed = await synthesize({ text: '읽을 문장', runner: async () => { throw new Error('blocked'); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'upstream');
  assert.match(failed.message, /blocked/);

  const timeout = await synthesize({ text: '읽을 문장', runner: async () => { throw Object.assign(new Error('t'), { code: 'timeout' }); } });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error, 'timeout');

  const blank = await synthesize({ text: '   ', runner: async () => mp3Bytes() });
  assert.equal(blank.ok, false);
  assert.equal(blank.error, 'empty');

  const long = await synthesize({ text: '가'.repeat(500), runner: async () => mp3Bytes() });
  assert.equal(long.ok, false);
  assert.equal(long.error, 'too-long');
});

test('synthesize: 브라우저 음성은 서버에서 합성하지 않는다', async () => {
  const result = await synthesize({ text: '읽을 문장', voice: 'browser', runner: async () => mp3Bytes() });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'browser-voice');
});

test('/api/tts GET: 목소리 목록과 한도를 돌려주고 키·토큰을 담지 않는다', async () => {
  const res = mockRes();
  await ttsHandler(mockReq({ method: 'GET' }), res);
  const data = JSON.parse(res.body.toString());
  assert.equal(res.statusCode, 200);
  assert.equal(data.ok, true);
  assert.equal(data.engine, 'edge-readaloud');
  assert.equal(data.voices.length, 2);
  assert.equal(data.limits.maxChars, 400);
  assert.doesNotMatch(res.body.toString(), /6A5AA1D4|TrustedClientToken|Sec-MS-GEC/);
});

test('/api/tts POST: 빈 문장은 400 (음성 서비스를 부르지 않음)', async () => {
  const res = mockRes();
  await ttsHandler(mockReq({ body: { text: '   ' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body.toString()).error, 'empty');
});

test('/api/tts 는 POST 만 받는다', async () => {
  const res = mockRes();
  await ttsHandler(mockReq({ method: 'PUT' }), res);
  assert.equal(res.statusCode, 405);
});

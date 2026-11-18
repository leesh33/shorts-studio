/**
 * tests/free-image.test.mjs — 무료 이미지 경로의 순수 함수·사다리 동작
 *   · 같은 프롬프트 → 같은 시드(재시도 시 같은 장면)
 *   · 앞 바이트로 이미지 여부를 판정(JSON 을 이미지로 착각하지 않음)
 *   · 402(익명 한도)면 재시도 초를 올려 보내고, 이미지가 하나도 없으면 성공으로 꾸미지 않음
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_PROVIDERS,
  POLLINATIONS_WINDOW_MS,
  generateFreeImage,
  seedForPrompt,
  sizeFor,
  sniffImageMime,
} from '../lib/free-image.js';

function binaryRes(bytes, mime, status = 200, headers = {}) {
  const buf = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (String(n).toLowerCase() in headers ? headers[String(n).toLowerCase()] : String(n).toLowerCase() === 'content-type' ? mime : null) },
    arrayBuffer: async () => buf,
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
}

function jpeg(size = 3000) {
  const b = Buffer.alloc(size, 0x41);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

test('sizeFor: 9:16 은 세로 720×1280', () => {
  assert.deepEqual(sizeFor('9:16'), { width: 720, height: 1280 });
  assert.deepEqual(sizeFor('1:1'), { width: 1024, height: 1024 });
  assert.deepEqual(sizeFor('16:9'), { width: 1280, height: 720 });
});

test('seedForPrompt: 같은 프롬프트는 같은 시드, 다른 프롬프트는 다른 시드', () => {
  const a = seedForPrompt('photoreal korean street 9:16');
  assert.equal(a, seedForPrompt('photoreal korean street 9:16'));
  assert.notEqual(a, seedForPrompt('photoreal korean kitchen 9:16'));
  assert.ok(Number.isInteger(a) && a >= 0);
});

test('sniffImageMime: JPEG·PNG·WebP 만 이미지로 본다(JSON 은 아님)', () => {
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('{"status":402}', 'utf8')), '');
});

test('generateFreeImage: 402 면 retryAfter 를 초로 읽어 busy 로 돌려준다', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: false,
      status: 402,
      headers: { get: () => null },
      text: async () => JSON.stringify({ status: 402, error: { code: 'FREE_LIMIT', message: 'Retry after 30s' } }),
      arrayBuffer: async () => Buffer.alloc(0),
      json: async () => ({}),
    };
  };
  const r = await generateFreeImage({
    prompt: 'photoreal korean street at night 9:16',
    budgetMs: 20_000,
    providers: FREE_PROVIDERS,
    fetchImpl,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'free-busy');
  assert.equal(r.retryAfterMs, 30_000);
  assert.ok(calls.some((u) => u.includes('image.pollinations.ai')));
});

test('generateFreeImage: 앞 후보가 죽어도 다음 후보가 주면 성공한다', async () => {
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('image.pollinations.ai')) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom', arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}) };
    }
    if (u.endsWith('/gradio_api/call/infer')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ event_id: 'e1' }), text: async () => '{}' };
    if (u.includes('/gradio_api/call/infer/e1')) {
      return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, text: async () => 'event: complete\ndata: [{"url": "https://hf.space/f/a.png"}]\n\n', json: async () => ({}) };
    }
    const b = jpeg();
    return binaryRes(b, 'image/jpeg');
  };
  const r = await generateFreeImage({ prompt: 'photoreal korean market 9:16', budgetMs: 25_000, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'hf-flux-free');
  assert.ok(r.base64.length > 100);
  assert.equal(r.mimeType, 'image/jpeg');
  assert.ok(POLLINATIONS_WINDOW_MS >= 45_000);
});

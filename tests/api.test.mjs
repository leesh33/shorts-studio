/**
 * tests/api.test.mjs — 새 Gemini 경로의 서버 동작(네트워크는 전부 스텁)
 *   · 키가 없으면 mode: 'template' (조용한 폴백)
 *   · 키가 있으면 mode: 'gemini' — 응답 어디에도 키가 없어야 함
 *   · 모델 404·형식 오류면 template 으로 돌아가고 시도 기록만 남김
 *   · /api/generate-image 는 키 없음 503, 성공 시 data URL, 모델 없으면 Imagen 폴백
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import analyzeHandler from '../api/analyze-and-generate.js';
import imageHandler from '../api/generate-image.js';
import healthHandler from '../api/health.js';
import { analyzeReference } from '../lib/engine.js';

const FAKE_KEY = 'test-key-do-not-leak-9f3a';
const TOPIC = '검단신도시 2028년 교통 호재';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      res.headers[String(k).toLowerCase()] = v;
    },
    end(chunk) {
      res.body = String(chunk == null ? '' : chunk);
    },
  };
  return res;
}

function mockReq({ method = 'POST', body = {}, url = '/' } = {}) {
  return { method, body, url, headers: {} };
}

function jsonRes(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

const blueprint = analyzeReference({
  url: 'https://www.youtube.com/shorts/2QZPPEle9IY',
  topic: TOPIC,
  title: '레퍼런스 쇼츠 제목',
  channel: '테스트 채널',
  durationSec: 32,
  description: '설명글입니다.',
  fetchedBy: 'page',
});

function sampleScript(count = 7) {
  const beats = ['hook', 'setup', 'p1', 'p2', 'p3', 'twist', 'cta', 'p4'];
  return {
    viralDna: {
      hookFormula: '손실 경고 + 즉시 결론',
      hookWhy: '결론을 먼저 던집니다.',
      pacing: '2~4초 컷 7개',
      captionStyle: '1~2줄 18자',
      tone: '단정적',
      evidence: ['첫 3초에 결론이 나옵니다.'],
    },
    strategy: 'info',
    titles: ['검단 교통, 지금 봐야 합니다'],
    hashtags: ['#검단', '교통호재'],
    cuts: Array.from({ length: count }, (_, i) => ({
      beat: beats[i % beats.length],
      narration: i === 0 ? '검단, 2028년에 판이 바뀝니다. 30초로 정리합니다.' : `컷 ${i + 1}번, 지금 확인해야 할 숫자는 이겁니다. 하나씩 보세요.`,
      subtitle: i === 0 ? '검단, [2028년]에 판이 바뀝니다' : `컷 ${i + 1} [핵심] 문장`,
      visualKo: '연출 한 줄',
      visualPrompt: 'Photoreal editorial photograph, Korean new town street, 9:16 vertical, 35mm',
      camera: '천천히 푸시인',
    })),
  };
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function withKey(key, fn) {
  const original = process.env.GEMINI_API_KEY;
  if (key) process.env.GEMINI_API_KEY = key;
  else delete process.env.GEMINI_API_KEY;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    });
}

test('analyze: GEMINI_API_KEY 가 없으면 template 모드로 조용히 폴백', async () => {
  await withKey(null, async () => {
    const res = mockRes();
    await analyzeHandler(mockReq({ body: { url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: TOPIC, reference: blueprint } }), res);
    const data = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(data.mode, 'template');
    assert.equal(data.package.meta.mode, 'template');
    assert.equal(data.gemini.ok, false);
    assert.equal(data.gemini.reason, 'no-key');
    assert.equal(data.package.cuts.length >= 6, true);
  });
});

test('analyze: 키가 있으면 Gemini 대본을 쓰고 mode=gemini, 키는 응답에 없다', async () => {
  let sawHeader = '';
  await withKey(FAKE_KEY, () =>
    withFetch(
      async (url, init) => {
        assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/);
        sawHeader = String(init.headers['x-goog-api-key'] || '');
        return jsonRes({ candidates: [{ content: { parts: [{ text: JSON.stringify(sampleScript(7)) }] } }] });
      },
      async () => {
        const res = mockRes();
        await analyzeHandler(
          mockReq({ body: { url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: TOPIC, length: 36, reference: blueprint } }),
          res,
        );
        const data = JSON.parse(res.body);
        assert.equal(data.mode, 'gemini');
        assert.equal(data.gemini.ok, true);
        assert.equal(data.gemini.model, 'gemini-2.5-flash-lite');
        assert.equal(data.package.cuts.length, 7);
        assert.equal(data.package.meta.mode, 'gemini');
        assert.ok(data.package.cuts[0].subtitle.includes('[2028년]'));
        assert.ok(data.package.cuts[0].visualPrompt.includes('9:16'));
        assert.equal(data.analysis.blueprint.hook.label, '손실 경고 + 즉시 결론');
        assert.equal(data.analysis.blueprint.ai.model, 'gemini-2.5-flash-lite');
        assert.ok(!res.body.includes(FAKE_KEY), '응답에 키가 있으면 안 됩니다');
        assert.equal(sawHeader, FAKE_KEY, '키는 헤더로만 나갑니다');
      },
    ),
  );
});

test('analyze: 모든 모델이 404면 template 으로 돌아가고 시도 기록을 남긴다', async () => {
  await withKey(FAKE_KEY, () =>
    withFetch(
      async () => jsonRes({ error: { message: 'model not found' } }, 404),
      async () => {
        const res = mockRes();
        await analyzeHandler(mockReq({ body: { url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: TOPIC, reference: blueprint } }), res);
        const data = JSON.parse(res.body);
        assert.equal(data.mode, 'template');
        assert.equal(data.gemini.ok, false);
        assert.ok(Array.isArray(data.gemini.attempts) && data.gemini.attempts.length >= 2);
        assert.equal(data.package.cuts.length >= 6, true);
        assert.ok(!res.body.includes(FAKE_KEY));
      },
    ),
  );
});

test('analyze: 형식이 깨진 응답이면 template 폴백 (mode 는 정직하게 template)', async () => {
  await withKey(FAKE_KEY, () =>
    withFetch(
      async () => jsonRes({ candidates: [{ content: { parts: [{ text: '죄송하지만 JSON 으로 답할 수 없습니다.' }] } }] }),
      async () => {
        const res = mockRes();
        await analyzeHandler(mockReq({ body: { url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: TOPIC, reference: blueprint } }), res);
        const data = JSON.parse(res.body);
        assert.equal(data.mode, 'template');
        assert.equal(data.gemini.reason, 'no-json');
      },
    ),
  );
});

test('analyze: 주제가 없으면 400', async () => {
  const res = mockRes();
  await analyzeHandler(mockReq({ body: { url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: '  ', reference: blueprint } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'no-topic');
});

test('generate-image: 키가 없으면 503 gemini-not-configured + 안내', async () => {
  await withKey(null, async () => {
    const res = mockRes();
    await imageHandler(mockReq({ body: { prompt: 'Photoreal photograph, Korean street, 9:16', aspectRatio: '9:16' } }), res);
    const data = JSON.parse(res.body);
    assert.equal(res.statusCode, 503);
    assert.equal(data.ok, false);
    assert.equal(data.error, 'gemini-not-configured');
    assert.ok(data.message.includes('GEMINI_API_KEY'));
  });
});

test('generate-image: 성공하면 data URL 로 돌려준다', async () => {
  const png = Buffer.from('fake-png-bytes'.repeat(20)).toString('base64');
  await withKey(FAKE_KEY, () =>
    withFetch(
      async (url, init) => {
        assert.match(String(url), /:generateContent$/);
        const body = JSON.parse(init.body);
        assert.equal(body.generationConfig.responseModalities.join(','), 'TEXT,IMAGE');
        assert.equal(body.generationConfig.imageConfig.aspectRatio, '9:16');
        return jsonRes({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] });
      },
      async () => {
        const res = mockRes();
        await imageHandler(mockReq({ body: { prompt: 'Photoreal photograph, Korean street, 9:16', cutId: 'cut-2' } }), res);
        const data = JSON.parse(res.body);
        assert.equal(res.statusCode, 200);
        assert.equal(data.ok, true);
        assert.equal(data.image, `data:image/png;base64,${png}`);
        assert.equal(data.model, 'gemini-2.5-flash-image');
        assert.equal(data.cutId, 'cut-2');
        assert.ok(!res.body.includes(FAKE_KEY));
      },
    ),
  );
});

test('generate-image: Gemini 이미지 모델이 없으면 Imagen(predict)으로 폴백', async () => {
  const png = Buffer.from('imagen-bytes'.repeat(30)).toString('base64');
  const seen = [];
  await withKey(FAKE_KEY, () =>
    withFetch(
      async (url, init) => {
        seen.push(String(url));
        if (String(url).endsWith(':predict')) {
          const body = JSON.parse(init.body);
          assert.equal(body.parameters.aspectRatio, '9:16');
          return jsonRes({ predictions: [{ bytesBase64Encoded: png, mimeType: 'image/png' }] });
        }
        return jsonRes({ error: { message: 'unsupported model' } }, 404);
      },
      async () => {
        const res = mockRes();
        await imageHandler(mockReq({ body: { prompt: 'Photoreal photograph, Korean street, 9:16' } }), res);
        const data = JSON.parse(res.body);
        assert.equal(res.statusCode, 200);
        assert.equal(data.model, 'imagen-3.0-generate-002');
        assert.ok(seen.some((u) => u.endsWith(':predict')));
        assert.ok(data.image.startsWith('data:image/png;base64,'));
      },
    ),
  );
});

test('generate-image: 프롬프트가 비면 400', async () => {
  const res = mockRes();
  await imageHandler(mockReq({ body: { prompt: '  ' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'no-prompt');
});

test('generate-image GET: 진단 정보에 키 값은 없고 유무만 있다', async () => {
  await withKey(FAKE_KEY, async () => {
    const res = mockRes();
    await imageHandler(mockReq({ method: 'GET', url: '/api/generate-image' }), res);
    const data = JSON.parse(res.body);
    assert.equal(data.hasGeminiKey, true);
    assert.ok(Array.isArray(data.models) && data.models.includes('gemini-2.5-flash-image'));
    assert.ok(!res.body.includes(FAKE_KEY));
  });
});

test('health: hasGeminiKey 불리언만 노출하고 키 값은 숨긴다', async () => {
  await withKey(FAKE_KEY, async () => {
    const res = mockRes();
    healthHandler(mockReq({ method: 'GET', url: '/api/health' }), res);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.hasGeminiKey, true);
    assert.equal(typeof data.hasGeminiKey, 'boolean');
    assert.ok(!res.body.includes(FAKE_KEY));
  });
  await withKey(null, async () => {
    const res = mockRes();
    healthHandler(mockReq({ method: 'GET', url: '/api/health' }), res);
    assert.equal(JSON.parse(res.body).hasGeminiKey, false);
  });
});

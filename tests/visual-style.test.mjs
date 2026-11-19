/**
 * tests/visual-style.test.mjs — 3D 다이오라마 / 실사 시네마틱 스타일
 *   · 모르는 값은 기본 3D 로 정규화, 두 번 입혀도 접미사가 겹치지 않음
 *   · 3D 스타일은 포토리얼 단어를 걷어내고, 실사 스타일은 3D 단어를 걷어낸다
 *   · /api/analyze-and-generate · /api/generate-image 가 같은 스타일을 받아 쓴다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import analyzeHandler from '../api/analyze-and-generate.js';
import imageHandler from '../api/generate-image.js';
import { analyzeReference } from '../lib/engine.js';
import {
  DEFAULT_VISUAL_STYLE,
  VISUAL_STYLES,
  enhanceImagePrompt,
  normalizeStyle,
  styleCatalog,
  styleFor,
  styleRule,
} from '../lib/visual-style.js';

const TOPIC = '검단신도시 2028년 교통 호재';
const PHOTOREAL = 'editorial photograph, vertical 9:16, Korean new town street, documentary realism, no 3D render, shot on 35mm, f/2.0';

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

function binaryRes(bytes, mime = 'image/jpeg', status = 200) {
  const buf = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? mime : null) },
    arrayBuffer: async () => buf,
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
}

function jpegBytes(size = 4000) {
  const buf = Buffer.alloc(size, 0x41);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
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

test('normalizeStyle: 모르는 값·빈 값은 기본 3D 로', () => {
  assert.equal(DEFAULT_VISUAL_STYLE, '3d');
  assert.equal(normalizeStyle('cinematic'), 'cinematic');
  assert.equal(normalizeStyle('3D'), '3d');
  assert.equal(normalizeStyle('없는스타일'), '3d');
  assert.equal(normalizeStyle(null), '3d');
  assert.equal(styleFor('cinematic').label, '실사 시네마틱');
  assert.equal(styleCatalog().length, 4);
  assert.equal(normalizeStyle('real'), 'real');
  assert.equal(normalizeStyle('video'), 'video');
  assert.ok(styleCatalog().some((s) => s.id === 'real' && s.kind === 'photo'));
  assert.ok(styleCatalog().some((s) => s.id === 'video' && s.kind === 'video'));
});

test('enhanceImagePrompt: 3D 스타일은 포토리얼 언어를 걷어내고 다이오라마 언어를 붙인다', () => {
  const prompt = enhanceImagePrompt(PHOTOREAL, '3d');
  assert.match(prompt, /3D architectural miniature diorama/i);
  assert.match(prompt, /isometric/i);
  assert.doesNotMatch(prompt, /photograph/i);
  assert.doesNotMatch(prompt, /35mm/i);
  assert.doesNotMatch(prompt, /3D render/i);
  assert.doesNotMatch(prompt, /,\s*,/, '빈 조각이 남지 않습니다');
});

test('enhanceImagePrompt: 실사 스타일은 3D 언어를 걷어내고 필름 스틸 언어를 붙인다', () => {
  const draft = enhanceImagePrompt(PHOTOREAL, '3d');
  const cinematic = enhanceImagePrompt(draft, 'cinematic');
  assert.match(cinematic, /photoreal cinematic film still/i);
  assert.doesNotMatch(cinematic, /diorama/i);
  assert.doesNotMatch(cinematic, /isometric/i);
});

test('enhanceImagePrompt: 같은 스타일을 두 번 입혀도 접미사가 겹치지 않는다', () => {
  const once = enhanceImagePrompt('Korean apartment skyline, 9:16 vertical', '3d');
  const twice = enhanceImagePrompt(once, '3d');
  assert.equal(twice, once);
  assert.equal(once.match(/architectural miniature diorama/gi).length, 1);
});

test('styleRule: 대본 지시문이 스타일에 맞게 바뀐다', () => {
  assert.match(styleRule('3d'), /3D 아키텍처 다이오라마/);
  assert.match(styleRule('cinematic'), /포토리얼 사진/);
  assert.equal(styleRule(null), VISUAL_STYLES['3d'].rule);
});

test('analyze: style:3d 면 컷 프롬프트와 meta 에 스타일이 실린다', async () => {
  const res = mockRes();
  await analyzeHandler(mockReq({ body: { url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: TOPIC, reference: blueprint, style: '3d' } }), res);
  const data = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(data.visualStyle, '3d');
  assert.equal(data.package.meta.visualStyle, '3d');
  assert.match(data.package.cuts[0].visualPrompt, /3D architectural miniature diorama/i);
  assert.doesNotMatch(data.package.cuts[0].visualPrompt, /\bphotoreal\b/i);
});

test('analyze: style:cinematic 이면 실사 프롬프트가 유지된다', async () => {
  const res = mockRes();
  await analyzeHandler(mockReq({ body: { url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: TOPIC, reference: blueprint, style: 'cinematic' } }), res);
  const data = JSON.parse(res.body);
  assert.equal(data.visualStyle, 'cinematic');
  assert.match(data.package.cuts[0].visualPrompt, /photoreal cinematic film still/i);
});

test('generate-image: 3D 스타일이 업스트림 프롬프트와 응답에 반영된다', async () => {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return binaryRes(jpegBytes(6000));
  };
  try {
    const res = mockRes();
    await imageHandler(mockReq({ body: { prompt: PHOTOREAL, aspectRatio: '9:16', cutId: 'cut-1', style: '3d' } }), res);
    const data = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(data.ok, true);
    assert.equal(data.visualStyle, '3d');
    const sent = decodeURIComponent(urls[0] || '');
    assert.match(sent, /miniature diorama/i);
    assert.doesNotMatch(sent, /editorial photograph/i);
  } finally {
    globalThis.fetch = original;
  }
});

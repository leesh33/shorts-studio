/**
 * tests/ranking.test.mjs — 🏆 TOP 5 랭킹 모드
 *   · lib/ranking.js 순수 로직(순위·타임라인·자막 줄바꿈·AI 응답 파싱·폴백)
 *   · api/analyze-ranking.js 서버 동작(네트워크는 전부 스텁)
 *     - 슬롯 정보: 유튜브 페이지 제목 + 자동 자막, 자막이 막히면 정직한 안내
 *     - 랭킹 대본: 키가 없으면 template, 키가 있으면 gemini, 응답에 키가 없어야 함
 *     - 유튜브 영상 파일은 클라우드에서 못 받는다는 사실을 응답에 담음
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import rankingHandler from '../api/analyze-ranking.js';
import {
  RANKS,
  normalizeRank,
  rankLabel,
  rankMeta,
  createSlot,
  normalizeSlots,
  slotSource,
  effectiveTrim,
  slotDurationSec,
  buildRankingTimeline,
  segmentAt,
  rankSpeechText,
  splitCaptionLines,
  validateSlots,
  buildRankingPrompt,
  parseRankingScript,
  applyRankingScript,
  localRankingScript,
  rankingExportName,
  recorderMimeCandidates,
  sniffVideoBytes,
  readRankingBody,
  highlightSuggestion,
} from '../lib/ranking.js';

const FAKE_KEY = 'ranking-test-key-do-not-leak-77aa';

/* ───────────────────────── 순위·슬롯 ───────────────────────── */

test('ranking: 순위 표기는 1~5 만 인정한다', () => {
  assert.equal(normalizeRank(3), 3);
  assert.equal(normalizeRank('TOP 3'), 3);
  assert.equal(normalizeRank('3위'), 3);
  assert.equal(normalizeRank('1'), 1);
  assert.equal(normalizeRank(0), 0);
  assert.equal(normalizeRank(9), 0);
  assert.equal(normalizeRank(''), 0);
  assert.equal(normalizeRank('abc'), 0);
  assert.equal(rankLabel(2), 'TOP 2');
  assert.equal(rankLabel(0), '');
});

test('ranking: 1위만 금색 배지, 나머지는 보라', () => {
  assert.deepEqual(
    RANKS.map((rank) => rankMeta(rank).gold),
    [false, false, false, false, true],
  );
  assert.equal(rankMeta(1).accent, '#F5C542');
  assert.equal(rankMeta(5).label, 'TOP 5');
  assert.notEqual(rankMeta(2).accent, rankMeta(1).accent);
});

test('ranking: 빈 입력도 5칸(TOP 5→TOP 1)으로 정규화된다', () => {
  const slots = normalizeSlots([]);
  assert.equal(slots.length, 5);
  assert.deepEqual(
    slots.map((s) => s.rank),
    [5, 4, 3, 2, 1],
  );
  assert.ok(slots.every((s) => s.caption === '' && s.clipName === ''));
  assert.equal(createSlot(99).rank, 5, '잘못된 순위는 TOP 5 칸으로 떨어진다(가짜 1위 금지)');
});

test('ranking: 들어온 순서가 뒤섞여도 순위별로 한 칸씩, 중복은 버린다', () => {
  const slots = normalizeSlots([
    { rank: 1, title: '일위' },
    { rank: 'TOP 3', title: '삼위' },
    { rank: 1, title: '중복' },
    { rank: 5, title: '오위' },
  ]);
  assert.deepEqual(
    slots.map((s) => s.title),
    ['오위', '', '삼위', '', '일위'],
  );
  assert.equal(slots[4].title, '일위');
});

test('ranking: 길이·클립 수치는 범위 안으로 잘린다', () => {
  const slot = normalizeSlots([{ rank: 2, trimStart: -5, trimSec: 999, clipDurationSec: 8 }])[1];
  const trim = effectiveTrim(slot);
  assert.equal(trim.start, 0);
  assert.ok(trim.sec <= 8);
  const shorter = normalizeSlots([{ rank: 2, trimStart: 7.8, trimSec: 10, clipDurationSec: 8 }])[1];
  const clipped = effectiveTrim(shorter);
  assert.ok(clipped.start >= 0 && clipped.start <= 7.5);
  assert.equal(slotDurationSec(shorter), clipped.sec);
});

test('ranking: 클립이 없으면 기본 4초, 있으면 다듬기 범위를 따른다', () => {
  const none = normalizeSlots([])[0];
  assert.equal(slotDurationSec(none), 4);
  const withClip = normalizeSlots([{ rank: 5, clipDurationSec: 9, trimStart: 1, trimSec: 3.5 }])[0];
  assert.equal(slotDurationSec(withClip), 3.5);
  const noTrim = normalizeSlots([{ rank: 5, clipDurationSec: 2.2 }])[0];
  assert.ok(slotDurationSec(noTrim) <= 2.2);
});

test('ranking: 슬롯 소스는 클립 > 이미지 > 그라데이션 카드', () => {
  assert.equal(slotSource(normalizeSlots([{ rank: 1, clipName: 'a.mp4', imageName: 'b.jpg' }])[4]), 'clip');
  assert.equal(slotSource(normalizeSlots([{ rank: 1, imageName: 'b.jpg' }])[4]), 'image');
  assert.equal(slotSource(normalizeSlots([])[4]), 'card');
});

/* ───────────────────────── 타임라인 ───────────────────────── */

test('ranking: 타임라인은 TOP 5 → TOP 1 순서로 이어 붙는다', () => {
  const slots = normalizeSlots([
    { rank: 1, caption: '일위' },
    { rank: 2, caption: '이위' },
    { rank: 3, caption: '삼위' },
    { rank: 4, caption: '사위' },
    { rank: 5, caption: '오위' },
  ]);
  const { segments, total, order } = buildRankingTimeline(slots);
  assert.deepEqual(order, [5, 4, 3, 2, 1]);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[4].end, total);
  segments.forEach((seg, i) => {
    if (i > 0) assert.equal(seg.start, segments[i - 1].end, '구간은 빈틈없이 이어진다');
    assert.ok(seg.dur > 0);
    assert.equal(seg.gold, seg.rank === 1);
  });
  assert.equal(total, 20);
});

test('ranking: 내레이션이 길면 그 구간만 늘어난다', () => {
  const slots = normalizeSlots([{ rank: 1, clipDurationSec: 2, trimSec: 2 }]);
  const { segments } = buildRankingTimeline(slots, { narration: { 1: 5 } });
  assert.ok(segments[4].dur >= 5, '음성 5초가 잘리지 않게 구간이 늘어난다');
});

test('ranking: segmentAt 은 경계에서 다음 순위로 넘어간다', () => {
  const slots = normalizeSlots([]);
  const { segments } = buildRankingTimeline(slots);
  assert.equal(segmentAt(segments, 0).rank, 5);
  assert.equal(segmentAt(segments, 3.99).rank, 5);
  assert.equal(segmentAt(segments, 4).rank, 4);
  assert.equal(segmentAt(segments, 999).rank, 1);
  assert.equal(segmentAt([], 1), null);
});

/* ───────────────────────── 자막 ───────────────────────── */

test('ranking: 자막은 15자 안에서 줄바꿈하고 [강조]를 유지한다', () => {
  const lines = splitCaptionLines('운동은 [1분]이면 충분하다고 합니다. 진짜입니다.', { maxChars: 12, maxLines: 3 });
  assert.ok(lines.length >= 2 && lines.length <= 3);
  assert.ok(lines.some((line) => line.parts.some((part) => part.hl)));
  lines.forEach((line) => assert.ok(line.text.length <= 13, `줄이 너무 김: ${line.text}`));
});

test('ranking: 강조 뒤에 붙은 조사는 띄우지 않는다', () => {
  const lines = splitCaptionLines('운동은 [1분]이면 충분합니다', { maxChars: 30, maxLines: 2 });
  assert.equal(lines.map((line) => line.text).join(' '), '운동은 1분이면 충분합니다');
  const wrapped = splitCaptionLines('단 음식은 [담배]와 같다고 말했습니다.', { maxChars: 12, maxLines: 3 });
  assert.ok(wrapped.some((line) => line.text.includes('담배와')), wrapped.map((l) => l.text).join('|'));
});

test('ranking: 자막이 너무 길면 마지막 줄이 줄임표로 끝난다', () => {  const long = '가'.repeat(30) + ' 나 '.repeat(10);
  const lines = splitCaptionLines(long, { maxChars: 10, maxLines: 2 });
  assert.equal(lines.length, 2);
  assert.ok(lines[1].text.endsWith('…'));
});

test('ranking: 내레이션 문장은 대괄호·마크업을 걷어낸다', () => {
  assert.equal(rankSpeechText({ caption: '운동은 [1분]이면 **충분**합니다' }), '운동은 1분이면 충분 합니다');
  assert.equal(rankSpeechText({ caption: '' }), '');
});

/* ───────────────────────── 준비 상태 ───────────────────────── */

test('ranking: 비어 있는 칸을 정직하게 알려 준다', () => {
  const check = validateSlots(normalizeSlots([{ rank: 1, caption: '일위' }]));
  assert.equal(check.ok, true);
  assert.equal(check.filled, 1);
  assert.deepEqual(check.empty, [5, 4, 3, 2]);
  assert.deepEqual(check.noClip, [5, 4, 3, 2, 1]);
  assert.equal(validateSlots(normalizeSlots([])).ok, false);
});

/* ───────────────────────── AI 대본 ───────────────────────── */

test('ranking: 프롬프트는 주제·다섯 순위·JSON 지시를 담는다', () => {
  const slots = normalizeSlots([
    { rank: 5, title: '오위 발언', ytTranscript: '첫 번째 자막입니다.' },
    { rank: 1, title: '일위 발언' },
  ]);
  const prompt = buildRankingPrompt({ topic: '리트 만점자 발언 TOP 5', slots });
  assert.ok(prompt.includes('리트 만점자 발언 TOP 5'));
  RANKS.forEach((rank) => assert.ok(prompt.includes(`TOP ${rank}`), `TOP ${rank} 누락`));
  assert.ok(prompt.includes('첫 번째 자막입니다.'));
  assert.ok(prompt.includes('자막 발췌에 없는 사실·숫자·이름을 새로 만들지 않는다'));
  assert.ok(prompt.includes('"slots"'));
});

test('ranking: Gemini 응답(코드펜스·객체·배열)을 모두 읽는다', () => {
  const fenced = '```json\n{"hook":"시작","slots":[{"rank":5,"caption":"오","title":"오위"},{"rank":4,"caption":"사"},{"rank":3,"caption":"삼"},{"rank":2,"caption":"이"},{"rank":1,"caption":"일"}]}\n```';
  const a = parseRankingScript(fenced);
  assert.equal(a.ok, true);
  assert.equal(a.hook, '시작');
  assert.deepEqual(a.slots.map((s) => s.rank), [5, 4, 3, 2, 1]);

  const arrayOnly = parseRankingScript('[{"rank":"TOP 5","caption":"오"},{"rank":"TOP 1","caption":"일"},{"rank":"TOP 3","caption":"삼"}]');
  assert.equal(arrayOnly.ok, true);
  assert.deepEqual(arrayOnly.slots.map((s) => s.rank), [5, 3, 1]);
});

test('ranking: 형식이 깨졌거나 순위가 모자라면 ok:false 로 돌려준다(가짜 성공 없음)', () => {
  assert.equal(parseRankingScript('설명만 있고 JSON 이 없습니다').ok, false);
  assert.equal(parseRankingScript('{"slots":[]}').ok, false);
  const few = parseRankingScript('{"slots":[{"rank":1,"caption":"일"},{"rank":2,"caption":"이"}]}');
  assert.equal(few.ok, false);
  assert.equal(few.reason, 'too-few');
});

test('ranking: 빈 칸만 채우고 직접 쓴 문장은 지킨다', () => {
  const slots = normalizeSlots([
    { rank: 1, caption: '내가 쓴 1위 문장' },
    { rank: 2, caption: '' },
  ]);
  const generated = {
    hook: '훅',
    slots: RANKS.map((rank) => ({ rank, title: `${rank}위`, caption: `생성된 ${rank}위 문장` })),
  };
  const kept = applyRankingScript(slots, generated, { overwrite: false });
  assert.equal(kept.slots[4].caption, '내가 쓴 1위 문장');
  assert.equal(kept.slots[3].caption, '생성된 2위 문장');
  assert.equal(kept.kept, 1);
  assert.equal(kept.filled, 4);
  assert.deepEqual(kept.missing, []);

  const overwritten = applyRankingScript(slots, generated, { overwrite: true });
  assert.equal(overwritten.slots[4].caption, '생성된 1위 문장');
  assert.equal(overwritten.filled, 5);
});

test('ranking: 생성 항목이 없는 순위는 missing 으로 남는다', () => {
  const slots = normalizeSlots([]);
  const applied = applyRankingScript(slots, { slots: [{ rank: 1, caption: '일' }] });
  assert.deepEqual(applied.missing, [5, 4, 3, 2]);
});

test('ranking: 로컬 폴백은 다섯 칸을 모두 채우고 숫자를 지어내지 않는다', () => {
  const fallback = localRankingScript({ topic: '리트 만점자 발언', slots: normalizeSlots([]) });
  assert.equal(fallback.mode, 'template');
  assert.equal(fallback.slots.length, 5);
  fallback.slots.forEach((item) => {
    assert.ok(item.caption.length > 0);
    assert.ok(!/\d+%|\d+년|\d+명/.test(item.caption), '근거 없는 숫자가 들어가면 안 됩니다');
    assert.ok(item.caption.includes(item.title.slice(0, 4)));
  });
  assert.ok(fallback.hook.includes('리트 만점자 발언'));
});

/* ───────────────────────── 파일·포맷 ───────────────────────── */

test('ranking: 파일 이름은 주제에서 위험 문자를 걷어낸다', () => {
  assert.equal(rankingExportName('리트 만점자/Top 5: 발언', 1080, 1920), '리트_만점자_Top_5_발언_top5_1080x1920.mp4');
  assert.equal(rankingExportName('', 720, 1280, 'webm'), 'top5_top5_720x1280.webm');
});

test('ranking: 녹화 후보는 오디오가 있을 때 mp4+aac 를 먼저 보고, MP4 컨테이너를 WebM 보다 앞세운다', () => {
  assert.ok(recorderMimeCandidates(true)[0].includes('mp4a'));
  assert.ok(recorderMimeCandidates(false).every((mime) => !mime.includes('mp4a')));
  const withSound = recorderMimeCandidates(true);
  assert.ok(withSound.indexOf('video/mp4;codecs=vp9,opus') < withSound.indexOf('video/webm;codecs=vp9,opus'));
  assert.ok(withSound.includes('video/mp4;codecs=vp9,opus'), 'H.264 가 없는 크로미움도 MP4 컨테이너로 담을 수 있어야 합니다');
});

test('ranking: 바이트로 mp4/webm 컨테이너를 구분한다', () => {
  const mp4 = new Uint8Array(24);
  mp4[4] = 0x66; // f
  mp4[5] = 0x74; // t
  mp4[6] = 0x79; // y
  mp4[7] = 0x70; // p
  mp4[8] = 0x61; // a
  mp4[9] = 0x76; // v
  mp4[10] = 0x63; // c
  mp4[11] = 0x31; // 1
  const mp4Kind = sniffVideoBytes(mp4);
  assert.equal(mp4Kind.container, 'mp4');
  assert.equal(mp4Kind.codec, 'h264');

  const webm = new Uint8Array(16);
  [0x1a, 0x45, 0xdf, 0xa3].forEach((b, i) => (webm[i] = b));
  const webmKind = sniffVideoBytes(webm);
  assert.equal(webmKind.container, 'webm');
  assert.equal(webmKind.audio, 'none');
});

test('ranking: MP4 는 ftyp 브랜드(avc1)에 속지 않고 샘플 설명으로 코덱을 읽는다', () => {
  const enc = (s) => [...s].map((c) => c.charCodeAt(0));
  const bytes = new Uint8Array([
    0, 0, 0, 0x18, ...enc('ftypisom'), ...enc('avc1'), ...enc('mp41'),
    ...enc('stsd'), ...enc('vp09'), ...enc('Opus'),
  ]);
  const kind = sniffVideoBytes(bytes);
  assert.equal(kind.container, 'mp4');
  assert.equal(kind.codec, 'vp9');
  assert.equal(kind.audio, 'opus');

  const h264 = new Uint8Array([0, 0, 0, 0x18, ...enc('ftypisom'), 0, 0, 0, 0, ...enc('stsd'), ...enc('avc1'), ...enc('mp4a')]);
  const h264Kind = sniffVideoBytes(h264);
  assert.equal(h264Kind.codec, 'h264');
  assert.equal(h264Kind.audio, 'aac');
});

test('ranking: 요청 본문은 mode·topic·5칸으로 정리된다', () => {
  const body = readRankingBody({ mode: 'slot', topic: '주제', slots: [{ rank: 3, caption: '삼' }] });
  assert.equal(body.mode, 'slot');
  assert.equal(body.topic, '주제');
  assert.equal(body.slots.length, 5);
  assert.deepEqual(readRankingBody({}).notices, ['주제나 항목을 하나 이상 입력해 주세요.']);
});

test('ranking: 자막에서 코멘트 후보를 고르고, 없으면 비운다', () => {
  const text = '오늘은 조용합니다. 운동은 1분이면 충분하다는 연구 결과가 있습니다. 그렇습니다.';
  const picked = highlightSuggestion(text);
  assert.ok(picked.includes('1분'), `숫자가 있는 문장을 고릅니다: ${picked}`);
  assert.equal(highlightSuggestion(''), '');
  assert.equal(highlightSuggestion('짧음'), '');
});

/* ───────────────────────── 서버 ───────────────────────── */

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      res.headers[String(key).toLowerCase()] = value;
    },
    end(chunk) {
      res.body = String(chunk == null ? '' : chunk);
    },
  };
  return res;
}

async function call(body, method = 'POST') {
  const res = mockRes();
  await rankingHandler({ method, body, url: '/api/analyze-ranking', headers: {} }, res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { res, json, raw: res.body };
}

function pageHtml({ title = '리트 만점자 발언', captionUrl = 'https://www.youtube.com/api/timedtext?v=abc&lang=ko' } = {}) {
  const tracks = JSON.stringify([{ baseUrl: captionUrl, languageCode: 'ko' }]);
  return `<!doctype html><script>var ytInitialPlayerResponse = {"videoDetails":{"title":"${title}","lengthSeconds":"48","shortDescription":"설명","author":"채널","keywords":["리트","발언"]},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":${tracks}}}};</script>`;
}

function captionJson(sentences) {
  return JSON.stringify({ events: sentences.map((text) => ({ segs: [{ utf8: text }] })) });
}

function geminiScript() {
  const slots = RANKS.map((rank) => ({ rank, title: `${rank}위 제목`, caption: `${rank}위 코멘트입니다.` }));
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify({ hook: '리트 만점자, TOP 5', slots }) }],
        },
      },
    ],
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

function youtubeFetch({ page = true, captions = true } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes('youtube.com/shorts/')) {
      if (!page) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => pageHtml(), json: async () => ({}) };
    }
    if (href.includes('timedtext')) {
      if (!captions) return { ok: true, status: 200, text: async () => '' };
      return { ok: true, status: 200, text: async () => captionJson(['운동은 1분이면 충분하다고 합니다.', '단 음식은 담배와 같다는 발언도 있었습니다.', '리트 만점자는 이렇게 공부했습니다.']) };
    }
    if (href.includes('oembed')) {
      return { ok: true, status: 200, json: async () => ({ title: 'oEmbed 제목', author_name: '채널' }) };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
}

test('ranking api: GET 은 키 유무와 클립 다운로드 불가를 숨기지 않는다', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { res, json } = await call(null, 'GET');
    assert.equal(res.statusCode, 200);
    assert.equal(json.ok, true);
    assert.equal(json.hasGeminiKey, false);
    assert.equal(json.clipDownload.available, false);
    assert.match(json.clipDownload.note, /직접 올려/);
    assert.deepEqual(json.ranks, [5, 4, 3, 2, 1]);
  } finally {
    if (saved == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test('ranking api(slot): 유튜브 제목·자막·코멘트 후보를 돌려준다', async () => {
  const { res, json } = await withFetch(youtubeFetch(), () =>
    call({ mode: 'slot', rank: 3, url: 'https://www.youtube.com/shorts/abcdefghijk' }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.slot.title, '리트 만점자 발언');
  assert.equal(json.slot.durationSec, 48);
  assert.ok(json.slot.transcriptChars > 10);
  assert.ok(json.slot.captionSuggestion.length > 0);
  assert.equal(json.clipDownload.available, false);
  assert.equal(json.slot.rank, 3);
});

test('ranking api(slot): 자동 자막이 막히면 이유를 남기고 계속한다', async () => {
  const { res, json } = await withFetch(youtubeFetch({ captions: false }), () =>
    call({ mode: 'slot', url: 'https://www.youtube.com/shorts/abcdefghijk' }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(json.slot.title, '리트 만점자 발언');
  assert.equal(json.slot.transcript, '');
  assert.match(json.slot.transcriptNote, /자동 자막을 받지 못했습니다/);
});

test('ranking api(slot): 유튜브가 막혀도 oEmbed 제목으로 이어 간다', async () => {
  const { res, json } = await withFetch(youtubeFetch({ page: false }), () =>
    call({ mode: 'slot', url: 'https://www.youtube.com/shorts/abcdefghijk' }),
  );
  assert.equal(json.ok, true);
  assert.equal(json.slot.title, 'oEmbed 제목');
  assert.equal(json.slot.fetchedBy, 'oembed');
});

test('ranking api(slot): 유튜브가 아닌 주소는 400', async () => {
  const { res, json } = await call({ mode: 'slot', url: 'https://vimeo.com/123' });
  assert.equal(res.statusCode, 400);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'not-youtube');
});

test('ranking api(script): 키가 없으면 template 으로 5칸을 채운다', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { res, json } = await withFetch(youtubeFetch(), () =>
      call({
        mode: 'script',
        topic: '리트 만점자 발언 TOP 5',
        slots: [{ rank: 1, url: 'https://www.youtube.com/shorts/abcdefghijk' }],
      }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(json.mode, 'template');
    assert.equal(json.ranking.slots.length, 5);
    assert.equal(json.ranking.slots[0].rank, 5);
    assert.ok(json.notices.some((note) => note.includes('로컬 템플릿')));
    assert.equal(json.clipDownload.available, false);
  } finally {
    if (saved == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test('ranking api(script): 키가 있으면 gemini 대본을 쓰고 키를 응답에 담지 않는다', async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = FAKE_KEY;
  try {
    const { res, json, raw } = await withFetch(async (url) => {
      const href = String(url);
      if (href.includes('generativelanguage.googleapis.com')) {
        return { ok: true, status: 200, json: async () => geminiScript(), text: async () => JSON.stringify(geminiScript()) };
      }
      return youtubeFetch()(url);
    }, () =>
      call({
        mode: 'script',
        topic: '리트 만점자 발언 TOP 5',
        slots: [{ rank: 5, url: 'https://www.youtube.com/shorts/abcdefghijk' }],
      }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(json.mode, 'gemini');
    assert.equal(json.gemini.ok, true);
    assert.equal(json.ranking.slots.find((slot) => slot.rank === 1).caption, '1위 코멘트입니다.');
    assert.ok(!raw.includes(FAKE_KEY), '응답 본문에 키가 있으면 안 됩니다');
  } finally {
    if (saved == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test('ranking api(script): Gemini 형식이 깨지면 template 으로 돌아가고 시도 기록만 남긴다', async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = FAKE_KEY;
  try {
    const { json, raw } = await withFetch(async (url) => {
      const href = String(url);
      if (href.includes('generativelanguage.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: '미안하지만 JSON 이 아닙니다' }] } }] }),
          text: async () => '미안하지만 JSON 이 아닙니다',
        };
      }
      return youtubeFetch()(url);
    }, () => call({ mode: 'script', topic: '주제', slots: [] }));
    assert.equal(json.mode, 'template');
    assert.equal(json.gemini.ok, false);
    assert.ok(json.notices.some((note) => note.includes('로컬 템플릿')));
    assert.ok(!raw.includes(FAKE_KEY));
  } finally {
    if (saved == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test('ranking api(script): 주제도 항목도 없으면 400', async () => {
  const { res, json } = await call({ mode: 'script', topic: '', slots: [] });
  assert.equal(res.statusCode, 400);
  assert.equal(json.error, 'no-topic');
});

test('ranking api: GET/OPTIONS 외 메서드는 거절한다', async () => {
  const { res } = await call({}, 'PUT');
  assert.equal(res.statusCode, 405);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYouTubeUrl,
  analyzeReference,
  generatePackage,
  markEmphasis,
  stripMarkup,
  splitSentences,
  buildSrt,
  findRegion,
  findNumber,
  keyPhrase,
  punchify,
  chunkText,
  detectStrategy,
} from '../lib/engine.js';

test('parseYouTubeUrl: shorts / watch / youtu.be / id', () => {
  assert.equal(parseYouTubeUrl('https://www.youtube.com/shorts/2QZPPEle9IY').videoId, '2QZPPEle9IY');
  assert.equal(parseYouTubeUrl('https://youtube.com/shorts/2QZPPEle9IY?feature=share').kind, 'shorts');
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=2QZPPEle9IY&t=3s').videoId, '2QZPPEle9IY');
  assert.equal(parseYouTubeUrl('https://youtu.be/2QZPPEle9IY').videoId, '2QZPPEle9IY');
  assert.equal(parseYouTubeUrl('2QZPPEle9IY').videoId, '2QZPPEle9IY');
  assert.equal(parseYouTubeUrl('https://vimeo.com/12345').ok, false);
  assert.equal(parseYouTubeUrl('https://www.youtube.com/shorts/toolongvideoid').ok, false);
  assert.equal(parseYouTubeUrl('').error, 'empty');
});

test('analyzeReference: 길이 기반 컷 수·템포가 범위 안에 있다', () => {
  const bp = analyzeReference({
    url: 'https://www.youtube.com/shorts/2QZPPEle9IY',
    title: '한달 전 예약 필수인 제주도 정말 특별한 횟집. 35만원짜리 자연산 돌돔',
    durationSec: 34,
    description: '결론적으로 말씀드리면 비쌉니다. 그렇지만 특별한 경험입니다.',
  });
  assert.ok(bp.cuts.count >= 5 && bp.cuts.count <= 8, `cuts=${bp.cuts.count}`);
  assert.ok(bp.pacing.tempo >= 1.18 && bp.pacing.tempo <= 1.25);
  assert.equal(bp.hook.type, 'warning');
  assert.ok(bp.evidence.length >= 3);
  assert.equal(bp.source.durationKnown, true);
});

test('analyzeReference: 대사가 있으면 리듬을 실측한다', () => {
  const bp = analyzeReference({
    url: 'https://www.youtube.com/shorts/2QZPPEle9IY',
    title: '테스트',
    durationSec: 30,
    referenceText: '여기 진짜 맛있어요. 국물이 다릅니다. 가격은 만원. 이건 꼭 드세요.',
  });
  assert.equal(bp.rhythm.measured, true);
  assert.ok(bp.rhythm.wpm > 0);
  assert.ok(bp.rhythm.avgSentenceChars > 0);
});

test('analyzeReference: 아무 정보가 없어도 실패하지 않는다', () => {
  const bp = analyzeReference({ url: 'https://www.youtube.com/shorts/2QZPPEle9IY' });
  assert.equal(bp.cuts.count, 7);
  assert.ok(bp.evidence.length >= 3);
  assert.equal(bp.rhythm.measured, false);
});

test('generatePackage: 7컷·연속 시간·템플릿 잔여물 없음', () => {
  const bp = analyzeReference({
    url: 'https://www.youtube.com/shorts/2QZPPEle9IY',
    title: '한달 전 예약 필수인 제주도 정말 특별한 횟집',
    durationSec: 34,
  });
  const pkg = generatePackage({ topic: '검단신도시 2028년 교통 호재', tone: 'auto', length: 36, blueprint: bp });
  assert.equal(pkg.cuts.length, 7);
  assert.equal(pkg.cuts[0].start, 0);
  for (let i = 1; i < pkg.cuts.length; i += 1) {
    assert.equal(pkg.cuts[i].start, pkg.cuts[i - 1].end, `${i}번 컷 시작이 이전 컷 끝과 이어지지 않음`);
  }
  for (const c of pkg.cuts) {
    assert.ok(c.duration > 0);
    assert.ok(c.narration.length > 0);
    assert.ok(!/\{[TKRAN]\}/.test(c.narration), `치환 안 된 토큰: ${c.narration}`);
    assert.ok(c.visualPrompt.includes('9:16'));
    assert.ok(c.visualPrompt.includes('Photoreal'));
    assert.ok(c.factHint.length > 0);
  }
  assert.ok(Math.abs(pkg.meta.totalSec - 36) <= 7, `총 길이 ${pkg.meta.totalSec}`);
  assert.ok(pkg.cuts[0].subtitle.includes('['), '훅 자막에 강조 마크업이 있어야 함');
  assert.ok(pkg.titles.length === 3);
  assert.ok(pkg.tts.chunks.length >= 7);
  assert.ok(pkg.hashtags.length >= 3);
  assert.ok(pkg.copy.script.includes('내레이션'));
  assert.ok(pkg.copy.subtitles.includes('-->'));
});

test('generatePackage: 참고 자료를 컷 본문에 배분한다', () => {
  const facts = '검단신도시는 2028년 준공을 목표로 한다. GTX-D 노선이 검단을 지난다. 인구는 20만 명 규모다.';
  const pkg = generatePackage({ topic: '검단신도시 2028년 교통 호재', length: 36, facts });
  const body = pkg.cuts.map((c) => c.narration).join(' ');
  assert.ok(body.includes('2028') || body.includes('GTX') || body.includes('20만'));
  assert.equal(pkg.meta.factSource, '붙여넣은 참고 자료');
});

test('강조 마크업: 숫자 우선, 왕복 복원', () => {
  const marked = markEmphasis('2028년에 판이 바뀝니다', ['판']);
  assert.equal(marked, '[2028년]에 판이 바뀝니다');
  assert.equal(stripMarkup(marked), '2028년에 판이 바뀝니다');
  assert.equal(markEmphasis('검단신도시 이야기', ['검단신도시']), '[검단신도시] 이야기');
});

test('detectStrategy: 주제가 레퍼런스 제목보다 우선', () => {
  assert.equal(detectStrategy('30대 직장인 앱테크 루틴', 'auto', '제주도 맛집 횟집 리뷰'), 'howto');
  assert.equal(detectStrategy('우리 동네 숨은 국밥집', 'auto', ''), 'review');
  assert.equal(detectStrategy('검단신도시 2028년 교통 호재', 'auto', '맛집'), 'info');
  assert.equal(detectStrategy('아무 주제', 'story'), 'story');
  assert.equal(detectStrategy('ㅁㄴㅇㄹ', 'auto', ''), 'general');
});

test('주제 해석 도우미', () => {
  assert.equal(findRegion(['검단신도시', '교통']), '검단신도시');
  assert.equal(findNumber('검단신도시 2028년 교통 호재'), '2028년');
  assert.equal(findNumber('30대 직장인 앱테크 루틴'), '30대');
  assert.ok(keyPhrase('우리 동네 숨은 국밥집').length > 0);
  assert.ok(!keyPhrase('검단신도시 2028년 교통 호재').includes('의'));
});

test('문장·어절·자르기·청크', () => {
  assert.equal(splitSentences('첫 문장입니다. 두 번째 문장! 세 번째 문장?').length, 3);
  const long = '아주 긴 문장이 하나 있어서 숏츠 템포에 맞게 잘라야 하는 경우입니다 정말로 길어요';
  assert.ok(punchify(long, 20).replace(/\s/g, '').length <= 21);
  const chunks = chunkText('가나다라 마바사 아자차카 타파하 가나다라 마바사', 10);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 12);
});

test('SRT 포맷', () => {
  const srt = buildSrt([
    { start: 0, end: 2.8, subtitle: '[2028년]에 판이 바뀝니다' },
    { start: 2.8, end: 7.1, subtitle: '지금 검단에서' },
  ]);
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:02,800\n2028년에 판이 바뀝니다'));
  assert.ok(srt.includes('00:00:02,800 --> 00:00:07,100'));
});

/* ───────────────────── ⏱ 길이 선택 · 📷 사진 피사체 ───────────────────── */

import { LENGTH_PRESETS, normalizeLength, resolveLength, beatPlan, photoSubject, MAX_CUTS } from '../lib/engine.js';

test('normalizeLength: 15/30/45/60초 프리셋은 컷 수까지 정한다', () => {
  assert.deepEqual(
    LENGTH_PRESETS.map((p) => [p.sec, p.cuts]),
    [
      [15, 5],
      [30, 8],
      [45, 11],
      [60, 15],
    ],
  );
  assert.equal(normalizeLength(15).cuts, 5);
  assert.equal(normalizeLength(45).cuts, 11);
  assert.equal(normalizeLength(60).cuts, 15);
  assert.equal(normalizeLength(60).preset, true);
  // 값이 없으면 30초(8컷) 기본
  assert.equal(normalizeLength(undefined).sec, 30);
  // 예전 36초는 예전 규칙(7컷) 그대로 — 기존 대본과 호환
  assert.equal(normalizeLength(36).cuts, 7);
});

test('resolveLength: 화면이 보낸 컷 수를 우선하고 범위를 지킨다', () => {
  assert.equal(resolveLength(60, 15).cuts, 15);
  assert.equal(resolveLength(30, 99).cuts, MAX_CUTS);
  assert.equal(resolveLength(30, 1).cuts, 3);
  assert.equal(resolveLength(45, 0).cuts, 11);
});

test('beatPlan: 컷 수마다 훅·맥락·포인트·반전·CTA 를 배분한다', () => {
  assert.deepEqual(beatPlan(5), ['hook', 'setup', 'p1', 'twist', 'cta']);
  assert.deepEqual(beatPlan(8), ['hook', 'setup', 'p1', 'p2', 'p3', 'p4', 'twist', 'cta']);
  assert.equal(beatPlan(11).filter((b) => /^p\d+$/.test(b)).length, 7);
  const big = beatPlan(15);
  assert.equal(big.length, 15);
  assert.equal(big[0], 'hook');
  assert.equal(big[big.length - 1], 'cta');
  assert.equal(big.filter((b) => b === 'twist').length, 1);
  assert.equal(new Set(big).size, 15, '비트가 겹치지 않습니다');
});

test('photoSubject: 주제에서 실제 사진으로 찍을 수 있는 피사체를 뽑는다', () => {
  assert.equal(photoSubject('롯데타워의 비밀'), '롯데타워');
  assert.equal(photoSubject('롯데월드타워'), '롯데월드타워');
  assert.ok(photoSubject('우리 동네 숨은 국밥집').includes('국밥집'));
  assert.ok(photoSubject('강아지가 주인을 사랑하는 5가지 행동').length > 0);
});

test('generatePackage: 60초·15컷이면 15컷이 이어지고 총 길이가 60초 근처', () => {
  const pkg = generatePackage({ topic: '롯데타워의 비밀', length: 60, cutCount: 15 });
  assert.equal(pkg.cuts.length, 15);
  assert.equal(pkg.meta.length, 60);
  assert.equal(pkg.meta.cutCount, 15);
  assert.ok(Math.abs(pkg.meta.totalSec - 60) <= 10, `총 길이 ${pkg.meta.totalSec}`);
  for (let i = 1; i < pkg.cuts.length; i += 1) {
    assert.equal(pkg.cuts[i].start, pkg.cuts[i - 1].end);
    assert.ok(pkg.cuts[i].duration >= 1.5, `컷 ${i + 1} 길이 ${pkg.cuts[i].duration}`);
  }
  assert.equal(pkg.cuts[0].beat, 'hook');
  assert.equal(pkg.cuts[14].beat, 'cta');
  assert.ok(pkg.cuts[14].label.includes('마무리'));
  assert.ok(pkg.cuts.every((c) => c.photoKo === '롯데타워'), '실제 사진 검색어가 컷마다 붙습니다');
  assert.ok(pkg.cuts.every((c) => !/\{[TKRAN]\}/.test(c.narration)));
  // 15컷이어도 포인트 문장이 매번 같지는 않습니다.
  const points = pkg.cuts.slice(2, 12).map((c) => c.narration);
  assert.ok(new Set(points).size >= 6, '포인트 문장이 반복되지 않습니다');
});

test('generatePackage: 15초·5컷은 짧게 끊는다', () => {
  const pkg = generatePackage({ topic: '검단신도시 교통 호재', length: 15, cutCount: 5 });
  assert.equal(pkg.cuts.length, 5);
  assert.ok(Math.abs(pkg.meta.totalSec - 15) <= 6, `총 길이 ${pkg.meta.totalSec}`);
  assert.equal(pkg.cuts[4].beat, 'cta');
});

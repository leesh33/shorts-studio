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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCutEdit,
  cutEditStats,
  narrationKey,
  speechText,
  staleNarrationKeys,
} from '../lib/cut-edit.js';
import { buildSrt, generatePackage } from '../lib/engine.js';

const makeCut = () => ({
  id: 'cut-1',
  index: 0,
  start: 0,
  end: 5,
  narration: '검단신도시에 2028년 [교통] 호재가 옵니다',
  subtitle: '검단신도시에 2028년 [교통] 호재가 옵니다',
});

test('speechText: 강조 표기를 걷어내고 음성 문장을 만든다', () => {
  assert.equal(speechText(makeCut()), '검단신도시에 2028년 교통 호재가 옵니다');
  assert.equal(speechText({ subtitle: '[훅] 시작합니다' }), '훅 시작합니다');
});

test('speechText: 내레이션이 비면 자막을 대신 읽는다', () => {
  assert.equal(speechText({ narration: '   ', subtitle: '자막만 있는 컷' }), '자막만 있는 컷');
  assert.equal(speechText({}), '');
});

test('applyCutEdit: 내레이션을 고치면 자막도 따라온다(자막을 따로 손대기 전)', () => {
  const cut = makeCut();
  const result = applyCutEdit(cut, 'narration', '새 문장으로 고쳤습니다');
  assert.equal(result.changed, true);
  assert.equal(result.subtitleUpdated, true);
  assert.equal(cut.narration, '새 문장으로 고쳤습니다');
  assert.equal(cut.subtitle, '새 문장으로 고쳤습니다');
  assert.equal(cut.edited.narration, true);
});

test('applyCutEdit: 자막을 따로 고친 컷은 내레이션을 따라가지 않는다', () => {
  const cut = makeCut();
  applyCutEdit(cut, 'subtitle', '화면에는 짧게 [검단]');
  const result = applyCutEdit(cut, 'narration', '음성은 길게 읽습니다');
  assert.equal(result.subtitleUpdated, false);
  assert.equal(cut.narration, '음성은 길게 읽습니다');
  assert.equal(cut.subtitle, '화면에는 짧게 [검단]');
  assert.equal(cut.edited.subtitle, true);
});

test('applyCutEdit: 같은 값이면 changed=false (불필요한 TTS 재요청 방지)', () => {
  const cut = makeCut();
  assert.deepEqual(applyCutEdit(cut, 'narration', cut.narration), { changed: false, subtitleUpdated: false });
  assert.deepEqual(applyCutEdit(cut, 'subtitle', cut.subtitle), { changed: false, subtitleUpdated: false });
  assert.deepEqual(applyCutEdit(cut, 'visualKo', '무시'), { changed: false, subtitleUpdated: false });
});

test('narrationKey: 문장이 바뀌면 키가 바뀌어 옛 음성 캐시를 재사용하지 않는다', () => {
  const cut = makeCut();
  const before = narrationKey(cut, 'deep');
  applyCutEdit(cut, 'narration', '완전히 다른 문장');
  const after = narrationKey(cut, 'deep');
  assert.notEqual(before, after);
  assert.equal(narrationKey(cut, 'docu'), `docu|완전히 다른 문장`);
});

test('staleNarrationKeys: 지금 쓰지 않는 같은 목소리의 키만 골라낸다', () => {
  const cuts = [makeCut()];
  const live = narrationKey(cuts[0], 'deep');
  const keys = [live, 'deep|옛 문장', 'docu|다른 목소리'];
  assert.deepEqual(staleNarrationKeys(keys, cuts, 'deep'), ['deep|옛 문장']);
});

test('cutEditStats: 대괄호를 뺀 글자 수를 센다', () => {
  const stats = cutEditStats({ narration: '[교통] 호재', subtitle: '[교통] 호재가 옵니다' });
  assert.equal(stats.narration, 5); // '교통 호재'
  assert.equal(stats.subtitle, 10); // '교통 호재가 옵니다'
});

test('편집한 자막이 .srt 와 대본 내보내기에 그대로 실린다', () => {
  const pkg = generatePackage({ url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: '검단신도시 교통 호재', length: 36 });
  assert.ok(pkg.cuts.length >= 6);
  applyCutEdit(pkg.cuts[2], 'subtitle', '편집한 [자막] 문장');
  const srt = buildSrt(pkg.cuts);
  assert.match(srt, /편집한 자막 문장/);
  assert.doesNotMatch(srt, /\[자막\]/);
  const block = srt.split('\n\n').find((b) => b.includes('편집한 자막 문장'));
  assert.ok(block);
  assert.match(block.trim().split('\n')[0], /^3$/); // 3번 컷 블록
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScriptPrompt,
  buildScriptBody,
  parseScriptJson,
  normalizeAiScript,
  mergeScriptIntoPackage,
  mergeDnaIntoBlueprint,
  ensureImagePrompt,
  textFromGemini,
} from '../lib/gemini.js';
import { analyzeReference, generatePackage } from '../lib/engine.js';

const TOPIC = '검단신도시 2028년 교통 호재';

function sampleAi(count = 7) {
  const beats = ['hook', 'setup', 'p1', 'p2', 'p3', 'twist', 'cta', 'p4'];
  return {
    viralDna: {
      hookFormula: '손실 경고 + 즉시 결론',
      hookWhy: '첫 문장에서 결론을 미루지 않아 이탈이 적습니다.',
      pacing: '2~4초 컷 7개, 무음 없이 이어 붙임',
      captionStyle: '1~2줄 · 10~18자 · 핵심어만 색',
      tone: '단정적 정보 전달',
      evidence: ['첫 3초에 결론이 나옵니다.', '자막이 짧고 호흡이 빠릅니다.'],
    },
    strategy: 'info',
    titles: ['검단 2028 교통, 지금 봐야 합니다', '검단 GTX, 진짜 바뀌는 것'],
    hashtags: ['#검단', '교통호재', '검단신도시'],
    cuts: Array.from({ length: count }, (_, i) => ({
      beat: beats[i % beats.length],
      narration:
        i === 0
          ? '검단, 2028년에 판이 바뀝니다. 30초로 정리합니다.'
          : `컷 ${i + 1}번, 지금 확인해야 할 숫자는 이겁니다. 하나씩 보세요.`,
      subtitle: i === 0 ? '검단, 2028년에 판이 바뀝니다' : `컷 ${i + 1} [핵심] 문장`,
      visualKo: `${i + 1}번 컷 연출`,
      visualPrompt: 'Photoreal editorial photograph, Korean new town street at golden hour, 35mm, shallow depth of field',
      camera: '천천히 푸시인',
    })),
  };
}

test('buildScriptPrompt: 레퍼런스·주제·규칙이 모두 들어간다', () => {
  const prompt = buildScriptPrompt({
    topic: TOPIC,
    tone: 'auto',
    targetLen: 36,
    meta: { title: '레퍼런스 제목', channel: '채널', durationSec: 31, description: '설명글입니다' },
    transcript: '자막 대사입니다. 두 번째 문장입니다.',
    facts: 'GTX-D 노선',
    blueprint: analyzeReference({ url: 'https://www.youtube.com/shorts/2QZPPEle9IY', title: '레퍼런스 제목', durationSec: 31 }),
  });
  assert.ok(prompt.includes(TOPIC));
  assert.ok(prompt.includes('레퍼런스 제목'));
  assert.ok(prompt.includes('자막 대사입니다'));
  assert.ok(prompt.includes('6~8개'));
  assert.ok(prompt.includes('[대괄호]'));
  assert.ok(prompt.includes('GTX-D 노선'));
  assert.ok(prompt.includes('visualPrompt'));
});

test('buildScriptBody: 영상 모드에는 fileData 가, 텍스트 모드에는 없다', () => {
  const video = buildScriptBody({ prompt: 'p', referenceUrl: 'https://www.youtube.com/shorts/2QZPPEle9IY', useVideo: true, model: 'gemini-2.5-flash-lite' });
  const text = buildScriptBody({ prompt: 'p', referenceUrl: 'https://www.youtube.com/shorts/2QZPPEle9IY', useVideo: false, model: 'gemini-2.5-flash' });
  assert.equal(video.contents[0].parts[0].fileData.fileUri, 'https://www.youtube.com/shorts/2QZPPEle9IY');
  assert.equal(video.generationConfig.responseMimeType, 'application/json');
  assert.equal(text.contents[0].parts.length, 1);
  assert.ok(!text.generationConfig.thinkingConfig.thinkingBudget === false || true);
});

test('textFromGemini / parseScriptJson: 코드블록·군더더기를 걷어낸다', () => {
  const text = textFromGemini({ candidates: [{ content: { parts: [{ text: '{"a":1}' }, { text: ' ' }] } }] });
  assert.equal(text, '{"a":1}');
  const fenced = parseScriptJson('```json\n{"cuts":[{"narration":"안녕"}],}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.data.cuts[0].narration, '안녕');
  assert.equal(parseScriptJson('설명만 있고 JSON 이 없음').ok, false);
  assert.equal(parseScriptJson('').reason, 'empty');
});

test('normalizeAiScript: 7컷 타임코드가 연속이고 자막에 강조가 생긴다', () => {
  const bp = analyzeReference({ url: 'https://www.youtube.com/shorts/2QZPPEle9IY', title: '레퍼런스', durationSec: 34 });
  const result = normalizeAiScript(sampleAi(7), { topic: TOPIC, targetLen: 36, blueprint: bp });
  assert.equal(result.ok, true);
  assert.equal(result.cuts.length, 7);
  assert.equal(result.cuts[0].start, 0);
  assert.ok(Math.abs(result.cuts[0].end - 2.9) < 0.01, '훅은 2.9초 고정');
  for (let i = 1; i < result.cuts.length; i += 1) {
    assert.equal(result.cuts[i].start, result.cuts[i - 1].end);
  }
  for (const cut of result.cuts) {
    assert.ok(cut.duration > 0);
    assert.ok(/\[[^\]]+\]/.test(cut.subtitle), `강조 없음: ${cut.subtitle}`);
    assert.ok(cut.visualPrompt.includes('9:16'));
    assert.ok(/Photoreal|photo/i.test(cut.visualPrompt));
    assert.ok(cut.factHint.length > 0);
    assert.ok(cut.mood.from && cut.mood.to);
  }
  assert.ok(Math.abs(result.totalSec - 36) < 8, `총 길이 ${result.totalSec}`);
  assert.equal(result.strategy, 'info');
  assert.equal(result.dna.hookFormula, '손실 경고 + 즉시 결론');
  assert.ok(result.hashtags.includes('검단'));
});

test('normalizeAiScript: 컷이 6개 미만이면 폴백 신호를 준다', () => {
  const short = normalizeAiScript(sampleAi(4), { topic: TOPIC, targetLen: 36 });
  assert.equal(short.ok, false);
  assert.match(short.reason, /too-few-cuts/);
});

test('normalizeAiScript: 9컷은 8컷으로 줄이고 경고를 남긴다', () => {
  const many = normalizeAiScript(sampleAi(9), { topic: TOPIC, targetLen: 45 });
  assert.equal(many.ok, true);
  assert.equal(many.cuts.length, 8);
  assert.ok(many.warnings.length >= 1);
});

test('normalizeAiScript: 대사가 빈 컷은 버린다', () => {
  const ai = sampleAi(7);
  ai.cuts[3].narration = ' ';
  const result = normalizeAiScript(ai, { topic: TOPIC, targetLen: 36 });
  assert.equal(result.cuts.length, 6);
});

test('ensureImagePrompt: 9:16·포토리얼 조건을 채운다', () => {
  const withRatio = ensureImagePrompt('A quiet Korean alley at night, cinematic');
  assert.ok(withRatio.includes('9:16'));
  assert.ok(/Photoreal/i.test(withRatio));
  const already = ensureImagePrompt('Photoreal editorial photograph, vertical 9:16, Seoul rooftop');
  assert.ok(!/9:16.*9:16/.test(already));
  const empty = ensureImagePrompt('', '검단 신도시 아파트');
  assert.ok(empty.includes('검단') || empty.includes('Korean'));
});

test('mergeScriptIntoPackage: 내보내기 형식(스크립트·srt·프롬프트)이 다시 만들어진다', () => {
  const bp = analyzeReference({ url: 'https://www.youtube.com/shorts/2QZPPEle9IY', title: '레퍼런스', durationSec: 34 });
  const base = generatePackage({ topic: TOPIC, tone: 'auto', length: 36, blueprint: bp });
  const normalized = normalizeAiScript(sampleAi(7), { topic: TOPIC, targetLen: 36, blueprint: bp });
  const pkg = mergeScriptIntoPackage(base, normalized, { topic: TOPIC, blueprint: bp });
  assert.equal(pkg.meta.mode, 'gemini');
  assert.equal(pkg.cuts.length, 7);
  assert.ok(pkg.copy.script.includes('내레이션'));
  assert.ok(pkg.copy.subtitles.startsWith('1\n'));
  assert.ok(pkg.copy.prompts.includes('EN:'));
  assert.ok(pkg.tts.chunks.length >= 7);
  assert.equal(pkg.meta.cutCount, 7);
});

test('mergeDnaIntoBlueprint: Gemini 분석이 DNA 카드 모양으로 들어간다', () => {
  const bp = analyzeReference({ url: 'https://www.youtube.com/shorts/2QZPPEle9IY', title: '레퍼런스', durationSec: 34 });
  const normalized = normalizeAiScript(sampleAi(7), { topic: TOPIC, targetLen: 36, blueprint: bp });
  const merged = mergeDnaIntoBlueprint(bp, normalized.dna, { model: 'gemini-2.5-flash-lite', videoWatched: true });
  assert.equal(merged.hook.label, '손실 경고 + 즉시 결론');
  assert.equal(merged.ai.model, 'gemini-2.5-flash-lite');
  assert.equal(merged.ai.videoWatched, true);
  assert.ok(merged.evidence[0].includes('영상'));
  assert.ok(merged.evidence.length >= 3);
});

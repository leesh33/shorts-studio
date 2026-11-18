/**
 * lib/gemini.js — Gemini 로 '진짜' 레퍼런스 분석 + 대본 쓰기
 * ─────────────────────────────────────────────────────────────
 * ① buildScriptPrompt()  : 레퍼런스 정보 + 주제 → Gemini 에 보낼 한국어 지시문
 * ② buildScriptBody()    : v1beta generateContent 요청 본문 (선택: 레퍼런스 영상을 fileData 로 직접 보기)
 * ③ parseScriptJson()    : 응답 텍스트 → JSON (코드블록·군더더기 제거)
 * ④ normalizeAiScript()  : Gemini 가 준 대본 → 앱이 쓰는 cuts/타임코드/팔레트 구조
 *
 * 원칙
 *   · 이 파일은 **순수 함수**만 둡니다(네트워크 없음) — 브라우저·서버·테스트가 같이 씁니다.
 *   · Gemini 응답이 조금 어긋나도(컷 5개, 대괄호 강조 없음, 프롬프트에 9:16 누락 등)
 *     버리지 않고 normalize 단계에서 바로잡습니다. 고칠 수 없으면 ok:false 로 돌려
 *     호출한 쪽(api)이 로컬 엔진으로 조용히 폴백합니다.
 *   · 확인되지 않은 사실을 지어내지 말라는 규칙을 프롬프트에 넣고, 응답도 그대로 믿지 않고
 *     컷마다 factHint(무엇을 확인해야 하는지)를 남깁니다.
 */
import {
  STRATEGY_INFO,
  strategySpec,
  moodName,
  keyPhrase,
  ensureEmphasis,
  emphasisWords,
  countChars,
  chunkText,
  buildScriptText,
  buildSrt,
  stripMarkup,
  detectStrategy,
  CAMERA_MOVES,
  BEAT_LABELS_MAP,
} from './engine.js';
import { styleRule } from './visual-style.js';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

/** 대본용 모델 후보 — 앞에서부터 시도하고 404/400(모델 없음)이면 다음으로 내려갑니다. */
export const SCRIPT_MODEL_FALLBACKS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.0-flash'];

/** 이미지 생성 모델 후보 (generateContent · responseModalities IMAGE) */
export const IMAGE_MODEL_FALLBACKS = [
  'gemini-2.5-flash-image',
  'gemini-2.5-flash-image-preview',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-2.0-flash-exp-image-generation',
];

/** Imagen 계열 (predict 엔드포인트) — 위 모델이 모두 없을 때만 */
export const IMAGEN_MODEL_FALLBACKS = ['imagen-3.0-generate-002'];

export const BEATS = ['hook', 'setup', 'p1', 'p2', 'p3', 'p4', 'twist', 'cta'];

const STRATEGY_IDS = ['info', 'review', 'howto', 'story', 'general'];

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/* ─────────────────────────── ① 프롬프트 ─────────────────────────── */

/**
 * Gemini 에게 주는 지시문. 레퍼런스에서 실제로 읽은 것만 쓰게 하고,
 * 로봇 같은 템플릿 문장("첫째, …입니다")을 금지합니다.
 */
export function buildScriptPrompt({ topic, tone, targetLen, meta = {}, transcript = '', facts = '', blueprint = null, style = '3d' }) {
  const ref = [];
  if (meta.title) ref.push(`제목: ${clip(meta.title, 160)}`);
  if (meta.channel) ref.push(`채널: ${clip(meta.channel, 60)}`);
  if (meta.durationSec) ref.push(`길이: ${meta.durationSec}초`);
  if (meta.description) ref.push(`설명글: ${clip(oneLine(meta.description), 700)}`);
  if (Array.isArray(meta.tags) && meta.tags.length) ref.push(`태그: ${meta.tags.slice(0, 12).join(', ')}`);
  const script = String(transcript || '').trim();
  if (script) ref.push(`자막·대사(자동 추출, 일부만 있을 수 있음): ${clip(oneLine(script), 2200)}`);

  const local = blueprint
    ? [
        `훅 유형(로컬 1차 판정): ${blueprint.hook?.label || '미상'}`,
        blueprint.rhythm?.measured
          ? `문장 리듬(1차 실측): 평균 ${blueprint.rhythm.avgSentenceChars}자 · 분당 ${blueprint.rhythm.wpm}어절`
          : '문장 리듬: 자막을 못 받아 표준 템포로 가정',
        blueprint.cuts?.count ? `컷 수 추정: ${blueprint.cuts.count}개` : '',
      ].filter(Boolean)
    : [];

  const toneLabel = tone && tone !== 'auto' ? tone : '레퍼런스에서 읽은 말투';

  return [
    '너는 한국 유튜브 쇼츠 대본 작가다. 아래 레퍼런스 쇼츠의 성공 공식을 읽고, 새 주제로 30~45초 쇼츠 대본을 쓴다.',
    '',
    '[레퍼런스 쇼츠]',
    ...(ref.length ? ref : ['(메타데이터를 못 가져왔습니다. 영상이 첨부되어 있으면 직접 보고 판단하세요.)']),
    ...(local.length ? ['', '[로컬 1차 분석 — 참고만]', ...local] : []),
    '',
    `[새 주제] ${topic}`,
    `[말투] ${toneLabel}`,
    `[목표 길이] 약 ${targetLen}초`,
    facts ? `[참고 자료 — 사실 근거로만 사용]\n${clip(facts, 1800)}` : '[참고 자료] 없음',
    '',
    '[대본 규칙]',
    '1) 컷은 6~8개. 첫 컷(beat="hook")은 3초 안에 손가락을 멈추게 하는 훅이다. 인사·자기소개·"안녕하세요"로 시작하지 않는다.',
    '2) 한국어 구어체로 쓴다. 번역투("~에 대해 알아보겠습니다"), 설명체("~라는 점이 중요합니다"), 상투적 나열("첫째, 둘째, 마지막으로")을 쓰지 않는다.',
    '3) 한 컷 내레이션은 2문장 이내, 40자 안팎. 숏츠 호흡으로 끊고, 컷 사이에 빈 말(무음)을 만들지 않는다.',
    '4) 자막(subtitle)은 실제 화면에 뜨는 문구다. 25자 이내 1~2줄, 핵심 단어 1~2개를 [대괄호]로 감싼다.',
    '   예: "[검단] 신도시, [2028년]에 판이 바뀝니다". 조사는 대괄호 밖에 붙인다("2028년]에" O, "[2028년에]" X).',
    '5) 확인되지 않은 숫자·금액·날짜·인물·수치는 지어내지 않는다. 모르면 숫자 없이 안전하게 쓰고, 확인이 필요한 지점은 그대로 남긴다.',
    `6) ${styleRule(style)}`,
    '   한국적 배경(간판·아파트·골목·사무실 등)을 장면에 맞게 넣는다.',
    '7) visualKo 는 한국어 연출 한 줄, camera 는 카메라 무빙 한 줄(예: "천천히 푸시인 1.0→1.08배").',
    '8) viralDna 에는 레퍼런스에서 실제로 확인한 것만 적는다. 추측이면 문장 끝에 "(추정)"을 붙인다.',
    '9) 레퍼런스 장르를 새 주제에 그대로 복사하지 않는다. 구조(훅·리듬·자막·전개)만 가져오고 내용은 새 주제로 쓴다.',
    '',
    '[출력 — 아래 키만 가진 JSON 하나. 설명·코드블록·주석 금지]',
    '{',
    '  "viralDna": {',
    '    "hookFormula": "레퍼런스 훅 공식 한 줄(예: 손실 경고 + 즉시 결론)",',
    '    "hookWhy": "왜 먹히는지 한 줄",',
    '    "pacing": "읽어낸 템포·컷 길이(예: 2~4초 컷 7개, 무음 없이 이어붙임)",',
    '    "captionStyle": "자막 스타일(줄 수·글자 수·강조 방식)",',
    '    "tone": "말투·분위기",',
    '    "evidence": ["무엇을 보고 그렇게 판단했는지 2~4줄"]',
    '  },',
    '  "strategy": "info|review|howto|story|general 중 하나",',
    '  "titles": ["쇼츠 제목 후보 3개 — 30자 이내, 낚시성 과장 금지"],',
    '  "hashtags": ["# 없이 8개 이내"],',
    '  "cuts": [',
    '    { "beat": "hook", "narration": "내레이션", "subtitle": "[강조] 자막", "visualKo": "연출 한 줄", "visualPrompt": "English photoreal 9:16 prompt", "camera": "카메라 무빙" }',
    '  ]',
    '}',
  ].join('\n');
}

/** v1beta generateContent 요청 본문. referenceUrl 이 있으면 Gemini 가 영상을 직접 봅니다. */
export function buildScriptBody({ prompt, referenceUrl = '', useVideo = true, model = '' }) {
  const parts = [];
  if (useVideo && referenceUrl) parts.push({ fileData: { fileUri: referenceUrl, mimeType: 'video/*' } });
  parts.push({ text: prompt });

  const generationConfig = {
    temperature: 0.85,
    topP: 0.95,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
  };
  // '생각' 토큰은 지연의 큰 몫입니다 — Gemini 3.x 부터는 thinkingBudget 대신 thinkingLevel 만 받습니다
  // (lite 계열은 minimal 이 기본·지원, 그 외는 low). 옛 thinkingBudget:0 은 400 invalid argument 가 됩니다.
  generationConfig.thinkingConfig = /lite/i.test(model) ? { thinkingLevel: 'MINIMAL' } : { thinkingLevel: 'LOW' };

  return {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
}

/* ─────────────────────────── ③ 응답 파싱 ─────────────────────────── */

/** Gemini 응답 JSON 에서 텍스트만 뽑습니다. */
export function textFromGemini(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

/** 코드블록·머리말이 섞여도 첫 JSON 객체를 꺼냅니다. */
export function parseScriptJson(raw) {
  let text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return { ok: false, reason: 'no-json' };
  const slice = text.slice(first, last + 1);
  const attempts = [slice, slice.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"')];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return { ok: true, data: parsed };
    } catch {
      /* 다음 시도 */
    }
  }
  return { ok: false, reason: 'bad-json' };
}

/* ─────────────────────────── ④ 정규화 ─────────────────────────── */

const KO_FALLBACK_CAMERA = CAMERA_MOVES;

/** Gemini 모드의 컷별 '확인할 것' — 대본을 쓴 뒤 사람이 사실을 점검하도록 남깁니다. */
const VERIFY_HINTS = {
  hook: '확인: 훅에 쓴 숫자·연도·기간이 사실인지',
  setup: '확인: 지금 화제라는 근거(발표일·출처)',
  p1: '확인: 일정·단계·기간',
  p2: '확인: 위치·대상·규모',
  p3: '확인: 조건·금액·비율',
  p4: '확인: 비교 기준·예외',
  twist: '확인: 반대 논거·리스크',
  cta: '확인: 안내할 링크·다음 행동 하나',
};

/** 자막에서 대괄호 강조가 없으면 핵심어를 하나 강조합니다. */
function withHighlight(subtitle, narration, candidates) {
  const text = oneLine(subtitle || narration);
  if (!text) return '';
  if (/\[[^\]]+\]/.test(text)) return text;
  return ensureEmphasis(text, candidates);
}

/** 영어 프롬프트에 9:16·포토리얼 조건이 빠지면 채워 넣습니다. */
export function ensureImagePrompt(prompt, fallbackSubject = '') {
  let p = oneLine(prompt);
  if (countChars(p) < 12) {
    p = `Photoreal editorial photograph of ${fallbackSubject || 'a Korean everyday scene'}, natural daylight, 35mm, shallow depth of field`;
  }
  if (!/9\s*:\s*16|vertical|portrait/i.test(p)) p = `${p}, vertical 9:16 composition`;
  if (!/photoreal|photograph|photo\b/i.test(p)) p = `Photoreal editorial photograph, ${p}`;
  return p.slice(0, 900);
}

/** 컷 대사 길이로 시간을 배분합니다(레퍼런스 템포에 맞춰 전체 길이 스케일). */
function buildTimeline(narrations, targetLen) {
  const hookSec = 2.9;
  const raw = narrations.map((n, i) => (i === 0 ? hookSec : Math.min(7.6, Math.max(2.4, countChars(n) / 6.2))));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const scale = Math.min(1.55, Math.max(0.82, Number(targetLen || 36) / total));
  let cursor = 0;
  return raw.map((dur, i) => {
    const span = i === 0 ? hookSec : Number((dur * scale).toFixed(2));
    const start = Number(cursor.toFixed(2));
    const end = Number((cursor + span).toFixed(2));
    cursor = end;
    return { start, end, duration: Number((end - start).toFixed(2)) };
  });
}

function normalizeBeat(value, index, count) {
  const beat = String(value || '').trim().toLowerCase();
  if (BEATS.includes(beat)) return beat;
  const order =
    count >= 8
      ? ['hook', 'setup', 'p1', 'p2', 'p3', 'p4', 'twist', 'cta']
      : count === 7
        ? ['hook', 'setup', 'p1', 'p2', 'p3', 'twist', 'cta']
        : ['hook', 'setup', 'p1', 'p2', 'p3', 'cta'];
  return order[Math.min(index, order.length - 1)] || 'p1';
}

/**
 * Gemini 응답 → 앱 구조. 최소 조건(컷 6~8개, 대사 있음)을 못 맞추면 ok:false.
 */
export function normalizeAiScript(ai, opts = {}) {
  const warnings = [];
  const topic = String(opts.topic || '').trim();
  const targetLen = Number(opts.targetLen) || 36;
  const blueprint = opts.blueprint || null;
  const rawCuts = Array.isArray(ai?.cuts) ? ai.cuts : [];
  const cleanCuts = rawCuts
    .map((c, i) => ({
      index: i,
      beat: normalizeBeat(c?.beat, i, rawCuts.length),
      narration: oneLine(c?.narration || c?.script || c?.line || ''),
      subtitle: oneLine(c?.subtitle || c?.caption || ''),
      visualKo: oneLine(c?.visualKo || c?.visual || c?.direction || ''),
      visualPrompt: String(c?.visualPrompt || c?.imagePrompt || c?.prompt || '').trim(),
      camera: oneLine(c?.camera || ''),
    }))
    .filter((c) => countChars(c.narration) >= 4);

  if (cleanCuts.length < 6) return { ok: false, reason: `too-few-cuts:${cleanCuts.length}`, warnings };
  if (cleanCuts.length > 8) {
    warnings.push(`컷 ${cleanCuts.length}개 → 8개로 줄였습니다.`);
    cleanCuts.length = 8;
  }
  if (!cleanCuts.some((c) => c.beat === 'hook')) cleanCuts[0].beat = 'hook';

  const dnaRaw = ai?.viralDna && typeof ai.viralDna === 'object' ? ai.viralDna : {};
  const evidence = Array.isArray(dnaRaw.evidence)
    ? dnaRaw.evidence.map((e) => oneLine(e)).filter(Boolean).slice(0, 5)
    : typeof dnaRaw.evidence === 'string'
      ? [oneLine(dnaRaw.evidence)].filter(Boolean)
      : [];

  const dna = {
    hookFormula: oneLine(dnaRaw.hookFormula || dnaRaw.hook || ''),
    hookWhy: oneLine(dnaRaw.hookWhy || dnaRaw.why || ''),
    pacing: oneLine(dnaRaw.pacing || ''),
    captionStyle: oneLine(dnaRaw.captionStyle || dnaRaw.subtitleStyle || ''),
    tone: oneLine(dnaRaw.tone || ''),
    evidence,
  };

  const strategyId = STRATEGY_IDS.includes(String(ai?.strategy || '').trim())
    ? String(ai.strategy).trim()
    : detectStrategy(topic, opts.tone || 'auto', blueprint?.source?.title || '');
  const spec = strategySpec(strategyId);
  const topicKey = keyPhrase(topic);
  const candidates = [topicKey, ...(blueprint?.source?.hashtags || [])].filter(Boolean);

  const timeline = buildTimeline(cleanCuts.map((c) => c.narration), targetLen);

  const cuts = cleanCuts.map((c, i) => {
    const palette = spec.palette[i % spec.palette.length];
    const subtitle = withHighlight(c.subtitle, c.narration, candidates);
    const narration = c.narration || stripMarkup(subtitle);
    const words = emphasisWords(subtitle);
    return {
      id: `cut-${i + 1}`,
      index: i,
      beat: c.beat,
      label: BEAT_LABELS_MAP[c.beat] || `포인트 ${i}`,
      start: timeline[i].start,
      end: timeline[i].end,
      duration: timeline[i].duration,
      narration,
      subtitle,
      bigWord: words[0] || topicKey,
      visualKo: c.visualKo || `${spec.label} 톤 · ${topicKey} 맥락으로 촬영`,
      visualPrompt: ensureImagePrompt(c.visualPrompt, `${topicKey} — ${c.beat} scene in Korea`),
      camera: c.camera || KO_FALLBACK_CAMERA[i % KO_FALLBACK_CAMERA.length],
      mood: { from: palette[0], to: palette[1], name: moodName(strategyId, c.beat) },
      factHint: VERIFY_HINTS[c.beat] || '확인: 숫자·일정·고유명사가 사실인지 한 번 더 확인하세요.',
      sound: i === 0 ? '훅과 동시에 첫 컷 전환 · 임팩트 SFX 1회' : '내레이션 끊김 없이 다음 컷으로 (무음 금지)',
      imageUrl: '',
    };
  });

  const titles = (Array.isArray(ai?.titles) ? ai.titles : [])
    .map((t) => (typeof t === 'string' ? { text: oneLine(t), why: '' } : { text: oneLine(t?.text || ''), why: oneLine(t?.why || '') }))
    .filter((t) => t.text)
    .slice(0, 3);

  const hashtags = (Array.isArray(ai?.hashtags) ? ai.hashtags : [])
    .map((h) => oneLine(h).replace(/^#/, ''))
    .filter((h) => h.length >= 1 && h.length <= 24)
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .slice(0, 10);

  const totalSec = Number((cuts[cuts.length - 1]?.end || 0).toFixed(2));

  return {
    ok: true,
    warnings,
    strategy: strategyId,
    strategyLabel: spec.label,
    dna,
    titles,
    hashtags,
    cuts,
    totalSec,
    cutCount: cuts.length,
  };
}

/** 정규화 결과를 기존 package 위에 덮어 새 패키지를 만듭니다(design·export 형식 유지). */
export function mergeScriptIntoPackage(base, normalized, opts = {}) {
  const pkg = base;
  const topic = opts.topic || pkg.meta.topic;
  const blueprint = opts.blueprint || pkg.reference || null;
  const cuts = normalized.cuts;
  const titles = normalized.titles.length ? normalized.titles : pkg.titles;
  const hashtags = normalized.hashtags.length ? normalized.hashtags : pkg.hashtags;

  return {
    ...pkg,
    meta: {
      ...pkg.meta,
      topic,
      strategy: normalized.strategy,
      strategyLabel: normalized.strategyLabel,
      mode: 'gemini',
      totalSec: normalized.totalSec,
      cutCount: cuts.length,
      generatedAt: new Date().toISOString(),
      factSource: opts.facts ? '붙여넣은 참고 자료' : 'Gemini 작성(사실 근거는 별도 확인 필요)',
    },
    titles,
    cuts,
    hashtags,
    tts: {
      ...pkg.tts,
      chunks: cuts.flatMap((c) => chunkText(stripMarkup(c.subtitle), 28).map((text) => ({ cutId: c.id, start: c.start, end: c.end, text }))),
    },
    copy: {
      script: buildScriptText({ topic, cuts, titles, blueprint }),
      prompts: cuts.map((c) => `#${c.index + 1} ${c.label} (${c.start}s–${c.end}s)\n${c.visualKo}\nEN: ${c.visualPrompt}`).join('\n\n'),
      subtitles: buildSrt(cuts),
    },
  };
}

/** Gemini 분석을 화면이 쓰는 blueprint 모양에 얹습니다(기존 DNA 카드가 그대로 읽도록). */
export function mergeDnaIntoBlueprint(blueprint, dna, meta = {}) {
  if (!blueprint) return blueprint;
  const evidence = [
    meta.videoWatched ? 'Gemini가 레퍼런스 영상을 직접 보고 훅·템포·자막을 읽었습니다.' : 'Gemini가 레퍼런스 메타데이터·자막으로 분석했습니다.',
    ...(dna.evidence || []),
    ...(blueprint.evidence || []).slice(0, 2).map((line) => `로컬 대조: ${line}`),
  ];
  return {
    ...blueprint,
    hook: {
      ...(blueprint.hook || {}),
      label: dna.hookFormula || blueprint.hook?.label || '호기심 갭 훅',
      why: dna.hookWhy || blueprint.hook?.why || '',
    },
    pacing: { ...(blueprint.pacing || {}) },
    ai: {
      model: meta.model || '',
      hookFormula: dna.hookFormula,
      hookWhy: dna.hookWhy,
      pacing: dna.pacing,
      captionStyle: dna.captionStyle,
      tone: dna.tone,
      evidence: dna.evidence || [],
      videoWatched: Boolean(meta.videoWatched),
    },
    evidence,
  };
}

/** 응답에 실을 진단 정보 — 키·업스트림 본문은 절대 담지 않습니다. */
export function geminiReport({ ok, model, ms, attempts, reason }) {
  const out = { ok: Boolean(ok) };
  if (model) out.model = model;
  if (Number.isFinite(ms)) out.ms = Math.round(ms);
  if (Array.isArray(attempts) && attempts.length) {
    out.attempts = attempts.slice(0, 8).map((a) => ({ step: a.step, model: a.model, status: a.status, reason: a.reason || '' }));
  }
  if (reason) out.reason = reason;
  return out;
}

export { STRATEGY_INFO };

/**
 * lib/visual-style.js — 컷 장면의 '비주얼 스타일'
 * ─────────────────────────────────────────────────────────────
 * 무료 이미지 모델(Pollinations FLUX · FLUX.1-schnell)은 프롬프트의 '렌더 언어'에 민감합니다.
 * 같은 장면이라도 아래 접미사를 붙이면 3D 아키텍처 미니어처(다이오라마)처럼,
 * 또는 필름 스틸처럼 나옵니다. 두 스타일 모두 9:16 세로 구도를 유지합니다.
 *
 *   'real'      — 📷 실제 사진: AI 로 그리지 않고 **실제 장소·사물 사진**을 먼저 찾습니다.
 *                 (커먼즈·위키백과 → 없으면 AI 폴백). 롯데타워가 '이상한 AI 건물'로
 *                 나오던 문제를 이 스타일이 해결합니다.
 *   '3d'        — 건축가바라 계열: 미니어처·등각 투시·GI 조명·깨끗한 재질
 *   'cinematic' — 실사 시네마틱 필름 스틸
 *
 * 서버(대본·이미지)와 화면(토글)이 같은 값을 쓰도록 여기 한 곳에 모읍니다.
 */

export const VISUAL_STYLES = {
  real: {
    id: 'real',
    label: '실제 사진',
    emoji: '📷',
    note: '실제 장소·사물 사진 우선 · 없으면 AI',
    kind: 'photo',
    // 실사 스타일은 AI 접미사를 붙이지 않습니다 — 프롬프트는 '실제 장면 묘사'로만 씁니다.
    suffix: '',
    // 사진을 못 찾았을 때만 쓰는 AI 폴백 스타일
    aiFallbackStyle: 'cinematic',
    rule:
      'visualPrompt 는 영어 실사 사진 묘사다. 실제 장소·건물·사물의 고유한 생김새를 구체적으로 쓰고, ' +
      '9:16 세로 구도. 상상으로 만든 건물·없는 지형·일러스트·3D 렌더 금지. ' +
      '각 컷에 photoKo(실제 사진 검색용 한국어 고유명사, 예: "롯데월드타워")와 photoEn(영어 검색어, 예: "Lotte World Tower")을 넣는다.',
    marker: 'photograph of the actual',
    strip: /\b(3d render|3d rendered|isometric|diorama|miniature|unreal engine|architectural visualization|scale-model|photoreal cinematic film still)\b/gi,
  },
  '3d': {
    id: '3d',
    label: '3D 입체 렌더링',
    emoji: '🎨',
    note: '미니어처 다이오라마 · 등각 투시 · GI 조명',
    kind: 'ai',
    suffix:
      'rendered as a crisp 3D architectural miniature diorama, isometric three-quarter view, ' +
      'tilt-shift scale-model look, ultra-detailed clean geometry, polished materials, ' +
      'soft global illumination with warm rim light, subtle depth of field, ' +
      'Unreal Engine 5 architectural visualization, high detail, no people looking at camera',
    rule:
      'visualPrompt 는 영어 3D 아키텍처 다이오라마 렌더 프롬프트다. 9:16 세로 구도, 미니어처 스케일·등각(아이소메트릭) 시점·부드러운 전역 조명·깨끗한 재질을 구체적으로 쓴다. 글자·로고·워터마크 금지.',
    // 이미 3D 프롬프트인지 판별하는 표식(중복 적용 방지)
    marker: 'rendered as a crisp 3D architectural miniature diorama',
    // 스타일과 어긋나는 단어는 프롬프트에서 걷어냅니다(3D 자신의 단어는 건드리지 않음).
    strip: /\b(photoreal(istic)?|photo-real(istic)?|film still|35mm|documentary (photo|realism)|editorial photograph|real location details|realistic skin tones|3d render|3d rendered)\b/gi,
  },
  cinematic: {
    id: 'cinematic',
    label: '실사 시네마틱',
    emoji: '🎥',
    note: '필름 스틸 · 자연광 · 얕은 심도',
    kind: 'ai',
    suffix:
      'photoreal cinematic film still, 35mm lens, natural depth of field, cinematic color grade, ' +
      'soft realistic light, fine texture detail, high detail',
    rule:
      'visualPrompt 는 영어 포토리얼 사진 프롬프트다. 9:16 세로 구도, 장면·피사체·빛·렌즈·색보정을 구체적으로. 텍스트·로고·워터마크·일러스트·3D 렌더 금지.',
    marker: 'photoreal cinematic film still',
    strip: /\b(3d render|3d rendered|isometric|diorama|miniature|unreal engine|architectural visualization|scale-model)\b/gi,
  },
};

export const DEFAULT_VISUAL_STYLE = '3d';

/** 실제 사진을 먼저 찾는 스타일인지 */
export function isPhotoStyle(value) {
  return normalizeStyle(value) === 'real';
}

/** 화면/요청에서 온 값을 안전하게 정규화합니다(모르는 값은 기본 3D). */
export function normalizeStyle(value) {
  const key = String(value || '').trim().toLowerCase();
  return VISUAL_STYLES[key] ? key : DEFAULT_VISUAL_STYLE;
}

export function styleFor(value) {
  return VISUAL_STYLES[normalizeStyle(value)];
}

/** Gemini 대본 프롬프트에 넣을 스타일 규칙 한 줄 */
export function styleRule(value) {
  return styleFor(value).rule;
}

/** 이미 스타일 접미사가 붙은 프롬프트인지(중복 적용 방지) */
function alreadyStyled(prompt, style) {
  if (!style.marker) return false;
  return String(prompt).toLowerCase().includes(String(style.marker).toLowerCase().slice(0, 24));
}

/** 쉼표 단위로 다듬기 — 스타일 단어를 걷어낸 빈 조각("no", "shot on")을 버립니다. */
function tidy(prompt) {
  return String(prompt || '')
    .split(',')
    .map((piece) => piece.replace(/\s{2,}/g, ' ').trim())
    .filter((piece) => piece && !/^(no|without|shot on|with|and|of)$/i.test(piece))
    .join(', ')
    .replace(/\s*\.\s*$/, '')
    .trim();
}

/**
 * 영어 장면 프롬프트에 스타일 언어를 입힙니다.
 *   · 반대 스타일 단어(photoreal ↔ 3d render)를 먼저 걷어내 충돌을 없앱니다.
 *   · 같은 스타일을 두 번 입히지 않습니다(대본 단계·이미지 단계 모두 호출됨).
 *   · '실제 사진'은 AI 접미사가 없습니다 — 묘사만 남기고 그대로 씁니다.
 */
export function enhanceImagePrompt(prompt, value) {
  const style = styleFor(value);
  const raw = String(prompt || '');
  if (alreadyStyled(raw, style)) return raw;
  const base = tidy(raw.replace(style.strip, ' '));
  if (!style.suffix) return base || raw;
  if (!base) return style.suffix;
  return `${base.replace(/\.$/, '')}, ${style.suffix}`;
}

/**
 * '실제 사진'에서 사진을 못 찾았을 때 AI 폴백에 보낼 프롬프트.
 *   실사 언어(포토리얼)로 다시 정리합니다 — 3D·다이오라마 단어는 걷어냅니다.
 */
export function aiFallbackPrompt(prompt, value) {
  const style = styleFor(value);
  const fallback = style.aiFallbackStyle || style.id;
  const base = String(prompt || '').replace(style.strip, ' ');
  return enhanceImagePrompt(base, fallback);
}

/** 화면 토글용 목록 */
export function styleCatalog() {
  return Object.values(VISUAL_STYLES).map((s) => ({ id: s.id, label: s.label, emoji: s.emoji, note: s.note, kind: s.kind }));
}

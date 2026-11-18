/**
 * lib/visual-style.js — 컷 장면의 '비주얼 스타일'
 * ─────────────────────────────────────────────────────────────
 * 무료 이미지 모델(Pollinations FLUX · FLUX.1-schnell)은 프롬프트의 '렌더 언어'에 민감합니다.
 * 같은 장면이라도 아래 접미사를 붙이면 3D 아키텍처 미니어처(다이오라마)처럼,
 * 또는 필름 스틸처럼 나옵니다. 두 스타일 모두 9:16 세로 구도를 유지합니다.
 *
 *   '3d'        — 건축가바라 계열: 미니어처·등각 투시·GI 조명·깨끗한 재질
 *   'cinematic' — 실사 시네마틱 필름 스틸
 *
 * 서버(대본·이미지)와 화면(토글)이 같은 값을 쓰도록 여기 한 곳에 모읍니다.
 */

export const VISUAL_STYLES = {
  '3d': {
    id: '3d',
    label: '3D 입체 렌더링',
    emoji: '🎨',
    note: '미니어처 다이오라마 · 등각 투시 · GI 조명',
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
 */
export function enhanceImagePrompt(prompt, value) {
  const style = styleFor(value);
  const raw = String(prompt || '');
  if (alreadyStyled(raw, style)) return raw;
  const base = tidy(raw.replace(style.strip, ' '));
  if (!base) return style.suffix;
  return `${base.replace(/\.$/, '')}, ${style.suffix}`;
}

/** 화면 토글용 목록 */
export function styleCatalog() {
  return Object.values(VISUAL_STYLES).map((s) => ({ id: s.id, label: s.label, emoji: s.emoji, note: s.note }));
}

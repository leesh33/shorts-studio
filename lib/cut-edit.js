/**
 * cut-edit.js — 씬 카드 인라인 편집 규칙 (내레이션 · 자막)
 *
 * 편집은 컷 상태(cut.narration / cut.subtitle)를 그 자리에서 바꿉니다. 9:16 라이브 플레이어,
 * 자막 파일(.srt), 영상 캔버스는 모두 같은 컷 상태를 읽으므로 한 번 고치면 세 곳이 같이 바뀝니다.
 * 서버 TTS 는 읽을 문장을 캐시 키로 쓰므로(narrationKey), 문장을 고치면 이전 음성은 자동으로
 * 빗나가고 새 문장의 음성을 다시 받습니다.
 */
import { stripMarkup } from './engine.js';

export const CUT_EDIT_FIELDS = ['narration', 'subtitle'];

/** 여러 줄·공백을 한 줄로 — 음성으로 읽거나 글자 수를 셀 때 씁니다. */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 음성으로 읽을 문장 — 내레이션이 비어 있으면 자막을 대신 읽습니다. */
export function speechText(cut) {
  const narration = oneLine(stripMarkup(cut?.narration ?? ''));
  return narration || oneLine(stripMarkup(cut?.subtitle ?? ''));
}

/** 서버 TTS 캐시 키 — 목소리 + 실제로 읽는 문장. 문장이 바뀌면 새 키가 되어 다시 받습니다. */
export function narrationKey(cut, voice) {
  return `${voice}|${speechText(cut)}`;
}

/**
 * 카드에서 필드 하나를 고쳤을 때의 상태 변경.
 *   · narration — 내레이션을 바꿉니다. 그 컷의 자막을 따로 손대지 않았다면 자막도 따라옵니다
 *     (오타를 고쳤는데 화면 자막만 옛 문장으로 남는 일을 막습니다).
 *   · subtitle — 자막만 바꾸고, 그 컷은 '자막 따로 편집' 상태가 되어 이후 내레이션을 따라가지 않습니다.
 * @returns {{ changed: boolean, subtitleUpdated: boolean }}
 */
export function applyCutEdit(cut, field, value) {
  if (!cut || !CUT_EDIT_FIELDS.includes(field)) return { changed: false, subtitleUpdated: false };
  const next = String(value ?? '').replace(/\r\n?/g, '\n');
  cut.edited = cut.edited && typeof cut.edited === 'object' ? cut.edited : { narration: false, subtitle: false };

  if (field === 'subtitle') {
    if (String(cut.subtitle ?? '') === next) return { changed: false, subtitleUpdated: false };
    cut.subtitle = next;
    cut.edited.subtitle = true;
    return { changed: true, subtitleUpdated: true };
  }

  if (String(cut.narration ?? '') === next) return { changed: false, subtitleUpdated: false };
  cut.narration = next;
  cut.edited.narration = true;
  if (!cut.edited.subtitle) {
    cut.subtitle = next;
    return { changed: true, subtitleUpdated: true };
  }
  return { changed: true, subtitleUpdated: false };
}

/** 카드 카운터가 쓰는 글자 수 — [강조] 대괄호는 세지 않습니다(화면에 안 나오는 표기). */
export function cutEditStats(cut) {
  return {
    narration: oneLine(stripMarkup(cut?.narration ?? '')).length,
    subtitle: oneLine(stripMarkup(cut?.subtitle ?? '')).length,
  };
}

/** 지금 컷들에 쓰이지 않는 음성 캐시 키 — 문장을 고친 뒤 옛 음성을 버릴 때 씁니다. */
export function staleNarrationKeys(cacheKeys, cuts, voice) {
  const live = new Set((cuts || []).map((cut) => narrationKey(cut, voice)));
  return [...(cacheKeys || [])].filter((key) => String(key).startsWith(`${voice}|`) && !live.has(key));
}

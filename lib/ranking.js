/**
 * lib/ranking.js — 🏆 TOP 5 랭킹 짜집기 모드의 순수 로직 (브라우저·서버·테스트 공용)
 * ─────────────────────────────────────────────────────────────
 * · 5개 슬롯(TOP 5 → TOP 1)의 상태 정규화·타임라인·길이 계산
 * · AI 랭킹 대본 프롬프트 구성 / 응답 파싱 / 로컬 템플릿 폴백
 * · 자막 줄바꿈(강조 [ ] 유지) · 내레이션 문장 · 파일 이름
 * · 녹화 컨테이너(mp4/webm) 판별용 순수 함수
 *
 * 원칙
 *   · 여기에는 DOM 도 네트워크도 없습니다 — node --test 로 그대로 검증합니다.
 *   · 확인되지 않은 사실을 만들지 않습니다. 로컬 폴백은 제목을 다듬은 문장이며
 *     응답의 mode 로 'template' 임을 숨기지 않습니다.
 */

export const RANKS = [5, 4, 3, 2, 1];
export const RANK_COUNT = RANKS.length;
export const DEFAULT_SLOT_SEC = 4;
export const MIN_SLOT_SEC = 1.5;
export const MAX_SLOT_SEC = 20;
export const MAX_TRIM_SEC = 60;
export const MAX_CAPTION_CHARS = 160;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** 어떤 표기('TOP 3' · '3위' · 3)든 1~5 사이 순위로. 아니면 0. */
export function normalizeRank(value) {
  if (value == null || value === '') return 0;
  const text = String(value).trim();
  const hit = text.match(/(\d+)/);
  const n = hit ? Number(hit[1]) : Number(text);
  if (!Number.isFinite(n)) return 0;
  const rank = Math.trunc(n);
  return rank >= 1 && rank <= RANK_COUNT ? rank : 0;
}

/** 'TOP 3' 라벨. 잘못된 값은 TOP 1 이 아니라 빈 문자열을 돌려줍니다(가짜 순위 금지). */
export function rankLabel(rank) {
  const r = normalizeRank(rank);
  return r ? `TOP ${r}` : '';
}

/** 배지·테마 — 1위만 금색입니다. */
export function rankMeta(rank) {
  const r = normalizeRank(rank) || RANK_COUNT;
  const gold = r === 1;
  return {
    rank: r,
    label: `TOP ${r}`,
    ordinal: `${r}위`,
    gold,
    accent: gold ? '#F5C542' : '#8B5CF6',
    badgeText: gold ? '#2A1B02' : '#FFFFFF',
    gradient: gold
      ? ['#B45309', '#451A03']
      : r === 2
        ? ['#6D28D9', '#3B0764']
        : r === 3
          ? ['#4C1D95', '#2E1065']
          : r === 4
            ? ['#312E81', '#1E1B4B']
            : ['#1E293B', '#0F172A'],
  };
}

function cleanText(value, max = 200) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanNumber(value, lo, hi, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return round1(clamp(n, lo, hi));
}

/** 슬롯 하나의 빈 상태. */
export function createSlot(rank) {
  const r = normalizeRank(rank) || RANK_COUNT;
  return {
    rank: r,
    url: '',
    videoId: '',
    ytTitle: '',
    ytChannel: '',
    ytDurationSec: 0,
    ytTranscript: '',
    ytNote: '',
    ytFetchedBy: '',
    title: '',
    caption: '',
    trimStart: 0,
    trimSec: 0,
    clipName: '',
    clipDurationSec: 0,
    imageName: '',
  };
}

/** 저장·요청 어느 쪽에서든 5칸을 빠짐없이, 순위별로 정규화합니다(TOP 5 → TOP 1). */
export function normalizeSlots(input) {
  const list = Array.isArray(input) ? input : Array.isArray(input?.slots) ? input.slots : [];
  const byRank = new Map();
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const rank = normalizeRank(raw.rank ?? raw.position ?? raw.top ?? RANKS[index]);
    if (!rank || byRank.has(rank)) return;
    byRank.set(rank, raw);
  });
  return RANKS.map((rank) => {
    const base = createSlot(rank);
    const raw = byRank.get(rank) || {};
    const clipName = cleanText(raw.clipName, 120);
    const clipDurationSec = cleanNumber(raw.clipDurationSec, 0, 3600, 0);
    return {
      ...base,
      url: cleanText(raw.url, 400),
      videoId: cleanText(raw.videoId, 40),
      ytTitle: cleanText(raw.ytTitle, 120),
      ytChannel: cleanText(raw.ytChannel, 80),
      ytDurationSec: cleanNumber(raw.ytDurationSec, 0, 7200, 0),
      ytTranscript: String(raw.ytTranscript == null ? '' : raw.ytTranscript).slice(0, 4000),
      ytNote: cleanText(raw.ytNote, 160),
      ytFetchedBy: cleanText(raw.ytFetchedBy, 20),
      title: cleanText(raw.title, 80),
      caption: cleanText(raw.caption, MAX_CAPTION_CHARS),
      trimStart: cleanNumber(raw.trimStart, 0, MAX_TRIM_SEC, 0),
      trimSec: cleanNumber(raw.trimSec, 0, MAX_TRIM_SEC, 0),
      clipName,
      clipDurationSec,
      imageName: cleanText(raw.imageName, 120),
    };
  });
}

/** 한 슬롯이 지금 무엇으로 화면에 나오는지 — 클립 > 이미지 > 그라데이션 카드. */
export function slotSource(slot) {
  if (!slot) return 'empty';
  if (slot.clipName || Number(slot.clipDurationSec) > 0) return 'clip';
  if (slot.imageName) return 'image';
  return 'card';
}

/** 클립 다듬기 범위 — 클립 길이를 넘지 않게 잘라 돌려줍니다. */
export function effectiveTrim(slot) {
  const dur = Math.max(0, Number(slot?.clipDurationSec) || 0);
  const maxLen = dur ? Math.max(0.8, dur - 0.05) : MAX_TRIM_SEC;
  const start = round1(clamp(Number(slot?.trimStart) || 0, 0, dur ? Math.max(0, dur - 0.5) : MAX_TRIM_SEC));
  const wanted = Number(slot?.trimSec) > 0 ? Number(slot.trimSec) : 0;
  const room = dur ? Math.max(0.8, dur - start) : MAX_TRIM_SEC;
  const sec = round1(clamp(wanted || Math.min(room, DEFAULT_SLOT_SEC), Math.min(MIN_SLOT_SEC, room), Math.min(MAX_SLOT_SEC, room)));
  return { start, sec, room };
}

/** 슬롯 재생 길이(초). 클립이 있으면 다듬기 범위, 없으면 기본 4초. */
export function slotDurationSec(slot) {
  return effectiveTrim(slot).sec;
}

/**
 * TOP 5 → TOP 1 순서의 재생 타임라인.
 * narration = { 5: 3.2, 4: 2.8, … } (초) — 음성이 더 길면 그만큼 늘립니다(말이 잘리지 않게).
 */
export function buildRankingTimeline(slots, { narration = {}, maxSec = MAX_SLOT_SEC } = {}) {
  const list = normalizeSlots(slots);
  const segments = [];
  let t = 0;
  list.forEach((slot, index) => {
    const base = slotDurationSec(slot);
    const key = slot.rank;
    const narr = Number(narration?.[key] ?? narration?.[String(key)] ?? 0) || 0;
    const dur = round1(clamp(narr > 0 ? Math.max(base, narr + 0.3) : base, MIN_SLOT_SEC, maxSec));
    segments.push({
      index,
      rank: slot.rank,
      label: rankLabel(slot.rank),
      start: t,
      end: round1(t + dur),
      dur,
      gold: slot.rank === 1,
    });
    t = round1(t + dur);
  });
  return { segments, total: t, order: segments.map((s) => s.rank) };
}

/** t(초)가 속한 구간 — 마지막 구간을 넘으면 마지막을 돌려줍니다. */
export function segmentAt(segments, t) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const at = Math.max(0, Number(t) || 0);
  for (const seg of segments) if (at < seg.end - 0.0001) return seg;
  return segments[segments.length - 1];
}

/** 내레이션으로 읽을 문장 — [강조] 대괄호와 마크업은 걷어냅니다. */
export function rankSpeechText(slot) {
  const raw = String(slot?.caption || slot?.title || '');
  return raw
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/[#*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** 자막을 토큰(단어/강조 묶음)으로 — [여러 단어]는 한 덩어리로 유지합니다.
 *   glue: 앞 토큰과 붙어 있는지(공백 없음). '담배]와' 처럼 조사가 붙은 경우 '담배 와'로
 *   벌어지지 않게 합니다.
 */
export function captionTokens(text) {
  const tokens = [];
  const src = String(text || '');
  const re = /\[([^\]]*)\]|(\S+)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(src)) !== null) {
    const gap = src.slice(lastEnd, m.index);
    const glue = tokens.length > 0 && !/\s/.test(gap);
    lastEnd = m.index + m[0].length;
    if (m[1] != null) {
      const inner = cleanText(m[1], 80);
      if (inner) tokens.push({ text: inner, hl: true, glue });
    } else if (m[2]) {
      tokens.push({ text: m[2], hl: false, glue });
    }
  }
  return tokens;
}

/** 화면·캔버스 공용 줄바꿈 — maxChars 자 기준, maxLines 를 넘으면 마지막 줄을 줄임표로. */
export function splitCaptionLines(text, { maxChars = 15, maxLines = 3 } = {}) {
  const tokens = captionTokens(text);
  if (!tokens.length) return [];
  const limit = Math.max(4, Number(maxChars) || 15);
  const lines = [];
  let cur = { parts: [], chars: 0 };
  const flush = () => {
    if (cur.parts.length) lines.push(cur);
    cur = { parts: [], chars: 0 };
  };
  tokens.forEach((token) => {
    const len = [...token.text].length;
    const space = cur.parts.length && !token.glue ? 1 : 0;
    if (cur.chars && cur.chars + space + len > limit) flush();
    const gap = cur.parts.length && !token.glue ? 1 : 0;
    cur.parts.push({ text: token.text, hl: token.hl, space: Boolean(gap) });
    cur.chars += gap + len;
  });
  flush();
  const max = Math.max(1, Number(maxLines) || 3);
  const joinLine = (line) => line.parts.map((part, i) => `${i && part.space ? ' ' : ''}${part.text}`).join('');
  if (lines.length <= max) return lines.map((line) => ({ ...line, text: joinLine(line) }));
  const kept = lines.slice(0, max);
  const last = kept[max - 1];
  const flat = [...joinLine(last)];
  const trimmed = flat.slice(0, Math.max(4, limit - 1)).join('').replace(/\s+$/, '') + '…';
  kept[max - 1] = {
    parts: [{ text: trimmed, hl: last.parts.some((p) => p.hl), space: false }],
    chars: trimmed.length,
    text: trimmed,
  };  return kept;
}

/** 미리보기·내보내기 전 점검 — 막지는 않고, 무엇이 비었는지 정직하게 알려 줍니다. */
export function validateSlots(slots) {
  const list = normalizeSlots(slots);
  const empty = [];
  const noClip = [];
  const noCaption = [];
  list.forEach((slot) => {
    const source = slotSource(slot);
    if (!slot.caption.trim()) noCaption.push(slot.rank);
    if (source !== 'clip') noClip.push(slot.rank);
    if (source === 'card' && !slot.caption.trim() && !slot.title.trim()) empty.push(slot.rank);
  });
  return {
    total: RANK_COUNT,
    filled: RANK_COUNT - empty.length,
    empty,
    noClip,
    noCaption,
    ok: empty.length < RANK_COUNT,
  };
}

/* ───────────────────────── AI 랭킹 대본 ───────────────────────── */

/** Gemini 프롬프트 — 확인되지 않은 사실·숫자를 만들지 말라고 명시합니다. */
export function buildRankingPrompt({ topic = '', slots = [], tone = 'punchy' } = {}) {
  const list = normalizeSlots(slots);
  const lines = list.map((slot) => {
    const transcript = String(slot.ytTranscript || '').replace(/\s+/g, ' ').trim().slice(0, 700);
    return [
      `- TOP ${slot.rank}`,
      slot.title || slot.ytTitle ? `  제목: ${slot.title || slot.ytTitle}` : '  제목: (없음)',
      transcript ? `  자막 발췌: ${transcript}` : '  자막 발췌: (없음 — 제목만으로 씁니다)',
      slot.caption ? `  현재 코멘트: ${slot.caption}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    '너는 한국 유튜브 쇼츠의 TOP 5 랭킹 짜집기 대본 작가다.',
    `영상 주제: ${topic || '(주제 미입력)'}`,
    '아래 5개 항목(TOP 5 → TOP 1 순서)의 제목과 자막 발췌를 보고, 각 순위의 코멘트를 다시 써라.',
    '',
    ...lines,
    '',
    '규칙:',
    '1) 각 순위마다 title(항목 이름, 20자 이내)과 caption(화면 자막이자 내레이션, 32자 이내)을 쓴다.',
    '2) 말투는 ' + (tone === 'calm' ? '차분한 다큐 톤' : '짧고 단정적인 쇼츠 톤') + '. 문장은 한 개, 마침표로 끝낸다.',
    '3) 강조할 한 단어는 [대괄호]로 감싼다. 예: [1위]는 이겁니다.',
    '4) 자막 발췌에 없는 사실·숫자·이름을 새로 만들지 않는다. 모르면 제목을 다듬는 수준에서 멈춘다.',
    '5) 5위는 도입, 1위는 가장 강한 문장으로 — 1위가 궁금하게 이어지도록 쓴다.',
    '6) 설명 없이 아래 JSON 만 출력한다.',
    '{"hook":"영상 첫 문장(20자 이내)","slots":[{"rank":5,"title":"...","caption":"..."},{"rank":4,...},{"rank":3,...},{"rank":2,...},{"rank":1,...}]}',
  ].join('\n');
}

/** 문자열에서 첫 번째 균형 잡힌 JSON(객체/배열)을 꺼냅니다 — 코드펜스·설명문이 섞여도. */
export function extractJson(raw) {
  const text = String(raw || '');
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Gemini 응답 → { ok, slots:[{rank,title,caption}], hook } (순위는 5→1). */
export function parseRankingScript(raw) {
  const json = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not-json', slots: [], hook: '' };
  const list = Array.isArray(json)
    ? json
    : Array.isArray(json.slots)
      ? json.slots
      : Array.isArray(json.ranking)
        ? json.ranking
        : Array.isArray(json.items)
          ? json.items
          : null;
  if (!list) return { ok: false, reason: 'no-slots', slots: [], hook: '' };
  const byRank = new Map();
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const rank = normalizeRank(item.rank ?? item.position ?? item.top ?? RANKS[index]);
    if (!rank || byRank.has(rank)) return;
    const caption = cleanText(item.caption ?? item.comment ?? item.line ?? item.script ?? item.text, MAX_CAPTION_CHARS);
    const title = cleanText(item.title ?? item.name ?? item.label ?? item.item, 80);
    if (!caption) return;
    byRank.set(rank, { rank, title, caption });
  });
  const slots = [...byRank.values()].sort((a, b) => b.rank - a.rank);
  if (slots.length < 3) return { ok: false, reason: 'too-few', slots, hook: '' };
  return { ok: true, reason: '', slots, hook: cleanText(json.hook ?? json.intro ?? json.title ?? '', 80) };
}

/**
 * 생성된 대본을 슬롯에 입힙니다.
 *   · overwrite=false(기본)면 사용자가 이미 쓴 코멘트는 건드리지 않습니다.
 *   · 빈 칸만 채우고, 몇 개를 채웠/지켰는지 돌려줍니다.
 */
export function applyRankingScript(slots, generated, { overwrite = false, topic = '' } = {}) {
  const list = normalizeSlots(slots);
  const gen = Array.isArray(generated) ? { slots: generated } : generated || {};
  const byRank = new Map();
  (gen.slots || []).forEach((item) => {
    const rank = normalizeRank(item?.rank);
    if (rank && item?.caption) byRank.set(rank, item);
  });
  let filled = 0;
  let kept = 0;
  const next = list.map((slot) => {
    const item = byRank.get(slot.rank);
    if (!item) return { ...slot };
    const out = { ...slot };
    if (overwrite || !slot.caption.trim()) {
      out.caption = cleanText(item.caption, MAX_CAPTION_CHARS) || slot.caption;
      if (out.caption !== slot.caption) filled += 1;
    } else {
      kept += 1;
    }
    if ((overwrite || !slot.title.trim()) && item.title) out.title = cleanText(item.title, 80);
    return out;
  });
  const missing = RANKS.filter((rank) => !byRank.has(rank));
  return {
    slots: next,
    filled,
    kept,
    missing,
    hook: cleanText(gen.hook, 80) || (topic ? `${topic}, TOP 5 정리합니다.` : ''),
  };
}

/**
 * 로컬 템플릿 폴백 — Gemini 가 없거나 실패해도 대본 칸이 비어 있지 않게.
 * 제목을 다듬은 문장이라 새로운 사실을 만들지 않습니다.
 */
export function localRankingScript({ topic = '', slots = [] } = {}) {
  const list = normalizeSlots(slots);
  const t = cleanText(topic, 60);
  const patterns = {
    5: (name) => `${name}, 여기서부터[순위]가 갈립니다.`,
    4: (name) => `${name}. 이건 많은 분들이 놓칩니다.`,
    3: (name) => `${name}. 여기까지가 상위권입니다.`,
    2: (name) => `${name}. [1위]와 마지막까지 고민했습니다.`,
    1: (name) => `${name}. 이게 [1위]인 이유가 있습니다.`,
  };
  const out = list.map((slot) => {
    const name = cleanText(slot.title || slot.ytTitle || `${t || 'TOP 5'} ${slot.rank}위`, 60);
    return { rank: slot.rank, title: name, caption: (patterns[slot.rank] || patterns[5])(name) };
  });
  return {
    mode: 'template',
    hook: t ? `${t}, [TOP 5] 바로 갑니다.` : '[TOP 5] 끝까지 보세요.',
    slots: out,
  };
}

/* ───────────────────────── 파일·포맷 ───────────────────────── */

/** 내려받을 파일 이름 — 주제에서 위험 문자만 걷어냅니다. */
export function rankingExportName(topic, W, H, ext = 'mp4') {
  const slug = String(topic || 'top5')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);
  return `${slug || 'top5'}_top5_${W}x${H}.${ext}`;
}

/** MediaRecorder 후보 — 코덱까지 지정한 것만 믿습니다(아이폰 호환).
 *   · 1순위 H.264 MP4 (아이폰·유튜브·인스타가 가장 잘 받는 형식)
 *   · H.264 가 없으면 MP4(VP9) — 컨테이너는 MP4 로 유지(크로미움 계열)
 *   · 그다음 WebM(VP9/VP8) — 파이어폭스·구형 크롬
 */
export function recorderMimeCandidates(withAudio = false) {
  const sound = withAudio
    ? [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E,opus',
        'video/mp4;codecs=vp9,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
      ]
    : [];
  return [
    ...sound,
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4;codecs=vp9',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4',
    'video/webm',
  ];
}

/** 녹화된 파일 앞부분 바이트로 실제 컨테이너·코덱·오디오 유무를 확인합니다. */
export function sniffVideoBytes(bytes) {
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const ascii = (from, to) => {
    let out = '';
    const end = Math.min(head.length, to);
    for (let i = from; i < end; i += 1) out += String.fromCharCode(head[i]);
    return out;
  };
  const text = ascii(0, 524288);
  const audioMarks = /(soun|mp4a|Opus|dOps|A_OPUS|A_VORBIS)/.test(text);
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return {
      container: 'webm',
      ext: 'webm',
      codec: /V_VP9/.test(text) ? 'vp9' : /V_VP8/.test(text) ? 'vp8' : 'unknown',
      audio: /A_OPUS/.test(text) ? 'opus' : /A_VORBIS/.test(text) ? 'vorbis' : audioMarks ? 'unknown' : 'none',
    };
  }
  if (ascii(4, 8) === 'ftyp') {
    // ftyp 의 호환 브랜드 목록에 'avc1' 이 들어가는 경우가 있어(크롬 MP4 먹서),
    // 실제 샘플 설명(stsd) 뒤쪽에서 코덱 fourcc 를 찾습니다.
    const stsdAt = text.indexOf('stsd');
    const codecZone = stsdAt >= 0 ? text.slice(stsdAt, stsdAt + 8192) : text;
    const codec = /vp09|vp08/.test(codecZone)
      ? 'vp9'
      : /avc1|avc3/.test(codecZone)
        ? 'h264'
        : /hvc1|hev1/.test(codecZone)
          ? 'hevc'
          : /av01/.test(codecZone)
            ? 'av1'
            : 'unknown';
    return {
      container: 'mp4',
      ext: 'mp4',
      codec,
      audio: /mp4a/.test(text) ? 'aac' : /(Opus|dOps)/.test(text) ? 'opus' : audioNone(text),
    };
  }
  return {
    container: 'unknown',
    ext: 'webm',
    codec: 'unknown',
    audio: audioMarks ? 'unknown' : 'none',
  };
}

function audioNone(text) {
  return /soun/.test(text) ? 'unknown' : 'none';
}

/** 요청 본문 → { mode, topic, slots } — 서버·화면이 같은 규칙을 씁니다. */
export function readRankingBody(body = {}) {
  const mode = body?.mode === 'slot' ? 'slot' : 'script';
  const topic = cleanText(body?.topic, 80);
  const slots = normalizeSlots(body?.slots);
  const notices = [];
  if (mode === 'script' && !topic && !slots.some((slot) => slot.url || slot.title)) {
    notices.push('주제나 항목을 하나 이상 입력해 주세요.');
  }
  return { mode, topic, slots, notices };
}

/**
 * 자막 발췌에서 '한 줄 코멘트'로 쓸 만한 문장을 고릅니다(사실 창작 없음).
 * 마땅한 문장이 없으면 빈 문자열 — 화면은 제목으로 대신합니다.
 */
export function highlightSuggestion(transcript, { title = '', maxChars = 60 } = {}) {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const pieces = text
    .split(/(?<=[.!?…])\s+|(?<=다)\s+(?=[가-힣])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  const score = (s) => {
    let n = 0;
    if (s.length >= 14 && s.length <= maxChars) n += 3;
    if (s.length < 10) n -= 3;
    if (/\d/.test(s)) n += 2;
    if (/(가장|최고|최초|절대|진짜|때문|핵심|중요|1위|1등)/.test(s)) n += 2;
    if (s.length > maxChars) n -= 2;
    return n;
  };
  const best = pieces
    .map((s, i) => ({ s, i, n: score(s) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)[0];
  if (!best || best.n < 1) return '';
  const picked = best.s.replace(/^[-–—·]\s*/, '');
  if (title && picked.includes(title.slice(0, 8))) return '';
  return [...picked].slice(0, maxChars).join('').trim();
}

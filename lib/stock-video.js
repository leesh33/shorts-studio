/**
 * lib/stock-video.js — 🎬 '움직이는 영상(스톡 클립)' 경로
 * ─────────────────────────────────────────────────────────────
 * 사진 한 장에 켄번즈를 거는 대신, **실제로 움직이는 영상 클립**을 찾아 컷 배경으로 씁니다.
 *
 * 쓰는 곳
 *   ① Pixabay Videos — pixabay.com/api/videos/ (PIXABAY_API_KEY 가 있을 때 1순위)
 *      · 세로(vertical)·HD 우선. mp4 라 아이폰 사파리에서도 그대로 재생됩니다.
 *      · 라이선스: Pixabay Content License(출처 표기 의무 없음, 상업 이용 가능).
 *   ② Pexels Videos — api.pexels.com/videos/search (PEXELS_API_KEY 가 있을 때)
 *      · Pexels 는 신규 키 발급을 잠시 멈춰 두었습니다 — 키가 있으면 그대로 씁니다.
 *   ③ 위키미디어 커먼즈 — commons.wikimedia.org/w/api.php (키 없이도 동작)
 *      · filetype:video + videoinfo(derivatives) 로 720p 이하 webm 트랜스코드를 고릅니다.
 *      · 라이선스(CC BY-SA 등)·저작자·원본 문서 URL 이 함께 옵니다.
 *
 * 원칙
 *   · 영상 바이트는 data URL 로 만들 수 없을 만큼 큽니다(수 MB). 그래서 **같은 출처 프록시**
 *     `/api/video-proxy?u=…` 주소를 돌려줍니다 — <video> 재생과 캔버스 drawImage 가
 *     CORS·tainted canvas 없이 동작하려면 같은 출처여야 합니다(MP4/WebM 내보내기).
 *   · 프록시는 호스트 허용 목록으로만 열립니다(열린 프록시·SSRF 방지) — isAllowedVideoUrl.
 *   · 성공을 꾸미지 않습니다. 클립이 없으면 no-video 로 실패하고, 화면이 실제 사진 →
 *     무료 AI 순서로 폴백합니다.
 *   · 네트워크는 fetchImpl 로 주입할 수 있어 테스트에서는 실제로 나가지 않습니다.
 */

export const PIXABAY_VIDEO_SEARCH = 'https://pixabay.com/api/videos/';
export const PEXELS_VIDEO_SEARCH = 'https://api.pexels.com/videos/search';
export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/** 위키미디어 정책상 식별 가능한 User-Agent 를 씁니다(real-photo.js 와 같은 값). */
export const VIDEO_UA = 'TakeOneShortsStudio/1.0 (shorts-studio; contact: leesh33)';

/** 화면·프록시가 함께 쓰는 경로 */
export const VIDEO_PROXY_PATH = '/api/video-proxy';

/** 프록시가 열어도 되는 호스트 — 이 밖의 주소는 403. */
export const ALLOWED_VIDEO_HOSTS = [
  'cdn.pixabay.com',
  'pixabay.com',
  'videos.pexels.com',
  'images.pexels.com',
  'player.vimeo.com',
  'vod-progressive.akamaized.net',
  'upload.wikimedia.org',
  'thumb.wikimedia.org',
  'commons.wikimedia.org',
];

/** 이 크기를 넘는 원본은 프록시로 흘리기엔 무겁습니다(트랜스코드가 없을 때만 문제). */
export const MAX_COMMONS_ORIGINAL_BYTES = 30_000_000;

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

/** 커먼즈 검색 결과 캐시 — 같은 검색어를 다시 물으면 위키미디어에 부담을 주지 않습니다. */
const COMMONS_CACHE = new Map();
const COMMONS_CACHE_MS = 10 * 60 * 1000;

const VIDEO_MIME = /^(video\/(webm|mp4|ogg|quicktime)|application\/ogg)\b/i;

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

/** 프록시 대상으로 허용된 https 주소인지(호스트 허용 목록). */
export function isAllowedVideoUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_VIDEO_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** 같은 출처 프록시 주소 — <video src>, 캔버스 drawImage 가 CORS 없이 동작합니다. */
export function proxiedVideoUrl(url, path = VIDEO_PROXY_PATH) {
  return `${path}?u=${encodeURIComponent(String(url || ''))}`;
}

/** 검색어 다듬기(real-photo.js 와 같은 규칙 — 한 줄·문장부호 제거). */
export function cleanKeyword(text, max = 60) {
  return String(text || '')
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/[“”"'`<>]/g, ' ')
    .replace(/[.,!?~·|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 제목 비교용 정규화 */
export function normalizeTitle(title) {
  return String(title || '')
    .replace(/^(File|파일):/i, '')
    .replace(/\.(webm|ogv|ogg|mp4|mov|mpe?g)$/i, '')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ──────────────── 검색어 ↔ 클립 태그 관련도 (엄격) ────────────────
 *
 * 왜 필요한가: Pixabay·Pexels 는 검색어가 조금만 어긋나도 '비슷한 분위기' 클립을
 * 돌려줍니다. 실측(2026-11-19)에는 '롯데월드타워의 비밀' 로 물었더니
 * 태그가 '도로, 교통, 차량' 인 횡단보도 클립과 '항구, 요트' 클립이 1순위로 왔습니다.
 * 그래서 **돌려받은 클립의 tags·title 을 실제로 읽고**, 컷의 핵심 피사체와
 * 겹치지 않으면 아예 버립니다(무관한 클립보다 실제 사진이 낫습니다).
 */

/** 검색어에서 빼는 말 — 촬영 기법·시간대·화질은 '피사체'가 아닙니다. */
export const QUERY_MODIFIERS = new Set([
  'night', 'day', 'daytime', 'morning', 'evening', 'sunset', 'sunrise', 'dusk', 'dawn',
  'aerial', 'drone', 'timelapse', 'slowmotion', 'slow', 'motion', 'closeup', 'macro', 'wide',
  'bokeh', 'background', 'vertical', 'portrait', 'cinematic', 'beautiful', 'stunning',
  'detail', 'close', 'shot', 'angle', 'footage', 'loop', 'looped', 'seamless',
]);

/** 검색어에서 빼는 군더더기 */
const QUERY_STOP = new Set([
  'the', 'of', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'or',
  'video', 'videos', 'clip', 'clips', 'stock', 'film', 'mp4', '4k', '8k', 'hd', 'uhd', '1080p', '2160p',
]);

/** 고유명사가 아닌 흔한 장소 명사 — 'specific_landmark' 판정에서 제외합니다. */
const LANDMARK_COMMON = new Set([
  'tower', 'towers', 'building', 'buildings', 'skyscraper', 'skyscrapers', 'city', 'cities',
  'street', 'streets', 'road', 'roads', 'palace', 'bridge', 'bridges', 'park', 'river',
  'mountain', 'island', 'lake', 'station', 'airport', 'mall', 'market', 'temple', 'museum',
  'plaza', 'square', 'view', 'skyline', 'world', 'landmark', 'travel', 'urban', 'town', 'village',
]);

/**
 * 주제와 상관없이 '배경'으로만 지나가는 소재 — 검색어가 그 소재를 요청하지 않았으면 버립니다.
 * (횡단보도·요트·항구·사진작가가 롯데타워 컷에 붙던 문제)
 */
export const UNRELATED_SUBJECTS = new Set([
  'crosswalk', 'crossing', 'yacht', 'yachts', 'harbor', 'harbour', 'marina', 'sailboat', 'sailboats', 'boat', 'boats',
  'photographer', 'photographers', 'cameraman', 'wedding', 'bride', 'groom', 'fashion', 'makeup',
  'gym', 'workout', 'cooking', 'recipe', 'dance', 'dancing', 'concert', 'protest', 'fire', 'flood', 'accident',
]);

/**
 * 첫 단어가 피사체가 아니라 '배경'인 검색어 — 이 경우 첫 단어만 맞는 클립을 믿지 않습니다.
 * (예: "city night" 에 아무 도시 클립이 붙던 문제)
 */
const GENERIC_HEADS = new Set([
  'city', 'cities', 'street', 'streets', 'road', 'roads', 'building', 'buildings', 'people', 'person',
  'view', 'scene', 'sky', 'skyline', 'nature', 'water', 'travel', 'urban', 'town', 'village', 'landscape',
  'background', 'korea', 'korean', 'seoul',
]);

/** 복수형을 단수로 — 'dogs' → 'dog', 'cities' → 'city' */
function singularize(word) {
  if (/ies$/.test(word) && word.length >= 5) return `${word.slice(0, -3)}y`;
  if (/[^su]s$/.test(word) && word.length >= 5) return word.slice(0, -1);
  return word;
}

/** 검색어·태그를 비교할 단어 목록으로 (영어·한국어 모두) */
export function tokenizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^0-9a-z\uac00-\ud7a3]+/g)
    .filter(Boolean)
    .map(singularize)
    .filter((w) => w.length >= 2)
    .filter((w) => !QUERY_STOP.has(w));
}

function uniq(list) {
  return [...new Set(list)];
}

function isKoreanWord(word) {
  return /[\uac00-\ud7a3]/.test(String(word || ''));
}

/**
 * 컷 검색어 → 비교용 토큰 묶음.
 *   query 'Lotte World Tower' · kind 'specific_landmark'
 *     → required ['lotte','world','tower'] · distinctive ['lotte']   (tower/world 는 흔한 말)
 *   query 'skyscraper night'    · kind 'generic_scene'
 *     → required ['skyscraper']       · distinctive ['skyscraper']   (night 는 수식어)
 */
export function queryTerms({ query = '', kind = '', keywords = {} } = {}) {
  const raw = cleanKeyword(query || keywords.videoEn || keywords.en || keywords.ko || '').toLowerCase();
  const tokens = uniq(tokenizeWords(raw));
  const strong = tokens.filter((w) => !QUERY_MODIFIERS.has(w));
  const required = strong.length ? strong : tokens;
  const landmark = String(kind || keywords.kind || '').toLowerCase() === 'specific_landmark';
  const distinctive = required.filter((w) => !LANDMARK_COMMON.has(w) && !UNRELATED_SUBJECTS.has(w));
  return { raw, tokens, required, distinctive, landmark, flat: required.join('') };
}

/** 한 토큰이 후보 태그에 얼마나 맞는지 — 1: 그대로, 0.5: 한국어 부분 일치, 0: 없음 */
function tokenMatches(token, hayTokens, hayCompact) {
  if (isKoreanWord(token)) {
    if (hayCompact.includes(token)) return 1;
    if (token.length >= 3 && hayTokens.some((h) => isKoreanWord(h) && h.length >= 2 && token.includes(h))) return 0.5;
    return 0;
  }
  for (const h of hayTokens) {
    if (h === token) return 1;
    if (token.length >= 4 && h.length >= 4 && (h.startsWith(token) || token.startsWith(h))) return 1;
  }
  return 0;
}

/**
 * 클립 하나가 검색어와 맞는지 판정합니다.
 *   level 2: 검색어가 태그에 그대로(구절) 있거나 피사체 토큰이 전부 일치
 *   level 1: 핵심 피사체가 일부 일치 (예: 'observation deck' ↔ 태그 'observation')
 *   level 0: 무관 — 쓰지 않습니다.
 */
export function matchClip(candidate, terms) {
  const hay = `${(candidate?.tags || []).join(' ')} ${candidate?.title || ''}`.trim();
  const hayTokens = tokenizeWords(hay);
  const hayCompact = hayTokens.join('');
  const requested = new Set([...(terms?.tokens || []), ...(terms?.required || [])]);
  const blocked = hayTokens.find((w) => UNRELATED_SUBJECTS.has(w) && !requested.has(w)) || '';
  const required = terms?.required || [];
  let matched = 0;
  for (const token of required) matched += tokenMatches(token, hayTokens, hayCompact);
  const ratio = required.length ? matched / required.length : 0;
  const phrase = terms?.flat && terms.flat.length >= 5 && hayCompact.includes(terms.flat);
  const distinctiveHit = (terms?.distinctive || []).some((t) => tokenMatches(t, hayTokens, hayCompact) > 0);

  let level = 0;
  if (phrase) level = 2;
  else if (matched > 0) {
    if (terms.landmark && terms.distinctive.length) level = distinctiveHit ? (ratio >= 0.999 ? 2 : 1) : 0;
    else {
      // 여러 단어짜리 시각어("dog looking owner")는 첫 단어(피사체)만 맞아도 그 장면입니다.
      // 다만 첫 단어가 'city·street' 같은 배경어면 그것만으로는 믿지 않습니다.
      const head = required[0] || '';
      const headHit = head && tokenMatches(head, hayTokens, hayCompact) > 0;
      const strongHead = headHit && !GENERIC_HEADS.has(head);
      level = ratio >= 0.999 ? 2 : ratio >= 0.5 || strongHead ? 1 : 0;
    }
  }
  if (blocked) level = 0;
  return { level, matched, ratio, distinctiveHit, blocked };
}

/** 여러 검색어 묶음 중 가장 잘 맞는 판정 — 한국어 제목·영어 태그를 함께 봅니다. */
export function bestMatch(candidate, termsList = []) {
  let best = { level: 0, matched: 0, ratio: 0, distinctiveHit: false, blocked: '' };
  for (const terms of termsList) {
    if (!terms || !terms.required.length) continue;
    const m = matchClip(candidate, terms);
    if (m.level > best.level) best = m;
  }
  return best;
}

/** 검색어와 제목·태그의 관련도 — 2: 그대로 포함, 1: 핵심 토큰 포함, 0: 무관 */
export function relevanceHits(text, keywords = {}) {
  const terms = queryTerms({ query: keywords.videoEn || keywords.en || keywords.ko, kind: keywords.kind, keywords });
  return matchClip({ tags: [], title: text }, terms).level;
}

/** Pexels 파일 하나 고르기 — 세로·HD·과하지 않은 크기. */
export function pickPexelsFile(video) {
  const files = (video?.video_files || []).filter(
    (f) =>
      f &&
      /^video\/mp4/i.test(String(f.file_type || '')) &&
      String(f.quality || '').toLowerCase() !== 'hls' &&
      !/\.m3u8(\?|$)/i.test(String(f.link || '')) &&
      /^https:\/\//.test(String(f.link || '')),
  );
  if (!files.length) return null;
  const score = (f) => {
    const w = Number(f.width) || 0;
    const h = Number(f.height) || 0;
    if (!w || !h) return -999;
    const short = Math.min(w, h);
    let s = 0;
    if (h >= w) s += 60; // 세로 클립은 9:16 에 그대로 들어갑니다
    s += Math.min(40, short / 20); // 해상도(짧은 변) — 1080→40, 720→36, 360→18
    if (short > 1440) s -= 25; // 4K 원본은 전송이 느립니다
    if (short < 480) s -= 40;
    return s;
  };
  return [...files].sort((a, b) => score(b) - score(a))[0];
}

/** Pexels 응답 한 건 → 후보 */
export function videoFromPexels(video) {
  const file = pickPexelsFile(video);
  if (!file) return null;
  const link = String(file.link || '');
  if (!isAllowedVideoUrl(link)) return null;
  const page = String(video?.url || '');
  if (!/^https:\/\/(www\.)?pexels\.com\//.test(page)) return null;
  const poster = String(video?.image || '');
  const tags = Array.isArray(video?.tags) ? video.tags.map((t) => String(t?.title || t || '')).filter(Boolean) : [];
  const alt = String(video?.alt || '').trim();
  return {
    provider: 'pexels',
    providerLabel: '스톡 영상 · Pexels',
    videoId: `pexels:${video?.id ?? normalizeTitle(alt || page)}`,
    title: (alt || tags.slice(0, 3).join(', ') || normalTitleFromPage(page) || 'Pexels video').slice(0, 120),
    page,
    sourceUrl: link,
    posterUrl: /^https:\/\//.test(poster) && isAllowedVideoUrl(poster) ? poster : '',
    width: Number(file.width) || Number(video?.width) || 0,
    height: Number(file.height) || Number(video?.height) || 0,
    duration: Number(video?.duration) || 0,
    license: 'Pexels License',
    artist: String(video?.user?.name || ''),
    artistUrl: String(video?.user?.url || ''),
    tags,
  };
}

function normalTitleFromPage(page) {
  const m = String(page || '').match(/video\/[^/]*-?(\d+)\/?$/);
  return m ? `Pexels ${m[1]}` : '';
}

/** Pixabay 응답의 영상 파일 크기 종류 — medium(720p)·small(540p)을 먼저 봅니다. */
const PIXABAY_QUALITIES = ['medium', 'small', 'large', 'tiny'];

/** Pixabay 파일 하나 고르기 — 세로·HD·너무 크지 않은 것. */
export function pickPixabayFile(video) {
  const files = PIXABAY_QUALITIES.map((quality) => {
    const f = video?.videos?.[quality];
    if (!f || !/^https:\/\//.test(String(f.url || ''))) return null;
    if (!isAllowedVideoUrl(f.url)) return null;
    return { ...f, quality, width: Number(f.width) || 0, height: Number(f.height) || 0, size: Number(f.size) || 0 };
  }).filter(Boolean);
  if (!files.length) return null;
  const score = (f) => {
    const short = Math.min(f.width, f.height);
    let s = 0;
    if (f.height >= f.width) s += 60; // 세로 클립은 9:16 에 그대로 들어갑니다
    s += Math.min(40, short / 20); // 해상도(짧은 변)
    if (short > 1440) s -= 25; // 4K 원본은 모바일에서 로딩이 느립니다
    if (short < 480) s -= 40;
    if (f.size > 24_000_000) s -= 20;
    return s;
  };
  return [...files].sort((a, b) => score(b) - score(a))[0];
}

/** Pixabay 응답 한 건 → 후보 */
export function videoFromPixabay(video) {
  const file = pickPixabayFile(video);
  if (!file) return null;
  const page = String(video?.pageURL || '');
  if (page && !/^https:\/\/(www\.)?pixabay\.com\//.test(page)) return null;
  const tags = String(video?.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const poster = String(file.thumbnail || '');
  return {
    provider: 'pixabay',
    providerLabel: '스톡 영상 · Pixabay',
    videoId: `pixabay:${video?.id ?? tags.slice(0, 2).join('-')}`,
    title: (tags.slice(0, 4).join(', ') || 'Pixabay video').slice(0, 120),
    page,
    sourceUrl: String(file.url),
    // Pixabay 는 렌더링마다 포스터(첫 프레임 jpg) 주소를 함께 줍니다 — 카드 썸네일·영상 로딩 중 배경.
    posterUrl: /^https:\/\//.test(poster) && isAllowedVideoUrl(poster) ? poster : '',
    width: file.width,
    height: file.height,
    duration: Number(video?.duration) || 0,
    license: 'Pixabay Content License',
    artist: String(video?.user || ''),
    artistUrl: video?.user ? `https://pixabay.com/users/${encodeURIComponent(String(video.user))}/` : '',
    tags,
    bytes: file.size,
  };
}

/**
 * 커먼즈 videoinfo(+imageinfo) 페이지 한 건 → 후보
 *   · 720p 이하 webm 트랜스코드(derivatives)를 우선 — 원본이 수십 MB 여도 재생이 가볍습니다.
 *   · 트랜스코드가 없으면 원본이 webm 이고 30MB 이하일 때만 씁니다.
 */
export function videoFromCommonsPage(page) {
  const info = (page?.videoinfo || [])[0] || (page?.imageinfo || [])[0] || {};
  const title = String(page?.title || '');
  const mime = String(info.mime || '');
  if (!VIDEO_MIME.test(mime)) return null;

  const derivatives = Array.isArray(info.derivatives) ? info.derivatives : [];
  const webm = derivatives
    .filter((d) => /webm/i.test(String(d?.type || '')) && isAllowedVideoUrl(d?.src))
    .map((d) => ({ ...d, w: Number(d.width) || 0, h: Number(d.height) || 0 }))
    .filter((d) => d.w > 0 && d.h > 0 && d.w <= 1280)
    .sort((a, b) => b.h - a.h || b.w - a.w);

  let sourceUrl = '';
  let width = Number(info.width) || 0;
  let height = Number(info.height) || 0;
  if (webm.length) {
    sourceUrl = String(webm[0].src);
    width = webm[0].w;
    height = webm[0].h;
  } else if (/video\/webm/i.test(mime) && isAllowedVideoUrl(info.url) && (Number(info.size) || 0) <= MAX_COMMONS_ORIGINAL_BYTES) {
    sourceUrl = String(info.url);
  }
  if (!sourceUrl) return null;

  const imageInfo = (page?.imageinfo || [])[0] || {};
  const poster = String(imageInfo.thumburl || imageInfo.thumbattribs?.src || '');
  const meta = info.extmetadata || imageInfo.extmetadata || {};
  const pick = (key) => String((meta[key] || {}).value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    provider: 'wikimedia-commons',
    providerLabel: '스톡 영상 · 위키미디어 커먼즈',
    videoId: `commons:${normalizeTitle(title)}`,
    title: title.replace(/^(File|파일):/i, '').replace(/\.(webm|ogv|ogg|mp4|mov)$/i, ''),
    page: String(info.descriptionurl || ''),
    sourceUrl,
    posterUrl: /^https:\/\//.test(poster) && isAllowedVideoUrl(poster) ? poster : '',
    width,
    height,
    duration: Number(info.duration || imageInfo.duration) || 0,
    license: pick('LicenseShortName') || pick('UsageTerms') || '',
    artist: pick('Artist') || pick('Credit') || '',
    index: Number(page?.index) || 99,
  };
}

/** 후보 점수 — ① 세로 ② HD ③ 길이(2~12초가 한 컷에 알맞음) ④ 검색어 관련도 ⑤ 검색 순위 */
export function scoreVideoCandidate(candidate, { keywords = null, termsList = null, index = 99 } = {}) {
  const { width = 0, height = 0, duration = 0 } = candidate;
  let score = Math.min(width, height) / 20;
  if (height >= width) score += 45;
  if (height / Math.max(1, width) > 1.9) score += 6;
  if (height >= 720) score += 25;
  if (width / Math.max(1, height) > 1.8) score -= 30; // 가로 클립은 9:16 에서 많이 잘립니다
  if (duration) {
    if (duration >= 2 && duration <= 12) score += 15;
    else if (duration > 30) score -= 10;
  }
  if (termsList && termsList.length) {
    const m = bestMatch(candidate, termsList);
    score += m.level * 45; // 관련도가 세로·해상도 보너스를 이길 만큼 중요합니다
  } else if (keywords) {
    score += relevanceHits(`${candidate.title || ''} ${(candidate.tags || []).join(' ')}`, keywords) * 45;
  }
  score -= Math.min(24, Math.max(0, Number(candidate.index ?? index) || 0) * 4);
  return Math.round(score);
}

export function rankVideoCandidates(candidates, { keywords = null, termsList = null } = {}) {
  return [...candidates]
    .map((c) => ({ ...c, score: scoreVideoCandidate(c, { keywords, termsList }) }))
    .sort((a, b) => b.score - a.score);
}

async function getJson(url, { fetchImpl = DEFAULT_FETCH, timeoutMs = 6000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': VIDEO_UA, Accept: 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8', ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return fail(`http-${res.status}`, { status: res.status });
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return fail(err?.name === 'AbortError' ? 'timeout' : 'network', { detail: String(err?.message || err).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }
}

/** Pixabay 영상 검색 — 키가 없으면 no-key 로 즉시 돌아갑니다. */
export async function searchPixabayVideos(query, { apiKey = '', fetchImpl = DEFAULT_FETCH, perPage = 30, timeoutMs = 6000 } = {}) {
  const q = cleanKeyword(query);
  const key = String(apiKey || '').trim();
  if (!key) return fail('no-key');
  if (!q) return fail('no-query');
  const lang = /[\u3131-\uD79D]/.test(q) ? 'ko' : 'en';
  const params = new URLSearchParams({
    key,
    q,
    lang,
    video_type: 'film',
    safesearch: 'true',
    order: 'popular',
    per_page: String(Math.min(50, Math.max(3, perPage))),
  });
  const res = await getJson(`${PIXABAY_VIDEO_SEARCH}?${params.toString()}`, { fetchImpl, timeoutMs });
  if (!res.ok) return res;
  const hits = Array.isArray(res.data?.hits) ? res.data.hits : [];
  const candidates = hits.map(videoFromPixabay).filter(Boolean);
  if (!candidates.length) return fail('no-candidates', { candidates: [] });
  return { ok: true, candidates, query: q, total: Number(res.data?.totalHits) || candidates.length };
}

/** Pexels 영상 검색 — 키가 없으면 no-key 로 즉시 돌아갑니다. */
export async function searchPexelsVideos(query, { apiKey = '', fetchImpl = DEFAULT_FETCH, perPage = 15, orientation = 'portrait', timeoutMs = 6000 } = {}) {
  const q = cleanKeyword(query);
  const key = String(apiKey || '').trim();
  if (!key) return fail('no-key');
  if (!q) return fail('no-query');
  const params = new URLSearchParams({
    query: q,
    per_page: String(Math.min(30, Math.max(3, perPage))),
    orientation,
  });
  const res = await getJson(`${PEXELS_VIDEO_SEARCH}?${params.toString()}`, {
    fetchImpl,
    timeoutMs,
    headers: { Authorization: key },
  });
  if (!res.ok) return res;
  const videos = Array.isArray(res.data?.videos) ? res.data.videos : [];
  const candidates = videos.map(videoFromPexels).filter(Boolean);
  if (!candidates.length) return fail('no-candidates', { candidates: [] });
  return { ok: true, candidates, query: q, total: Number(res.data?.total_results) || candidates.length };
}

/** 커먼즈 영상 검색 — videoinfo(재생용 트랜스코드)와 imageinfo(포스터)를 함께 받습니다. */
export async function searchCommonsVideos(query, { fetchImpl = DEFAULT_FETCH, limit = 12, timeoutMs = 6000 } = {}) {
  const q = cleanKeyword(query);
  if (!q) return fail('no-query');
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${q} filetype:video`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(20, Math.max(4, limit))),
    prop: 'videoinfo|imageinfo',
    viprop: 'url|size|mime|derivatives|extmetadata',
    iiprop: 'url|size|mime',
    iiurlwidth: '720',
  });
  const cacheKey = `${q}|${limit}`;
  const cached = COMMONS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < COMMONS_CACHE_MS) return { ok: true, candidates: cached.candidates, query: q, cached: true };

  const url = `${COMMONS_API}?${params.toString()}`;
  let res = await getJson(url, { fetchImpl, timeoutMs });
  // 위키미디어는 짧은 시간에 몰리면 429 를 줍니다 — 한 번만 잠깐 쉬었다 다시 물어봅니다.
  if (!res.ok && res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res = await getJson(url, { fetchImpl, timeoutMs });
  }
  if (!res.ok) return res;
  const pages = Array.isArray(res.data?.query?.pages) ? res.data.query.pages : [];
  const candidates = pages.map(videoFromCommonsPage).filter(Boolean);
  if (!candidates.length) return fail('no-candidates', { candidates: [] });
  if (COMMONS_CACHE.size >= 60) COMMONS_CACHE.delete(COMMONS_CACHE.keys().next().value);
  COMMONS_CACHE.set(cacheKey, { at: Date.now(), candidates });
  return { ok: true, candidates, query: q };
}

/**
 * 고른 클립이 실제로 재생 가능한지 앞 2KB만 받아 확인합니다.
 *   · Content-Type 이 video/* 이고 2KB 이상이면 통과.
 *   · 429(위키미디어가 짧은 시간에 몰리면 줍니다)는 한 번 쉬었다 다시 묻고,
 *     그래도 막히면 'unverified' 로 통과시킵니다 — 클립 자체가 깨진 것은 아니기 때문입니다.
 */
export async function probeVideo(url, { fetchImpl = DEFAULT_FETCH, timeoutMs = 5000 } = {}) {
  const attempt = async () => {
    if (!isAllowedVideoUrl(url)) return fail('bad-url');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1500, timeoutMs));
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': VIDEO_UA, Range: 'bytes=0-2047', Accept: 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.5' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok && res.status !== 206) return fail(`http-${res.status}`, { status: res.status });
      const type = String(res.headers?.get?.('content-type') || '');
      if (typeof res.arrayBuffer !== 'function') return fail('no-body');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!VIDEO_MIME.test(type)) return fail('not-a-video', { type });
      if (buf.length < 200) return fail('too-small', { bytes: buf.length });
      return { ok: true, type, bytes: buf.length };
    } catch (err) {
      return fail(err?.name === 'AbortError' ? 'timeout' : 'network', { detail: String(err?.message || err).slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await attempt();
  if (first.ok || first.reason !== 'http-429') return first;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await attempt();
  // 두 번 다 429 면 클립은 살리되, 확인하지 못했다는 사실을 남깁니다.
  if (!second.ok && second.reason === 'http-429') return { ok: true, type: '', bytes: 0, unverified: true, reason: 'http-429' };
  return second;
}

/**
 * 검색 순서 — Pixabay(키가 있을 때) → Pexels(키가 있을 때) → 커먼즈(한국어 → 영어 → 주제 대체어).
 *
 * Pixabay·Pexels 는 태그가 영어라서 **영어 검색어로만** 묻습니다(한국어로 묻으면 '비슷한 분위기'가 와서
 * 무관한 클립이 붙었습니다). 영어 검색어가 없으면 이 두 곳은 건너뜁니다(커먼즈 한국어 검색으로 갑니다).
 */
export function videoSearchPlan({ hasKey = false, hasPexelsKey = false, keywords = {} } = {}) {
  const plan = [];
  const seen = new Set();
  const push = (provider, rawQuery, extra = {}) => {
    const q = cleanKeyword(rawQuery);
    if (!q || q.length < 2) return;
    const id = `${provider}|${q.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    plan.push({ provider, query: q, requiresKey: provider !== 'wikimedia-commons', ...extra });
  };
  const en = keywords.en || keywords.videoEn || '';
  const videoEn = keywords.videoEn || en;
  const ko = keywords.videoKo || keywords.ko || '';
  if (hasKey) push('pixabay', videoEn);
  if (hasPexelsKey) push('pexels', videoEn);
  // 커먼즈는 한국어 검색이 됩니다 — 실제 지명은 한국어 제목 파일이 있습니다(예: '롯데월드타워').
  // 사진 검색어(en)를 먼저, 영상 시각어(videoEn)를 그다음 — 구절 검색은 엉뚱한 문서가 섞입니다.
  push('wikimedia-commons', ko);
  push('wikimedia-commons', en);
  push('wikimedia-commons', videoEn);
  const fallback = keywords.fallback;
  if (fallback && fallback !== ko && fallback !== en) push('wikimedia-commons', fallback, { fallback: true });
  return plan;
}

/** 컷 하나에서 비교에 쓸 검색어 묶음 — 영어(영상 검색어 → 사진 검색어)와 한국어를 함께 봅니다. */
export function videoTermSets(keywords = {}) {
  const kind = keywords.kind || '';
  const seen = new Set();
  const out = [];
  for (const raw of [keywords.videoEn, keywords.en, keywords.ko, keywords.fallback]) {
    const terms = queryTerms({ query: raw || '', kind });
    if (!terms.required.length) continue;
    const id = terms.required.join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    terms.source = raw;
    out.push(terms);
  }
  return out;
}

/**
 * 컷 하나의 스톡 영상 클립을 찾습니다.
 *   keywords: { ko, en, videoEn, fallback, kind }  index: 컷 순서(같은 검색어에서 클립을 돌려 쓰기)
 *   exclude: 이미 쓴 클립 id 들                → 컷마다 다른 클립이 나옵니다.
 *
 * 무관한 클립은 쓰지 않습니다.
 *   · 돌려받은 클립의 tags·title 이 컷의 핵심 피사체와 겹치지 않으면 버립니다(관련도 0).
 *   · 특정 랜드마크(예: 롯데월드타워)인데 클립이 없으면 'no-relevant-video' 로 돌려줘
 *     화면이 **실제 사진(켄번즈) → AI** 로 내려가게 합니다.
 *   · Pixabay·Pexels 는 영어 검색어로만 묻습니다.
 */
export async function findStockVideo({
  keywords = { ko: '', en: '', fallback: '' },
  index = 0,
  exclude = [],
  apiKey = '',
  pexelsKey = '',
  budgetMs = 18_000,
  fetchImpl = DEFAULT_FETCH,
} = {}) {
  const started = Date.now();
  const attempts = [];
  const used = new Set((Array.isArray(exclude) ? exclude : []).map((id) => String(id || '')).filter(Boolean));
  const key = String(apiKey || '').trim();
  const pxKey = String(pexelsKey || '').trim();
  const plan = videoSearchPlan({ hasKey: Boolean(key), hasPexelsKey: Boolean(pxKey), keywords });
  const termsList = videoTermSets(keywords);
  if (!plan.length) return { ok: false, reason: 'no-keyword', attempts, ms: 0 };
  const kind = String(keywords.kind || '').toLowerCase();
  // 랜드마크 컷은 '고유명사가 제대로 들어간' 클립만 씁니다(관련도 2).
  //   예: 태그가 'lotte world tower' 면 통과, 'city, skyline, night' 면 실제 사진으로 내려갑니다.
  const minLevel = termsList.some((t) => t.landmark) ? 2 : 1;
  /** 검색은 됐는데 관련도 기준을 넘은 클립이 없었는지 — 마지막 실패 이유를 정확히 말하기 위해 */
  let sawCandidates = false;

  for (const item of plan) {
    if (Date.now() - started > Math.max(0, budgetMs - 4000)) {
      attempts.push({ provider: item.provider, query: item.query, reason: 'time-budget' });
      break;
    }
    const left = Math.max(2500, budgetMs - (Date.now() - started) - 3000);
    const found =
      item.provider === 'pixabay'
        ? await searchPixabayVideos(item.query, { apiKey: key, fetchImpl, timeoutMs: Math.min(6000, left) })
        : item.provider === 'pexels'
          ? await searchPexelsVideos(item.query, { apiKey: pxKey, fetchImpl, timeoutMs: Math.min(6000, left) })
          : await searchCommonsVideos(item.query, { fetchImpl, timeoutMs: Math.min(6000, left) });
    attempts.push({
      provider: item.provider,
      query: item.query,
      ok: Boolean(found.ok),
      count: found.candidates?.length || 0,
      reason: found.ok ? '' : found.reason,
    });
    if (!found.ok) continue;
    sawCandidates = true;

    const fresh = found.candidates.filter((c) => !used.has(c.videoId));
    if (!fresh.length) {
      attempts.push({ provider: item.provider, query: item.query, reason: 'all-used' });
      continue;
    }

    // ① 태그·제목을 실제로 읽고 관련도 0 인 클립은 버립니다(무관한 횡단보도·요트 방지).
    const relevant = fresh
      .map((c) => ({ ...c, relevance: bestMatch(c, termsList).level }))
      .filter((c) => c.relevance >= minLevel);
    if (!relevant.length) {
      attempts.push({ provider: item.provider, query: item.query, reason: 'no-relevant-clip', count: fresh.length });
      continue;
    }

    const ranked = rankVideoCandidates(relevant, { termsList });
    // ② 관련도가 가장 높은 무리 안에서만 고릅니다 — '다른 클립'이 덜 관련된 클립으로 내려가지 않게.
    const topLevel = Math.max(...ranked.map((c) => c.relevance));
    const best = ranked.filter((c) => c.relevance >= topLevel);
    const window = Math.min(best.length, 6);
    const order = [];
    for (let k = 0; k < Math.min(3, window); k += 1) order.push(best[(Math.abs(Number(index) || 0) + k) % window]);

    for (const pick of order) {
      const probe = await probeVideo(pick.sourceUrl, { fetchImpl, timeoutMs: 5000 });
      attempts.push({
        provider: item.provider,
        query: item.query,
        step: 'probe',
        title: String(pick.title || '').slice(0, 80),
        relevance: pick.relevance,
        status: probe.ok ? 200 : 0,
        reason: probe.ok ? '' : probe.reason,
      });
      if (!probe.ok) continue;

      return {
        ok: true,
        provider: pick.provider,
        providerLabel: pick.providerLabel,
        videoId: pick.videoId,
        title: pick.title,
        page: pick.page,
        license: pick.license,
        artist: pick.artist,
        artistUrl: pick.artistUrl || '',
        duration: pick.duration,
        width: pick.width,
        height: pick.height,
        sourceUrl: pick.sourceUrl,
        videoUrl: proxiedVideoUrl(pick.sourceUrl),
        posterUrl: pick.posterUrl ? proxiedVideoUrl(pick.posterUrl) : '',
        credit: videoCredit(pick),
        query: item.query,
        kind,
        relevance: pick.relevance,
        score: pick.score,
        attempts,
        ms: Date.now() - started,
      };
    }
  }

  return {
    ok: false,
    // 검색은 됐는데 쓸 만한 클립이 없었는지 / 아예 없었는지 구분해 알려 줍니다.
    reason: sawCandidates ? 'no-relevant-video' : 'no-video',
    attempts,
    ms: Date.now() - started,
  };
}

/** 화면·응답에 쓸 짧은 출처 한 줄. */
export function videoCredit(video) {
  if (!video || video.ok === false) return '';
  const bits = [];
  if (video.title) bits.push(String(video.title).slice(0, 60));
  if (video.license) bits.push(video.license);
  if (video.artist) bits.push(String(video.artist).slice(0, 40));
  return bits.join(' · ');
}

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

/** 검색어와 제목·태그의 관련도 — 2: 그대로 포함, 1: 긴 토큰 포함, 0: 무관 */
export function relevanceHits(text, keywords = {}) {
  const t = normalizeTitle(text);
  const flat = t.replace(/\s+/g, '');
  let best = 0;
  for (const raw of [keywords.ko, keywords.en, keywords.fallback]) {
    const q = cleanKeyword(raw).toLowerCase();
    if (!q) continue;
    const qFlat = q.replace(/\s+/g, '');
    if (qFlat.length >= 2 && flat.includes(qFlat)) best = Math.max(best, 2);
    else if (q.split(' ').some((tk) => tk.length >= 4 && t.includes(tk))) best = Math.max(best, 1);
  }
  return best;
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

/** 후보 점수 — ① 세로 ② HD ③ 길이(2~12초가 한 컷에 알맞음) ④ 검색 순위 */
export function scoreVideoCandidate(candidate, { keywords = null, index = 99 } = {}) {
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
  if (keywords) score += relevanceHits(`${candidate.title || ''} ${(candidate.tags || []).join(' ')}`, keywords) * 30;
  score -= Math.min(24, Math.max(0, Number(candidate.index ?? index) || 0) * 4);
  return Math.round(score);
}

export function rankVideoCandidates(candidates, { keywords = null } = {}) {
  return [...candidates]
    .map((c) => ({ ...c, score: scoreVideoCandidate(c, { keywords }) }))
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
export async function searchPixabayVideos(query, { apiKey = '', fetchImpl = DEFAULT_FETCH, perPage = 15, timeoutMs = 6000 } = {}) {
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

/** 검색 순서 — Pixabay(키가 있을 때) → Pexels(키가 있을 때) → 커먼즈(한국어 → 영어 → 주제 대체어). */
export function videoSearchPlan({ hasKey = false, hasPexelsKey = false, keywords = {} } = {}) {
  const plan = [];
  if (hasKey) plan.push({ provider: 'pixabay', query: keywords.ko || keywords.en || '', requiresKey: true });
  if (hasPexelsKey) plan.push({ provider: 'pexels', query: keywords.en || keywords.ko || '', requiresKey: true });
  const seen = new Set();
  for (const [query, source] of [
    [keywords.ko, 'wikimedia-commons'],
    [keywords.en, 'wikimedia-commons'],
    [keywords.fallback, 'wikimedia-commons'],
  ]) {
    const q = cleanKeyword(query);
    if (!q || q.length < 2 || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    plan.push({ provider: source, query: q, requiresKey: false });
  }
  return plan;
}

/**
 * 컷 하나의 스톡 영상 클립을 찾습니다.
 *   keywords: { ko, en, fallback }   index: 컷 순서(같은 검색어에서 클립을 돌려 쓰기)
 *   exclude: 이미 쓴 클립 id 들        → 컷마다 다른 클립이 나옵니다.
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
  if (!plan.length) return { ok: false, reason: 'no-keyword', attempts, ms: 0 };

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

    const fresh = found.candidates.filter((c) => !used.has(c.videoId));
    if (!fresh.length) {
      attempts.push({ provider: item.provider, query: item.query, reason: 'all-used' });
      continue;
    }
    // 커먼즈는 제목이 영어인 경우가 많아, 주제 전체 검색어일 때는 검색 순위 상위 3개까지 믿습니다.
    // (Pixabay·Pexels 는 검색 자체가 키워드 검색이라 그대로 믿습니다.)
    const strict = item.provider === 'wikimedia-commons' && Boolean(cleanKeyword(keywords.en)) && item.query !== cleanKeyword(keywords.fallback);
    const usable = fresh.filter((c) => {
      if (item.provider !== 'wikimedia-commons') return true;
      const hits = relevanceHits(`${c.title || ''}`, keywords);
      if (hits > 0) return true;
      return !strict && (Number(c.index) || 99) <= 3;
    });
    if (!usable.length) {
      attempts.push({ provider: item.provider, query: item.query, reason: 'no-relevant-clip' });
      continue;
    }
    const ranked = rankVideoCandidates(usable, { keywords });
    const window = Math.min(ranked.length, 6);
    const pick = ranked[Math.abs(Number(index) || 0) % window];
    const probe = await probeVideo(pick.sourceUrl, { fetchImpl, timeoutMs: 5000 });
    attempts.push({ provider: item.provider, query: item.query, step: 'probe', status: probe.ok ? 200 : 0, reason: probe.ok ? '' : probe.reason });
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
      score: pick.score,
      attempts,
      ms: Date.now() - started,
    };
  }

  return { ok: false, reason: 'no-video', attempts, ms: Date.now() - started };
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

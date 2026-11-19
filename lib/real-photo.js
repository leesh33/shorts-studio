/**
 * lib/real-photo.js — '실제 사진(실사 우선)' 경로
 * ─────────────────────────────────────────────────────────────
 * AI 는 '롯데타워'를 상상으로 그립니다(이상한 건물). 그래서 실사 스타일에서는
 * 컷마다 **실제 장소·사물 사진**을 무료 공개 소스에서 먼저 찾습니다.
 *
 * 쓰는 곳 (키·결제 없음)
 *   ① 위키미디어 커먼즈  commons.wikimedia.org/w/api.php
 *      · CirrusSearch(gsrsearch) + imageinfo 로 실제 사진 후보를 받습니다.
 *      · 라이선스(CC BY-SA 등)·저작자·원본 문서 URL 도 함께 옵니다(출처 표기용).
 *      · 실측(2026-11-19): '롯데타워' → Lotte World Tower 사진 12장, CC BY-SA 4.0
 *   ② 위키백과 문서 대표 이미지  ko.wikipedia.org / en.wikipedia.org (pageimages)
 *      · 커먼즈에 마땅한 사진이 없을 때 문서 인포박스 사진을 씁니다.
 *
 * 원칙
 *   · 사진 바이트는 **서버에서** 받아 base64 로 돌려줍니다 — 브라우저 캔버스가
 *     오염되지 않아 9:16 미리보기·MP4 다운로드가 CORS 없이 동작합니다.
 *   · 성공을 꾸미지 않습니다. 사진이 아니면(HTML·JSON·SVG) 실패로 돌려줍니다.
 *   · 네트워크는 fetchImpl 로 주입할 수 있어 테스트에서는 실제로 나가지 않습니다.
 */

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const WIKIPEDIA_API = { ko: 'https://ko.wikipedia.org/w/api.php', en: 'https://en.wikipedia.org/w/api.php' };

/** 위키미디어 정책상 식별 가능한 User-Agent 를 씁니다. */
export const PHOTO_UA = 'TakeOneShortsStudio/1.0 (shorts-studio; contact: leesh33)';

/** Vercel 응답 한도(4.5MB) 안 — base64 3.6M자 ≈ 원본 2.7MB */
export const MAX_BASE64_CHARS = 3_600_000;
/** 다운로드 상한(원본 바이트) — 넘으면 잘라 쓰지 않고 실패로 돌려줍니다. */
export const MAX_PHOTO_BYTES = 2_600_000;

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

/** 사진이 아닌 것(로고·지도·도표·스크린샷 등) — 제목으로 먼저 거릅니다. */
const NON_PHOTO_TITLE =
  /(logo|wordmark|map|diagram|chart|floor[\s_-]?plan|site[\s_-]?plan|icon|coat[\s_-]of[\s_-]arms|flag|poster|screenshot|censored|blacked[\s_-]?out|blurred|silhouette|drawing|sketch|painting|illustration)/i;

/** 실제 사진으로 보기 어려운 확장자 */
const BAD_EXT = /\.(svg|gif|tif|tiff|pdf|webm|ogv|ogg|mp4|djvu)$/i;

const PHOTO_MIME = /^image\/(jpeg|png|webp)$/i;

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

/** 제목 비교용 정규화('File:' 접두어·확장자·공백·밑줄 제거) */
export function normalizeTitle(title) {
  return String(title || '')
    .replace(/^(File|파일):/i, '')
    .replace(/\.(jpe?g|png|webp|gif|svg|tiff?)$/i, '')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 검색어 다듬기 — 대괄호·따옴표·문장부호를 걷어내고 한 줄로. */
export function cleanKeyword(text, max = 60) {
  return String(text || '')
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/[“”"'`<>]/g, ' ')
    .replace(/[.,!?~·|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 사진 검색 순서 — 한국어 고유명사 → 영어 고유명사 → 대체어.
 *   예: { ko: '롯데타워', en: 'Lotte World Tower' }
 *     → 커먼즈 '롯데타워' → 커먼즈 'Lotte World Tower' → ko 백과 → en 백과
 */
export function buildQueries({ ko = '', en = '', fallback = '' } = {}) {
  const out = [];
  const push = (query, source, lang = '') => {
    const q = cleanKeyword(query);
    if (!q || q.length < 2) return;
    if (out.some((item) => item.query.toLowerCase() === q.toLowerCase() && item.source === source)) return;
    out.push({ query: q, source, lang });
  };
  push(ko, 'wikimedia-commons');
  push(en, 'wikimedia-commons');
  push(fallback, 'wikimedia-commons');
  if (ko) push(ko, 'wikipedia-ko', 'ko');
  if (en) push(en, 'wikipedia-en', 'en');
  return out;
}

function imageFromCandidate(page) {
  const info = (page?.imageinfo || [])[0] || {};
  const mime = String(info.mime || '');
  const title = String(page?.title || '');
  if (!PHOTO_MIME.test(mime)) return null;
  if (BAD_EXT.test(title) || NON_PHOTO_TITLE.test(title)) return null;
  const width = Number(info.width) || 0;
  const height = Number(info.height) || 0;
  if (width < 600 || height < 400) return null;
  // 파노라마(가로 3배 이상)는 9:16 에서 쓸 수 없습니다.
  if (width / Math.max(1, height) > 2.6) return null;
  const url = String(info.url || '');
  const thumbUrl = String(info.thumburl || info.thumbattribs?.src || '');
  const useUrl = thumbUrl || url;
  if (!/^https:\/\//.test(useUrl)) return null;
  const meta = info.extmetadata || {};
  const pick = (key) => String((meta[key] || {}).value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    title,
    url,
    thumbUrl: useUrl,
    width: Number(info.thumbwidth) || width,
    height: Number(info.thumbheight) || height,
    originalWidth: width,
    originalHeight: height,
    mime,
    page: String(info.descriptionurl || ''),
    license: pick('LicenseShortName') || pick('UsageTerms') || '',
    artist: pick('Artist') || pick('Credit') || '',
  };
}

/** 커먼즈 후보 점수 — 9:16 세로 사진을 먼저, 검색어와 제목이 맞는 것을 먼저. */
export function scoreCandidate(candidate, query = '') {
  const { width = 0, height = 0, title = '' } = candidate;
  let score = Math.min(width, height) / 20; // 해상도
  if (height > width) score += 45; // 세로 사진은 9:16 에 그대로 들어갑니다
  if (width / Math.max(1, height) > 1.8) score -= 30;
  const tokens = cleanKeyword(query)
    .toLowerCase()
    .split(' ')
    .filter((t) => t.length >= 3);
  const hay = String(title).toLowerCase().replace(/[_]/g, ' ');
  if (tokens.some((t) => hay.includes(t))) score += 35;
  return Math.round(score);
}

export function rankCandidates(candidates, { query = '' } = {}) {
  return [...candidates]
    .map((c) => ({ ...c, score: scoreCandidate(c, query) }))
    .sort((a, b) => b.score - a.score);
}

async function getJson(url, { fetchImpl = DEFAULT_FETCH, timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1500, timeoutMs));
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': PHOTO_UA, Accept: 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
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

/** 위키미디어 커먼즈에서 실제 사진 후보를 찾습니다. */
export async function searchCommons(query, { fetchImpl = DEFAULT_FETCH, limit = 20, timeoutMs = 6000 } = {}) {
  const q = cleanKeyword(query);
  if (!q) return fail('no-query');
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${q} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(30, Math.max(4, limit))),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1200',
  });
  const res = await getJson(`${COMMONS_API}?${params.toString()}`, { fetchImpl, timeoutMs });
  if (!res.ok) return res;
  const pages = Array.isArray(res.data?.query?.pages) ? res.data.query.pages : [];
  const candidates = pages.map(imageFromCandidate).filter(Boolean);
  if (!candidates.length) return fail('no-candidates', { candidates: [] });
  return { ok: true, candidates, query: q };
}

/** 위키백과 문서 대표 이미지(인포박스 사진) — 커먼즈에서 못 찾았을 때. */
export async function searchWikipedia(query, lang = 'ko', { fetchImpl = DEFAULT_FETCH, timeoutMs = 6000 } = {}) {
  const q = cleanKeyword(query);
  const base = WIKIPEDIA_API[lang] || WIKIPEDIA_API.ko;
  if (!q) return fail('no-query');
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: q,
    gsrlimit: '4',
    prop: 'pageimages',
    piprop: 'thumbnail|original',
    pithumbsize: '1200',
  });
  const res = await getJson(`${base}?${params.toString()}`, { fetchImpl, timeoutMs });
  if (!res.ok) return res;
  const pages = Array.isArray(res.data?.query?.pages) ? res.data.query.pages : [];
  const candidates = pages
    .sort((a, b) => (a.index || 99) - (b.index || 99))
    .map((page) => {
      const thumb = page?.thumbnail?.source || page?.original?.source || '';
      if (!/^https:\/\//.test(thumb)) return null;
      const width = Number(page?.thumbnail?.width || page?.original?.width) || 0;
      const height = Number(page?.thumbnail?.height || page?.original?.height) || 0;
      if (width && height && (width < 500 || height < 300)) return null;
      return {
        title: String(page?.title || ''),
        url: String(page?.original?.source || thumb),
        thumbUrl: thumb,
        width,
        height,
        mime: 'image/jpeg',
        page: `${base.replace('/w/api.php', '')}/wiki/${encodeURIComponent(String(page?.title || '').replace(/ /g, '_'))}`,
        license: '',
        artist: '',
        sourceLabel: lang === 'en' ? 'Wikipedia (EN)' : '위키백과',
      };
    })
    .filter(Boolean);
  if (!candidates.length) return fail('no-image', { candidates: [] });
  return { ok: true, candidates, query: q };
}

/** 앞 바이트로 실제 이미지인지 확인합니다(업스트림이 HTML·SVG 를 줄 때 방어). */
export function sniffPhotoMime(bytes) {
  if (!bytes || bytes.length < 12) return '';
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return '';
}

/** 사진 바이트를 서버에서 받아 data URL 로 — 브라우저 캔버스가 오염되지 않습니다. */
export async function downloadPhoto(url, { fetchImpl = DEFAULT_FETCH, timeoutMs = 8000, maxBytes = MAX_PHOTO_BYTES } = {}) {
  if (!/^https:\/\//.test(String(url || ''))) return fail('bad-url');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(2000, timeoutMs));
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': PHOTO_UA, Accept: 'image/jpeg,image/png,image/webp,image/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return fail(`http-${res.status}`, { status: res.status });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 4000) return fail('too-small', { bytes: buf.length });
    if (buf.length > maxBytes) return fail('too-large', { bytes: buf.length });
    const mimeType = sniffPhotoMime(buf);
    if (!mimeType) return fail('not-an-image', { bytes: buf.length });
    const base64 = Buffer.from(buf).toString('base64');
    if (base64.length > MAX_BASE64_CHARS) return fail('base64-too-large', { bytes: buf.length });
    return { ok: true, base64, mimeType, bytes: buf.length, dataUrl: `data:${mimeType};base64,${base64}` };
  } catch (err) {
    return fail(err?.name === 'AbortError' ? 'timeout' : 'network', { detail: String(err?.message || err).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 컷 하나의 실제 사진을 찾습니다.
 *   keywords: { ko, en, fallback }   index: 컷 순서(같은 검색어에서 사진을 돌려 쓰기)
 *   exclude: 이미 쓴 사진 제목들     → 컷마다 다른 사진이 나옵니다.
 */
export async function findRealPhoto({
  keywords = {},
  index = 0,
  exclude = [],
  budgetMs = 15_000,
  fetchImpl = DEFAULT_FETCH,
} = {}) {
  const started = Date.now();
  const attempts = [];
  const queries = buildQueries(keywords);
  if (!queries.length) return { ok: false, reason: 'no-keyword', attempts, ms: 0 };
  const used = new Set((Array.isArray(exclude) ? exclude : []).map(normalizeTitle));

  for (const item of queries) {
    if (Date.now() - started > Math.max(0, budgetMs - 3000)) {
      attempts.push({ source: item.source, query: item.query, reason: 'time-budget' });
      break;
    }
    const found =
      item.source === 'wikimedia-commons'
        ? await searchCommons(item.query, { fetchImpl, timeoutMs: Math.min(6000, Math.max(2000, budgetMs - (Date.now() - started) - 2000)) })
        : await searchWikipedia(item.query, item.lang, { fetchImpl, timeoutMs: Math.min(6000, Math.max(2000, budgetMs - (Date.now() - started) - 2000)) });
    attempts.push({
      source: item.source,
      query: item.query,
      ok: Boolean(found.ok),
      count: found.candidates?.length || 0,
      reason: found.ok ? '' : found.reason,
    });
    if (!found.ok) continue;

    const fresh = found.candidates.filter((c) => !used.has(normalizeTitle(c.title)));
    if (!fresh.length) continue;
    const ranked = rankCandidates(fresh, { query: item.query });
    const window = Math.min(ranked.length, 6);
    const pick = ranked[Math.abs(Number(index) || 0) % window];
    const dl = await downloadPhoto(pick.thumbUrl || pick.url, { fetchImpl, timeoutMs: 8000 });
    if (!dl.ok) {
      attempts.push({ source: item.source, query: item.query, reason: dl.reason });
      continue;
    }
    return {
      ok: true,
      ...dl,
      provider: item.source,
      providerLabel:
        item.source === 'wikimedia-commons'
          ? '실제 사진 · 위키미디어 커먼즈'
          : item.source === 'wikipedia-en'
            ? '실제 사진 · Wikipedia (EN)'
            : '실제 사진 · 위키백과',
      title: pick.title,
      page: pick.page,
      license: pick.license || '',
      artist: pick.artist || '',
      width: pick.width,
      height: pick.height,
      query: item.query,
      score: pick.score,
      attempts,
      ms: Date.now() - started,
    };
  }

  return { ok: false, reason: 'no-photo', attempts, ms: Date.now() - started };
}

/** 화면·응답에 쓸 짧은 출처 한 줄. */
export function photoCredit(photo) {
  if (!photo || !photo.ok) return '';
  const bits = [];
  if (photo.title) bits.push(photo.title.replace(/^(File|파일):/i, '').replace(/\.(jpe?g|png|webp)$/i, ''));
  const who = photo.license ? `${photo.license}` : '';
  if (who) bits.push(who);
  if (photo.artist) bits.push(photo.artist.slice(0, 40));
  return bits.join(' · ');
}

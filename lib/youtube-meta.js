/**
 * lib/youtube-meta.js — 유튜브 영상 메타데이터·자동 자막 수집 (서버 전용)
 * ─────────────────────────────────────────────────────────────
 * 랭킹 모드에서 슬롯마다 URL 하나를 넣으면
 *   ① 영상 페이지(ytInitialPlayerResponse) → oEmbed → Data API(키가 있으면) 순서로 제목·길이·설명글
 *   ② 자동 자막(timedtext)은 시도하고, 유튜브가 서명/POT 제한으로 빈 응답을 주면 '못 받았다'고 남깁니다.
 *
 * 원칙
 *   · 실패해도 던지지 않습니다 — 어느 단계에서 무엇이 막혔는지 attempts 로 돌려줍니다.
 *   · 영상 파일 자체는 내려받지 않습니다(클라우드 IP 에서는 유튜브가 막습니다).
 *     클립은 브라우저에서 사용자가 직접 올리는 경로가 정답이고, 응답에 그 사실을 담아 보냅니다.
 */

export const YT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
export const YT_TIMEOUT_MS = 6500;

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

/** 영상 페이지 HTML 에서 ytInitialPlayerResponse 안의 videoDetails 를 꺼냅니다. */
export function extractPlayerDetails(html) {
  if (!html) return null;
  const marker = 'ytInitialPlayerResponse';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const braceAt = html.indexOf('{', at);
  if (braceAt < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceAt; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(braceAt, i + 1));
          const vd = parsed?.videoDetails || {};
          const tracks = parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const koTrack = tracks.find((t) => String(t.languageCode || '').toLowerCase().startsWith('ko')) || tracks[0];
          return {
            captionUrl: koTrack ? String(koTrack.baseUrl || '') : '',
            captionLang: koTrack ? String(koTrack.languageCode || '') : '',
            title: String(vd.title || ''),
            durationSec: Number(vd.lengthSeconds) || 0,
            description: String(vd.shortDescription || ''),
            keywords: Array.isArray(vd.keywords) ? vd.keywords : [],
            channel: String(vd.author || ''),
            thumbnail: String(vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || ''),
            isLive: Boolean(vd.isLiveContent),
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1500, timeoutMs));
  return fetchImpl(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** 유튜브 자동 자막(json3) 시도 — 실패하면 조용히 이유만 돌려줍니다. */
export async function fetchCaptions(captionUrl, { fetchImpl = DEFAULT_FETCH, timeoutMs = 5000 } = {}) {
  if (!captionUrl) return { ok: false, reason: 'no-caption-track' };
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${captionUrl}&fmt=json3`,
      { headers: { 'User-Agent': YT_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' } },
      timeoutMs,
    );
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const raw = await res.text();
    if (String(raw || '').trim().length < 20) return { ok: false, reason: 'empty' };
    let text = '';
    try {
      const data = JSON.parse(raw);
      text = (data.events || [])
        .map((e) => (e.segs || []).map((sg) => sg.utf8 || '').join(''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      text = String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (text.length < 40) return { ok: false, reason: 'too-short' };
    return { ok: true, text: text.slice(0, 4000) };
  } catch (err) {
    return { ok: false, reason: String(err?.name === 'AbortError' ? 'timeout' : err?.message || err).slice(0, 60) };
  }
}

async function getText(fetchImpl, url, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { 'User-Agent': YT_UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,application/xhtml+xml' } },
      timeoutMs,
    );
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: String(err?.name === 'AbortError' ? 'timeout' : err) };
  }
}

async function getJson(fetchImpl, url, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { 'User-Agent': YT_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' } },
      timeoutMs,
    );
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err?.name === 'AbortError' ? 'timeout' : err) };
  }
}

/**
 * 영상 하나의 공개 정보 + 자동 자막.
 * @returns {{ meta, transcript, transcriptNote, attempts }}
 */
export async function fetchYouTubeInfo(
  videoId,
  canonical,
  { fetchImpl = DEFAULT_FETCH, timeoutMs = YT_TIMEOUT_MS, dataApiKey = '' } = {},
) {
  const attempts = [];
  let meta = {
    title: '',
    channel: '',
    description: '',
    durationSec: 0,
    tags: [],
    thumbnail: '',
    fetchedBy: 'none',
  };
  let captionUrl = '';

  const page = await getText(fetchImpl, `https://www.youtube.com/shorts/${videoId}`, timeoutMs);
  if (page.ok) {
    const details = extractPlayerDetails(page.text);
    if (details && details.title) {
      captionUrl = details.captionUrl || '';
      meta = {
        title: details.title,
        channel: details.channel,
        description: details.description,
        durationSec: details.durationSec,
        tags: details.keywords,
        thumbnail: details.thumbnail,
        fetchedBy: 'page',
      };
      attempts.push({ step: 'youtube-page', ok: true });
    } else {
      attempts.push({ step: 'youtube-page', ok: false, reason: 'no-player-response' });
    }
  } else {
    attempts.push({ step: 'youtube-page', ok: false, reason: page.status ? `http-${page.status}` : page.error || 'failed' });
  }

  if (!meta.title) {
    const oembed = await getJson(
      fetchImpl,
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
      timeoutMs,
    );
    if (oembed.ok) {
      meta = {
        ...meta,
        title: String(oembed.data?.title || ''),
        channel: String(oembed.data?.author_name || ''),
        thumbnail: String(oembed.data?.thumbnail_url || ''),
        fetchedBy: 'oembed',
      };
      attempts.push({ step: 'oembed', ok: true });
    } else {
      attempts.push({ step: 'oembed', ok: false, reason: oembed.status ? `http-${oembed.status}` : oembed.error || 'failed' });
    }
  }

  if (dataApiKey) {
    const api = await getJson(
      fetchImpl,
      `https://www.googleapis.com/youtube/v3/videos?part=snippet%2CcontentDetails&id=${videoId}&key=${encodeURIComponent(dataApiKey)}`,
      timeoutMs,
    );
    if (api.ok && api.data?.items?.[0]) {
      const item = api.data.items[0];
      const snippet = item.snippet || {};
      const iso = String(item.contentDetails?.duration || '');
      const m = iso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      const dur = m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : meta.durationSec;
      meta = {
        ...meta,
        title: meta.title || String(snippet.title || ''),
        channel: meta.channel || String(snippet.channelTitle || ''),
        description: meta.description || String(snippet.description || ''),
        durationSec: meta.durationSec || dur,
        tags: meta.tags.length ? meta.tags : Array.isArray(snippet.tags) ? snippet.tags : [],
        thumbnail: meta.thumbnail || String(snippet.thumbnails?.high?.url || ''),
        fetchedBy: meta.fetchedBy === 'none' ? 'data-api' : meta.fetchedBy,
      };
      attempts.push({ step: 'youtube-data-api', ok: true });
    } else {
      attempts.push({ step: 'youtube-data-api', ok: false, reason: api.status ? `http-${api.status}` : 'no-items' });
    }
  } else {
    attempts.push({ step: 'youtube-data-api', ok: false, reason: 'no-key' });
  }

  let transcript = '';
  let transcriptNote = '';
  if (captionUrl) {
    const cap = await fetchCaptions(captionUrl, { fetchImpl });
    if (cap.ok) {
      transcript = cap.text;
      attempts.push({ step: 'captions', ok: true, chars: cap.text.length });
    } else {
      attempts.push({ step: 'captions', ok: false, reason: cap.reason });
      transcriptNote = `자동 자막을 받지 못했습니다(${cap.reason}). 제목만으로 코멘트를 씁니다.`;
    }
  } else {
    attempts.push({ step: 'captions', ok: false, reason: 'no-caption-track' });
    transcriptNote = '이 영상에는 쓸 수 있는 자동 자막이 없습니다. 제목만으로 코멘트를 씁니다.';
  }

  return { meta, transcript, transcriptNote, attempts };
}

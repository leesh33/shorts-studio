/**
 * api/analyze-and-generate.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/analyze-and-generate
 *   body: { url, topic, tone?, length?, cutCount?, style?, facts?, referenceText?, reference? }
 *   응답: { ok, analysis: { source, attempts, blueprint }, package }
 *
 * 하는 일
 *   ① 레퍼런스 쇼츠의 공개 메타데이터를 가져옵니다.
 *      - 유튜브 영상 페이지(제목·길이·설명글) → oEmbed(제목·채널·썸네일) → 실패해도 계속
 *      - YOUTUBE_API_KEY 가 있으면 Data API v3 로 한 번 더 보강
 *   ② 그 정보로 '레퍼런스 블루프린트'(훅 유형·리듬·컷 수·자막 스타일·템포)를 만듭니다.
 *   ③ 주제 한 줄로 새 쇼츠 패키지(5~15컷, 고른 길이 15~60초)를 만듭니다.
 *      - GEMINI_API_KEY 가 있으면 Gemini 가 레퍼런스를(영상까지) 보고 대본을 직접 씁니다 → mode: 'gemini'
 *      - 키가 없거나·시간 초과·형식 오류면 로컬 엔진 대본으로 조용히 폴백 → mode: 'template'
 *
 * 원칙
 *   · 어떤 업스트림이 실패해도 500으로 죽지 않습니다. 정보가 없으면 '추정'으로 표시합니다.
 *   · 키는 서버 환경변수에만 있고 응답에 담지 않습니다(응답에는 mode·모델명·시도 기록만).
 *   · CORS 를 열지 않아 이 사이트에서만 호출됩니다.
 */
import { analyzeReference, generatePackage, parseYouTubeUrl, resolveLength, lengthCatalog } from '../lib/engine.js';
import {
  SCRIPT_MODEL_FALLBACKS,
  buildScriptPrompt,
  buildScriptBody,
  parseScriptJson,
  normalizeAiScript,
  mergeScriptIntoPackage,
  mergeDnaIntoBlueprint,
  geminiReport,
} from '../lib/gemini.js';
import { callGeminiLadder } from '../lib/gemini-api.js';
import { enhanceImagePrompt, normalizeStyle, styleCatalog } from '../lib/visual-style.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const FETCH_TIMEOUT_MS = 6500;

/** Gemini 대본 호출 예산 — 레퍼런스 수집(≈12초) + Gemini(≈26초) 가 함수 시간(45초) 안에 들어옵니다. */
const GEMINI_BUDGET_MS = 26000;

function geminiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '').trim();
}

/** GEMINI_MODEL 이 있으면 그것부터, 그 뒤 기본 후보들. */
function scriptModels() {
  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const list = [];
  [preferred, ...SCRIPT_MODEL_FALLBACKS].forEach((m) => {
    const name = String(m || '').trim();
    if (name && list.indexOf(name) < 0) list.push(name);
  });
  return list;
}

/** Gemini 가 쓴 대본을 패키지에 입힙니다. 실패하면 { ok:false, report } 만 돌려줍니다. */
async function writeWithGemini({ apiKey, url, topic, tone, targetLen, cutCount, meta, transcript, facts, blueprint, basePkg, style }) {
  const prompt = buildScriptPrompt({
    topic,
    tone,
    targetLen,
    cutCount,
    meta,
    transcript,
    facts,
    blueprint,
    style,
  });
  const modes = url ? ['video', 'text'] : ['text'];
  const ladder = await callGeminiLadder({
    apiKey,
    models: scriptModels(),
    modes,
    timeoutMs: 20000,
    budgetMs: GEMINI_BUDGET_MS,
    buildBody: ({ model, mode }) =>
      buildScriptBody({ prompt, referenceUrl: url, useVideo: mode === 'video', model }),
  });

  if (!ladder.ok) {
    return { ok: false, report: geminiReport({ ok: false, ms: ladder.ms, attempts: ladder.attempts, reason: ladder.reason }) };
  }

  const parsed = parseScriptJson(ladder.text);
  if (!parsed.ok) {
    return {
      ok: false,
      report: geminiReport({ ok: false, ms: ladder.ms, attempts: ladder.attempts, reason: parsed.reason }),
    };
  }

  const normalized = normalizeAiScript(parsed.data, { topic, tone, targetLen, cutCount, blueprint });
  if (!normalized.ok) {
    return {
      ok: false,
      report: geminiReport({ ok: false, ms: ladder.ms, attempts: ladder.attempts, reason: normalized.reason }),
    };
  }

  const pkg = mergeScriptIntoPackage(basePkg, normalized, { topic, blueprint, facts });
  const nextBlueprint = mergeDnaIntoBlueprint(blueprint, normalized.dna, {
    model: ladder.model,
    videoWatched: ladder.usedMode === 'video',
  });
  return {
    ok: true,
    pkg,
    blueprint: nextBlueprint,
    report: geminiReport({ ok: true, model: ladder.model, ms: ladder.ms, attempts: ladder.attempts }),
    extra: { videoWatched: ladder.usedMode === 'video', warnings: normalized.warnings },
  };
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err?.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: String(err?.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 영상 페이지 HTML 에서 ytInitialPlayerResponse 안의 videoDetails 를 꺼냅니다. */
export function extractPlayerDetails(html) {
  if (!html) return null;
  const marker = 'ytInitialPlayerResponse';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const braceAt = html.indexOf('{', at);
  if (braceAt < 0) return null;
  // 문자열을 세면서 첫 번째 균형 잡힌 JSON 객체를 잘라냅니다.
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

/** 유튜브 자동 자막(json3)을 시도합니다. 실패하면 조용히 포기합니다. */
async function fetchCaptions(captionUrl) {
  if (!captionUrl) return { ok: false, reason: 'no-caption-track' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${captionUrl}&fmt=json3`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const raw = await res.text();
    if (raw.trim().length < 20) return { ok: false, reason: 'empty' };
    let text = '';
    try {
      const data = JSON.parse(raw);
      text = (data.events || [])
        .map((e) => (e.segs || []).map((sg) => sg.utf8 || '').join(''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (text.length < 40) return { ok: false, reason: 'too-short' };
    return { ok: true, text: text.slice(0, 4000) };
  } catch (err) {
    return { ok: false, reason: String(err?.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReference(videoId, canonical) {
  const attempts = [];
  let meta = { title: '', channel: '', description: '', durationSec: 0, tags: [], thumbnail: '', fetchedBy: 'none' };

  let captionUrl = '';
  const page = await getText(`https://www.youtube.com/shorts/${videoId}`);
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
    const oembed = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`);
    if (oembed.ok) {
      meta = {
        ...meta,
        title: String(oembed.data.title || ''),
        channel: String(oembed.data.author_name || ''),
        thumbnail: String(oembed.data.thumbnail_url || ''),
        fetchedBy: 'oembed',
      };
      attempts.push({ step: 'oembed', ok: true });
    } else {
      attempts.push({ step: 'oembed', ok: false, reason: oembed.status ? `http-${oembed.status}` : oembed.error || 'failed' });
    }
  }

  const key = process.env.YOUTUBE_API_KEY || process.env.EXPO_PUBLIC_YOUTUBE_API_KEY || '';
  if (key) {
    const api = await getJson(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet%2CcontentDetails&id=${videoId}&key=${encodeURIComponent(key)}`,
    );
    if (api.ok && api.data?.items?.[0]) {
      const item = api.data.items[0];
      const snippet = item.snippet || {};
      const iso = String(item.contentDetails?.duration || '');
      const m = iso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      const dur = m ? (Number(m[1] || 0) * 60) + Number(m[2] || 0) : meta.durationSec;
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
  if (captionUrl) {
    const cap = await fetchCaptions(captionUrl);
    if (cap.ok) {
      transcript = cap.text;
      attempts.push({ step: 'captions', ok: true, chars: cap.text.length });
    } else {
      attempts.push({ step: 'captions', ok: false, reason: cap.reason });
    }
  }

  return { meta, attempts, transcript };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 405, { ok: false, error: 'method-not-allowed' });

  let body = {};
  if (req.method === 'POST') {
    body = await readBody(req);
  } else if (req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    body = Object.fromEntries(q.entries());
  } else {
    return send(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  const url = String(body.url || '').trim();
  const topic = String(body.topic || '').trim();
  const parsed = parseYouTubeUrl(url);
  if (!parsed.ok) {
    return send(res, 400, {
      ok: false,
      error: parsed.error,
      message: '유튜브 쇼츠 주소를 확인해 주세요. (예: https://www.youtube.com/shorts/영상ID)',
    });
  }
  if (!topic) {
    return send(res, 400, { ok: false, error: 'no-topic', message: '만들 주제를 한 줄로 입력해 주세요.' });
  }

  // ① 레퍼런스 분석 (클라이언트가 이미 받아둔 blueprint 가 있으면 재사용)
  let blueprint = body.reference && typeof body.reference === 'object' ? body.reference : null;
  let analysis = { source: 'client-cache', attempts: [{ step: 'client-cache', ok: true }] };
  let refMeta = null;
  let transcriptText = '';

  if (!blueprint || !blueprint.source) {
    const { meta, attempts, transcript } = await fetchReference(parsed.videoId, parsed.canonical);
    const userText = String(body.referenceText || '').slice(0, 4000);
    const scriptText = userText || transcript || '';
    refMeta = meta;
    transcriptText = scriptText;
    blueprint = analyzeReference({
      url: parsed.canonical,
      topic,
      title: meta.title,
      channel: meta.channel,
      description: meta.description,
      durationSec: meta.durationSec,
      tags: meta.tags,
      thumbnail: meta.thumbnail,
      referenceText: scriptText,
      transcriptAuto: Boolean(!userText && transcript),
      fetchedBy: meta.fetchedBy,
    });
    analysis = { source: meta.fetchedBy, attempts, transcriptChars: scriptText.length, transcriptAuto: Boolean(!userText && transcript) };
  }

  // ② 새 쇼츠 패키지 — 로컬 엔진(폴백 겸 기본 뼈대)
  const tone = String(body.tone || 'auto');
  const facts = String(body.facts || '').slice(0, 4000);
  const visualStyle = normalizeStyle(body.style);
  // 길이·컷 수 — 화면의 선택기에서 온 값을 그대로 씁니다(15/30/45/60초 · 5/8/11/15컷).
  const plan = resolveLength(body.length, body.cutCount);
  let pkg;
  try {
    pkg = generatePackage({
      topic,
      tone,
      length: plan.sec,
      cutCount: plan.cuts,
      facts,
      blueprint,
    });
  } catch (err) {
    return send(res, 500, { ok: false, error: 'generate-failed', message: '생성 중 문제가 생겼습니다. 주제를 조금 바꿔 다시 시도해 주세요.' });
  }

  // ③ Gemini 가 있으면 진짜 대본을 씁니다 (없거나 실패하면 ② 를 그대로 씁니다)
  const apiKey = geminiKey();
  let mode = 'template';
  let gemini = { ok: false, reason: apiKey ? 'not-attempted' : 'no-key' };
  if (apiKey) {
    const meta = {
      title: refMeta?.title || blueprint.source?.title || '',
      channel: refMeta?.channel || blueprint.source?.channel || '',
      description: refMeta?.description || blueprint.source?.description || '',
      durationSec: refMeta?.durationSec || blueprint.source?.durationSec || 0,
      tags: refMeta?.tags?.length ? refMeta.tags : blueprint.source?.hashtags || [],
    };
    try {
      const result = await writeWithGemini({
        apiKey,
        url: parsed.canonical,
        topic,
        tone,
        targetLen: plan.sec,
        cutCount: plan.cuts,
        meta,
        transcript: String(body.referenceText || '').slice(0, 4000) || transcriptText || '',
        facts,
        blueprint,
        basePkg: pkg,
        style: visualStyle,
      });
      gemini = result.report;
      if (result.ok) {
        pkg = result.pkg;
        blueprint = result.blueprint;
        mode = 'gemini';
        analysis = { ...analysis, geminiVideoWatched: result.extra.videoWatched, geminiWarnings: result.extra.warnings };
      }
    } catch (err) {
      gemini = { ok: false, reason: String(err?.message || err).slice(0, 120) };
    }
  } else {
    gemini = { ok: false, reason: 'no-key' };
  }

  // ④ 컷 장면 프롬프트에 비주얼 스타일을 입힙니다 — 대본(로컬·Gemini) 어느 경로든 같은 결과.
  //    이미지 생성 단계에서도 같은 함수가 불리지만(중복 방지), 여기서 입혀 두면
  //    '장면 프롬프트' 복사와 컷 카드에도 스타일이 그대로 보입니다.
  pkg = {
    ...pkg,
    cuts: pkg.cuts.map((cut) => ({ ...cut, visualPrompt: enhanceImagePrompt(cut.visualPrompt, visualStyle) })),
    meta: {
      ...pkg.meta,
      visualStyle,
      // 주제 단위 실제 피사체 — 컷별 검색어가 추상적일 때(예: '비상계단') 이 이름으로 다시 찾습니다.
      photoSubject: pkg.meta.photoSubject || '',
      photoSubjectEn: pkg.cuts.find((cut) => cut.photoEn)?.photoEn || '',
    },
  };

  return send(res, 200, {
    ok: true,
    mode,
    gemini,
    visualStyle,
    visualStyles: styleCatalog(),
    length: { sec: plan.sec, cuts: plan.cuts, label: plan.label, preset: Boolean(plan.preset) },
    lengthOptions: lengthCatalog(),
    analysis: { ...analysis, blueprint },
    package: { ...pkg, meta: { ...pkg.meta, mode, length: plan.sec, lengthLabel: plan.label } },
  });
}

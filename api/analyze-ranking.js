/**
 * api/analyze-ranking.js — Vercel Serverless Function (🏆 TOP 5 랭킹 모드)
 * ─────────────────────────────────────────────────────────────
 * POST /api/analyze-ranking
 *   ① mode: "slot"   { url, topic? }
 *      → 슬롯 하나의 유튜브 제목·채널·길이·썸네일 + 자동 자막(있으면)
 *        + 자막에서 뽑은 한 줄 코멘트 후보
 *   ② mode: "script" { topic, slots:[{rank,url,title,caption}] }
 *      → TOP 5 → TOP 1 코멘트 대본 (Gemini, 없으면 로컬 템플릿 폴백 · mode 로 표시)
 *
 * GET /api/analyze-ranking → 이 엔드포인트가 무엇을 하는지·키 유무(값 아님)
 *
 * 정직하게 말하는 것
 *   · 유튜브 **영상 파일**은 클라우드에서 내려받지 않습니다(약관·서명 제한). 클립은 브라우저에서
 *     사용자가 직접 올리는 경로가 정답입니다 — 응답의 clipDownload 에 그 사실을 담아 보냅니다.
 *   · 자동 자막을 못 받으면 transcriptNote 에 이유를 남기고, 제목만으로 코멘트를 씁니다.
 *   · GEMINI_API_KEY 가 없거나 실패하면 mode: "template" — 로컬 템플릿임을 숨기지 않습니다.
 *   · 키는 응답 어디에도 담지 않습니다.
 */
import { parseYouTubeUrl } from '../lib/engine.js';
import { fetchYouTubeInfo } from '../lib/youtube-meta.js';
import {
  RANKS,
  buildRankingPrompt,
  highlightSuggestion,
  localRankingScript,
  normalizeSlots,
  parseRankingScript,
  readRankingBody,
} from '../lib/ranking.js';
import { SCRIPT_MODEL_FALLBACKS, textFromGemini } from '../lib/gemini.js';
import { callGeminiLadder } from '../lib/gemini-api.js';

/** 클라우드에서 유튜브 영상 파일을 못 받는 이유 — 화면이 그대로 보여 줍니다. */
export const CLIP_DOWNLOAD = {
  available: false,
  note: '유튜브 영상 파일은 서버(클라우드)에서 내려받을 수 없습니다(약관·서명 제한). 클립은 브라우저에서 직접 올려 주세요 — MP4·MOV·WebM 모두 됩니다.',
};

const GEMINI_BUDGET_MS = 24000;

function geminiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '').trim();
}

function scriptModels() {
  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const list = [];
  [preferred, ...SCRIPT_MODEL_FALLBACKS].forEach((name) => {
    const trimmed = String(name || '').trim();
    if (trimmed && !list.includes(trimmed)) list.push(trimmed);
  });
  return list;
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

/** URL 하나 → 슬롯 정보(실패해도 200, ok:false 대신 빈 정보 + 사유). */
async function slotInfo(url, topic) {
  const parsed = parseYouTubeUrl(url);
  if (!parsed.ok) {
    return {
      ok: false,
      url,
      reason: parsed.error,
      message: '유튜브 주소를 확인해 주세요. (예: https://www.youtube.com/shorts/영상ID)',
    };
  }
  const { meta, transcript, transcriptNote, attempts } = await fetchYouTubeInfo(parsed.videoId, parsed.canonical, {
    dataApiKey: String(process.env.YOUTUBE_API_KEY || '').trim(),
  });
  const suggestion = highlightSuggestion(transcript, { title: meta.title });
  const notices = [];
  if (transcriptNote) notices.push(transcriptNote);
  if (!meta.title) notices.push('영상 제목을 가져오지 못했습니다. 제목을 직접 적어 주세요.');
  return {
    ok: Boolean(meta.title || transcript),
    videoId: parsed.videoId,
    url: parsed.canonical,
    title: meta.title,
    channel: meta.channel,
    durationSec: meta.durationSec,
    thumbnail: meta.thumbnail,
    fetchedBy: meta.fetchedBy,
    transcript,
    transcriptChars: transcript.length,
    transcriptNote,
    captionSuggestion: suggestion,
    topic: String(topic || ''),
    attempts,
    notices,
  };
}

/** Gemini 로 랭킹 대본. 실패하면 { ok:false, report } — 호출부가 로컬로 폴백합니다. */
async function writeRankingWithGemini({ apiKey, topic, slots }) {
  const prompt = buildRankingPrompt({ topic, slots });
  const ladder = await callGeminiLadder({
    apiKey,
    models: scriptModels(),
    modes: ['text'],
    timeoutMs: 20000,
    budgetMs: GEMINI_BUDGET_MS,
    buildBody: ({ model }) => ({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        topP: 0.95,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        thinkingConfig: /lite/i.test(model) ? { thinkingLevel: 'MINIMAL' } : { thinkingLevel: 'LOW' },
      },
    }),
  });
  const report = {
    ok: Boolean(ladder.ok),
    model: ladder.model || '',
    ms: ladder.ms || 0,
    attempts: ladder.attempts || [],
    reason: ladder.ok ? '' : ladder.reason || 'gemini-failed',
  };
  if (!ladder.ok) return { ok: false, report };
  const parsed = parseRankingScript(ladder.text || textFromGemini(ladder.json));
  if (!parsed.ok) return { ok: false, report: { ...report, ok: false, reason: parsed.reason, parsed: parsed.slots.length } };
  return { ok: true, report, ranking: { hook: parsed.hook, slots: parsed.slots } };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const hasKey = Boolean(geminiKey());
    return send(res, 200, {
      ok: true,
      endpoint: 'analyze-ranking',
      ranks: RANKS,
      engine: hasKey ? 'gemini' : 'template',
      hasGeminiKey: hasKey,
      clipDownload: CLIP_DOWNLOAD,
      note: 'TOP 5 → TOP 1 랭킹 대본·코멘트를 만듭니다. 키가 없으면 로컬 템플릿으로 폴백합니다.',
    });
  }
  if (req.method === 'OPTIONS') return send(res, 405, { ok: false, error: 'method-not-allowed' });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' });

  const body = await readBody(req);
  const { mode, topic, slots } = readRankingBody(body);

  /* ── ① 슬롯 하나 정보 ───────────────────────────────────────── */
  if (mode === 'slot') {
    const url = String(body.url || '').trim();
    if (!url) return send(res, 400, { ok: false, error: 'no-url', message: '유튜브 주소를 입력해 주세요.' });
    const info = await slotInfo(url, topic);
    if (!info.ok && info.reason) return send(res, 400, { ok: false, error: info.reason, message: info.message });
    const rank = Number(body.rank) || 0;
    return send(res, 200, { ok: true, rank, slot: { ...info, rank }, clipDownload: CLIP_DOWNLOAD });
  }

  /* ── ② 랭킹 대본 ──────────────────────────────────────────── */
  const anything = topic || slots.some((slot) => slot.url || slot.title || slot.caption);
  if (!anything) {
    return send(res, 400, {
      ok: false,
      error: 'no-topic',
      message: '영상 제목(주제)이나 항목을 하나 이상 입력해 주세요.',
    });
  }

  const notices = [];
  const sources = [];
  const withInfo = await Promise.all(
    slots.map(async (slot) => {
      if (!slot.url) return slot;
      const info = await slotInfo(slot.url, topic);
      if (info.reason) {
        notices.push(`TOP ${slot.rank}: ${info.message || '영상 정보를 가져오지 못했습니다.'}`);
        return slot;
      }
      (info.notices || []).forEach((note) => notices.push(`TOP ${slot.rank}: ${note}`));
      sources.push({
        rank: slot.rank,
        url: info.url,
        title: info.title,
        fetchedBy: info.fetchedBy,
        transcriptChars: info.transcriptChars,
        transcriptNote: info.transcriptNote,
      });
      return {
        ...slot,
        videoId: info.videoId || slot.videoId,
        ytTitle: info.title || slot.ytTitle,
        ytChannel: info.channel || slot.ytChannel,
        ytDurationSec: info.durationSec || slot.ytDurationSec,
        ytTranscript: info.transcript || '',
        ytNote: info.transcriptNote || '',
        ytFetchedBy: info.fetchedBy || '',
        caption: slot.caption || info.captionSuggestion || '',
        title: slot.title || info.title || '',
      };
    }),
  );
  const prepared = normalizeSlots(withInfo);

  const apiKey = geminiKey();
  let mode2 = 'template';
  let gemini = { ok: false, model: '', ms: 0, attempts: [], reason: apiKey ? 'not-attempted' : 'no-key' };
  let ranking = localRankingScript({ topic, slots: prepared });
  const sourcesByRank = prepared.map((slot) => ({
    rank: slot.rank,
    url: slot.url,
    title: slot.ytTitle || slot.title,
    transcriptChars: String(slot.ytTranscript || '').length,
    transcriptNote: slot.ytNote,
    fetchedBy: slot.ytFetchedBy,
  }));

  if (apiKey) {
    try {
      const result = await writeRankingWithGemini({ apiKey, topic, slots: prepared });
      gemini = result.report;
      if (result.ok) {
        ranking = { mode: 'gemini', hook: result.ranking.hook, slots: result.ranking.slots };
        mode2 = 'gemini';
        notices.unshift('Gemini 가 자막 발췌를 보고 랭킹 코멘트를 다시 썼습니다.');
      } else {
        notices.unshift('Gemini 대본을 받지 못해 로컬 템플릿으로 만들었습니다 — 제목을 다듬은 문장입니다.');
      }
    } catch (err) {
      gemini = { ...gemini, ok: false, reason: String(err?.message || err).slice(0, 120) };
      notices.unshift('Gemini 호출이 실패해 로컬 템플릿으로 만들었습니다.');
    }
  } else {
    notices.unshift('GEMINI_API_KEY 가 없어 로컬 템플릿으로 만들었습니다 — 제목을 다듬은 문장입니다.');
  }

  return send(res, 200, {
    ok: true,
    mode: mode2,
    gemini,
    ranking,
    sources: sources.length ? sources : sourcesByRank,
    notices,
    clipDownload: CLIP_DOWNLOAD,
    ranks: RANKS,
  });
}

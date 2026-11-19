/**
 * app.js — TakeOne(테이크원) · AI 쇼츠 스튜디오
 * 입력 → /api/analyze-and-generate(실제 레퍼런스 분석 + 대본 생성) → Viral DNA · 씬 대본 → 9:16 라이브 미리보기
 */
import {
  parseYouTubeUrl,
  stripMarkup,
  emphasisWords,
  ensureEmphasis,
  buildSrt,
  STRATEGY_INFO,
} from './lib/engine.js';
import { applyCutEdit, cutEditStats, narrationKey, speechText, staleNarrationKeys } from './lib/cut-edit.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  pkg: null,
  blueprint: null,
  loading: false,
  playerOpen: false,
  mode: 'template',
  gemini: null,
  hasGeminiKey: null,
  /** 비주얼 스타일 — 대본·이미지 프롬프트에 같은 값을 씁니다. */
  visualStyle: '3d',
  /** 영상 길이 — 화면 선택기(15/30/45/60초)의 값. 컷 수도 함께 정해집니다. */
  lengthSec: 30,
  cutCount: 8,
  /** 내레이션 때문에 영상이 길어졌다는 안내를 한 번만 보여 줍니다. */
  lengthNoticeShown: false,
};

/** 화면 토글과 요청 본문이 같은 이름을 쓰도록 한 곳에 모읍니다(서버 lib/visual-style.js 와 짝). */
const VISUAL_STYLES = {
  video: { label: '움직이는 영상', emoji: '🎬' },
  real: { label: '실제 사진', emoji: '📷' },
  '3d': { label: '3D 입체 렌더링', emoji: '🎨' },
  cinematic: { label: '실사 시네마틱', emoji: '🎥' },
};

/** 길이 선택기 — 서버 lib/engine.js LENGTH_PRESETS 와 같은 값 */
const LENGTH_OPTIONS = [
  { sec: 15, cuts: 5, note: '짧은 훅 · 한 가지 메시지' },
  { sec: 30, cuts: 8, note: '숏츠 기본 길이' },
  { sec: 45, cuts: 11, note: '스토리 전개 · 포인트 7개' },
  { sec: 60, cuts: 15, note: '롱폼 숏츠 · 최대 길이' },
];

/** 내레이션 음성 — 'browser' 는 서버 TTS 없이 Web Speech 로 읽습니다. */
const NARRATION_VOICES = {
  deep: { label: '중후한 남성', pill: '중후한 남성 · 기본' },
  docu: { label: '차분한 다큐 톤', pill: '차분한 다큐 톤' },
  browser: { label: '브라우저 음성', pill: '브라우저 음성' },
};

/** 서버 TTS(/api/tts) 음성 캐시 + Web Audio 재생기 상태 */
const narration = {
  voice: 'deep',
  ctx: null,
  gain: null,
  cache: new Map(),
  sources: [],
  failed: 0,
};

/* AI 이미지 생성 상태 — 한 컷씩 순서대로 만듭니다(한도·시간 보호) */
const ai = { running: false, done: 0, failed: 0, error: '', providers: {}, rounds: 0, total: 0 };
/** 무료 경로 재시도 횟수 — 익명 Pollinations 한도(45초/1장)를 넘기려면 몇 차례 파도가 필요합니다. */
const AI_MAX_ROUNDS = 4;
/* 영상 내보내기 상태 */
const exporter = { running: false, recorder: null, cancelled: false };

/** 9:16 플레이어에 붙은 컷별 <video> — 미리보기와 내보내기가 같은 요소를 씁니다. */
const cutVideos = new Map();
/** 내보내기용 로드 상태 — index → 'loading' | 'ready' | 'failed' */
const videoLoad = new Map();

const player = {
  playing: false,
  t: 0,
  total: 0,
  raf: 0,
  last: 0,
  mute: false,
  rate: 1.21,
  idx: -1,
  beatIdx: -1,
  voice: null,
};

/* ───────────────────────── 토스트 / 진행률 ───────────────────────── */

let toastTimer = 0;
function toast(message) {
  const el = $('#toast');
  $('#toastText').textContent = message;
  el.classList.remove('opacity-0', 'translate-y-4', 'pointer-events-none');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('opacity-0', 'translate-y-4', 'pointer-events-none'), 2600);
}

const progress = { value: 0, timer: 0, ceiling: 88 };

function paintProgress() {
  $('#progressBar').style.width = `${Math.round(progress.value)}%`;
  $('#progressPct').textContent = `${Math.round(progress.value)}%`;
  const stepNow = progress.value >= 88 ? 2 : progress.value >= 40 ? 1 : 0;
  $$('#stepList [data-step]').forEach((row, i) => {
    const mark = row.querySelector('.step-mark');
    const text = row.querySelector('.step-text');
    const live = row.querySelector('.step-live');
    const done = progress.value >= 100 || i < stepNow;
    const active = !done && i === stepNow;
    mark.className = `step-mark w-6 h-6 rounded-full flex items-center justify-center text-xs ${
      done ? 'bg-emerald-500/20 text-emerald-400' : active ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-slate-600'
    }`;
    mark.textContent = done ? '✓' : String(i + 1);
    text.className = `step-text text-sm ${active ? 'text-white' : done ? 'text-slate-300' : 'text-slate-500'}`;
    live.classList.toggle('hidden', !active);
  });
}

function startProgress() {
  progress.value = 4;
  progress.ceiling = 88;
  paintProgress();
  clearInterval(progress.timer);
  progress.timer = setInterval(() => {
    // 실제 응답을 기다리는 동안에만 차오릅니다 (끝까지 가면 실제 완료).
    progress.value += (progress.ceiling - progress.value) * 0.06;
    paintProgress();
  }, 120);
}

function finishProgress() {
  clearInterval(progress.timer);
  progress.value = 100;
  paintProgress();
  setTimeout(() => $('#progressPanel').classList.add('hidden'), 1400);
}

function abortProgress() {
  clearInterval(progress.timer);
  progress.value = 0;
  paintProgress();
  $('#progressPanel').classList.add('hidden');
}

function setLoading(on) {
  state.loading = on;
  $('#generateBtn').disabled = on;
  $('#btnSpinner').classList.toggle('hidden', !on);
  $('#btnArrow').classList.toggle('hidden', on);
  $('#btnLabel').textContent = on ? 'AI 분석 진행 중...' : '✨ AI 벤치마킹 & 대본 생성';
  if (on) $('#progressPanel').classList.remove('hidden');
}

/* ───────────────────────── 생성 ───────────────────────── */

async function generate(event) {
  event.preventDefault();
  if (state.loading) return;

  const url = $('#urlInput').value.trim();
  const topic = $('#topicInput').value.trim();

  if (!url.trim() || !topic.trim()) {
    toast('URL과 새로운 주제를 모두 입력해 주세요.');
    return;
  }
  const parsed = parseYouTubeUrl(url);
  if (!parsed.ok) {
    toast('올바른 YouTube Shorts URL을 입력해 주세요.');
    return;
  }

  setLoading(true);
  state.lengthNoticeShown = false;
  startProgress();
  closePlayer();
  editQueue.forEach((timer) => clearTimeout(timer));
  editQueue.clear();
  $('#resultSection').classList.add('hidden');

  try {
    const res = await fetch('/api/analyze-and-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: parsed.canonical,
        topic,
        tone: 'auto',
        length: state.lengthSec,
        cutCount: state.cutCount,
        style: state.visualStyle,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw new Error((data && data.message) || `요청 실패 (HTTP ${res.status})`);

    state.pkg = data.package;
    state.mode = data.mode || data.package?.meta?.mode || 'template';
    state.gemini = data.gemini || null;
    if (data.length?.sec) state.lengthSec = data.length.sec;
    if (data.package?.cuts?.length) state.cutCount = data.package.cuts.length;
    paintLengthPicker();
    state.pkg.cuts.forEach((cut) => {
      cut.beats = buildBeats(cut);
    });
    state.blueprint = data.analysis?.blueprint || data.package.reference;
    finishProgress();
    renderResult(data.analysis);
    $('#resultSection').classList.remove('hidden');
    $('#resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    abortProgress();
    toast(String(err.message || err));
  } finally {
    setLoading(false);
  }
}

/* ───────────────────────── 결과 렌더 ───────────────────────── */

function two(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}
function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${two(s / 60)}:${two(s % 60)}`;
}

function renderResult(analysis) {
  const pkg = state.pkg;
  const bp = state.blueprint;

  paintModeBadge();
  $('#resultSub').textContent = `${pkg.meta.strategyLabel} · ${pkg.cuts.length}컷 · 약 ${Math.round(pkg.meta.totalSec)}초`;
  $('#scriptTopic').textContent = pkg.meta.topic;
  $('#scriptMeta').textContent = `총 ${Math.round(pkg.meta.totalSec)}초 · 컷당 ${(pkg.meta.totalSec / pkg.cuts.length).toFixed(1)}초 · 템포 ${pkg.tts.rate}x · ${styleLabel()}`;

  /* Viral DNA */
  const hook = bp.hook || {};
  $('#dnaHook').textContent = hook.label || '호기심 갭 훅';
  $('#dnaHookDesc').textContent = hook.why || '첫 문장에서 결론을 미루는 구조';

  const rhythm = bp.rhythm || {};
  const aiDna = bp.ai || null;
  if (rhythm.measured) {
    $('#dnaCaption').textContent = `${Math.max(6, rhythm.avgSentenceChars - 3)}~${rhythm.avgSentenceChars + 3}자`;
    $('#dnaCaptionDesc').textContent = aiDna?.captionStyle
      ? aiDna.captionStyle
      : `레퍼런스 대사 평균 ${rhythm.avgSentenceChars}자 · 짧고 직관적인 자막`;
  } else {
    $('#dnaCaption').textContent = `${bp.subtitle?.maxCharsPerLine || 18}자 이내`;
    $('#dnaCaptionDesc').textContent = aiDna?.captionStyle || '숏츠 표준값 · 짧고 직관적인 자막';
  }

  $('#dnaPace').textContent = `${bp.pacing?.tempo || 1.21}x · 컷당 ${bp.pacing?.cutSecAvg || 5}초`;
  $('#dnaPaceDesc').textContent = aiDna?.pacing || (rhythm.wpm ? `분당 ${rhythm.wpm}어절 · 무음 없이 이어 붙이기` : '1~3초 단위 화면 전환 · 무음 없음');

  const srcMap = { page: '영상 페이지', oembed: 'oEmbed', 'data-api': 'YouTube API', none: '메타데이터 없음' };
  const modeNote = state.mode === 'gemini' ? ` · Gemini 분석${state.gemini?.model ? ` (${state.gemini.model})` : ''}` : ' · 로컬 엔진 분석';
  $('#dnaSource').textContent = bp.source?.title
    ? `${bp.source.title.slice(0, 70)} · ${bp.source.channel || '채널 미확인'} · ${bp.source.durationKnown ? `${bp.source.durationSec}초` : '길이 추정'} · 읽은 경로: ${srcMap[bp.source.fetchedBy] || bp.source.fetchedBy}${modeNote}`
    : `레퍼런스 메타데이터를 못 가져와 표준값으로 분석했습니다.${modeNote}`;

  $('#dnaEvidence').innerHTML = (bp.evidence || []).map((line) => `<li>· ${escapeHtml(line)}</li>`).join('');

  /* Scenes */
  const list = $('#scenesList');
  list.innerHTML = '';
  pkg.cuts.forEach((cut, i) => {
    const card = document.createElement('article');
    const stats = cutEditStats(cut);
    card.className = 'rounded-2xl bg-[#131B2E] border border-white/10 p-6 hover:border-violet-500/40 transition';
    card.dataset.cue = String(i);
    card.innerHTML = `
      <div class="flex items-center justify-between mb-5 gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <span class="text-violet-400 font-black text-xl leading-none">${two(i + 1)}</span>
          <div class="min-w-0">
            <h5 class="font-bold">Scene ${i + 1}<span data-edited="${i}" class="${
              cut.edited ? '' : 'hidden '
            }ml-2 align-middle text-[10px] font-bold text-amber-300 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded-full">수정됨</span></h5>
            <p class="text-xs text-slate-500">${escapeHtml(cut.label)}</p>
          </div>
        </div>
        <span data-time="${i}" class="shrink-0 text-xs text-slate-400 bg-white/5 px-3 py-2 rounded-full">${clock(cut.start)} - ${clock(cut.end)}</span>
      </div>
      <div class="grid md:grid-cols-2 gap-4">
        <div class="bg-[#0B1020] rounded-xl p-5">
          <div class="flex items-center justify-between gap-2 mb-2">
            <p class="text-xs text-violet-400 font-bold">🎙 내레이션 · 음성</p>
            <span data-count="narration" class="shrink-0 text-[10px] text-slate-500">${stats.narration}자</span>
          </div>
          <textarea
            data-edit="narration"
            data-cut="${i}"
            rows="3"
            spellcheck="false"
            aria-label="Scene ${i + 1} 내레이션 (음성으로 읽는 대사)"
            class="edit-field block w-full resize-y min-h-[5.5rem] bg-[#0F1526] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-sm leading-6 text-slate-200 outline-none focus:border-violet-500 focus:bg-[#121A2E] transition"
          >${escapeHtml(cut.narration ?? stripMarkup(cut.subtitle))}</textarea>
          <div class="flex items-center justify-between gap-2 mb-2 mt-4">
            <p class="text-xs text-sky-300 font-bold">💬 자막 · 화면</p>
            <span data-count="subtitle" class="shrink-0 text-[10px] text-slate-500">${stats.subtitle}자</span>
          </div>
          <textarea
            data-edit="subtitle"
            data-cut="${i}"
            rows="2"
            spellcheck="false"
            aria-label="Scene ${i + 1} 자막 (화면에 뜨는 글자)"
            class="edit-field block w-full resize-y min-h-[3.5rem] bg-[#0F1526] border border-white/10 rounded-lg px-3 py-2 text-base sm:text-sm leading-6 text-slate-200 outline-none focus:border-violet-500 focus:bg-[#121A2E] transition"
          >${escapeHtml(cut.subtitle)}</textarea>
          <p data-preview="${i}" class="mt-3 min-h-[1.25rem] border-l-2 border-violet-500/30 pl-2 text-xs leading-5 text-slate-400 break-keep">${highlight(cut.subtitle)}</p>
          <p class="mt-1 text-[10px] leading-5 text-slate-600">[강조] 로 감싼 말은 화면에서 보라색 · 고치면 9:16 미리보기·음성·자막 파일에 바로 반영됩니다.</p>
        </div>
        <div class="bg-[#0B1020] rounded-xl p-5">
          <div class="flex gap-4">
            <div class="min-w-0 flex-1">
              <p class="text-xs text-blue-400 font-bold mb-3">🎬 VISUAL DIRECTION</p>
              <p class="text-sm leading-7 text-slate-400">${escapeHtml(cut.visualKo)}<span class="block mt-1 text-slate-500">카메라: ${escapeHtml(cut.camera)}</span></p>
            </div>
            <div data-shot="${i}" class="hidden w-20 shrink-0 rounded-lg overflow-hidden border border-white/10 bg-black">
              <img class="w-full h-full object-cover" alt="${escapeHtml(cut.label)} 장면" />
            </div>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <span data-kind="${i}" class="hidden text-[10px] font-bold px-2 py-1 rounded-full border"></span>
            <button type="button" data-regen="${i}" class="shrink-0 text-[10px] font-bold px-2 py-1 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-slate-200 transition">🔄 이 컷 장면 다시</button>
            <span data-credit="${i}" class="hidden min-w-0 flex-1 truncate text-[10px] text-slate-600"></span>
          </div>
        </div>
      </div>
      <p class="mt-3 text-[11px] text-slate-600">${escapeHtml(/^확인/.test(String(cut.factHint || '')) ? cut.factHint : `확인: ${cut.factHint || ''}`)}</p>
    `;
    list.appendChild(card);
  });
  // 카드의 장면 배지·다시 만들기 문구를 지금 스타일에 맞춥니다(실제 사진이면 '📷 실제 사진 찾기').
  pkg.cuts.forEach((_, i) => paintCutImageMeta(i));
}

function highlight(text) {  // [강조] 표기를 보라색 굵게
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]/g, '<span class="text-violet-300 font-bold">$1</span>')
    .replace(/\n/g, '<br />');
}

function styleLabel() {
  const style = VISUAL_STYLES[state.visualStyle] || VISUAL_STYLES['3d'];
  return `${style.emoji} ${style.label}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ──────────────── 씬 카드 인라인 편집 (내레이션 · 자막) ──────────────── */

/** 타이핑이 멈춘 뒤 한 번만 무거운 후속 처리(TTS·타임라인·큐시트)를 돌립니다. */
const editQueue = new Map();
const EDIT_SYNC_MS = 450;

/** 글자가 늘어난 만큼 입력창 높이를 따라 키웁니다. */
function autoGrowField(field) {
  if (!field || field.tagName !== 'TEXTAREA') return;
  field.style.height = 'auto';
  field.style.height = `${Math.max(24, Math.min(420, field.scrollHeight))}px`;
}

function cardOf(index) {
  return $('#scenesList')?.querySelector(`[data-cue="${index}"]`) || null;
}

/** 카드 안의 글자 수·자막 미리보기·수정 배지를 지금 값으로 다시 칩니다. */
function paintCutCard(cut, index) {
  const card = cardOf(index);
  if (!card) return;
  const stats = cutEditStats(cut);
  const narrationCountEl = card.querySelector('[data-count="narration"]');
  const subtitleCountEl = card.querySelector('[data-count="subtitle"]');
  if (narrationCountEl) narrationCountEl.textContent = `${stats.narration}자`;
  if (subtitleCountEl) subtitleCountEl.textContent = `${stats.subtitle}자`;
  const preview = card.querySelector(`[data-preview="${index}"]`);
  if (preview) preview.innerHTML = highlight(cut.subtitle);
  const badge = card.querySelector(`[data-edited="${index}"]`);
  const edited = Boolean(cut.edited && (cut.edited.narration || cut.edited.subtitle));
  if (badge) badge.classList.toggle('hidden', !edited);
}

/** 컷 카드의 입력 — 상태는 즉시, 음성·타임라인은 타이핑이 멈춘 뒤 한 번 반영합니다. */
function onSceneEdit(event) {
  const field = event.target.closest('[data-edit]');
  if (!field || !state.pkg) return;
  const index = Number(field.dataset.cut);
  const cut = state.pkg.cuts[index];
  if (!cut) return;
  const kind = field.dataset.edit;
  const result = applyCutEdit(cut, kind, field.value);
  autoGrowField(field);

  // 내레이션을 고쳐 자막이 따라온 경우, 자막 입력창도 같은 문장으로 맞춥니다.
  const card = cardOf(index);
  const subtitleField = card?.querySelector('[data-edit="subtitle"]');
  if (result.subtitleUpdated && kind === 'narration' && subtitleField && subtitleField.value !== cut.subtitle) {
    subtitleField.value = cut.subtitle;
    autoGrowField(subtitleField);
  }
  if (result.changed) paintCutCard(cut, index);

  // 9:16 미리보기 자막은 타이핑 중에도 바로 바뀝니다(재생 중 음성은 건드리지 않습니다).
  if (result.changed) {
    cut.beats = buildBeats(cut);
    if (state.playerOpen && player.idx === index) {
      const beat = beatAt(cut);
      paintSubtitle(beat ? beat.text : '', false);
    }
  }

  clearTimeout(editQueue.get(index));
  editQueue.set(index, setTimeout(() => commitCutEdit(index), EDIT_SYNC_MS));
}

/** 편집 확정 — 새 문장의 음성을 받고(플레이어를 쓰는 중일 때), 타임라인·큐시트를 맞춥니다. */
async function commitCutEdit(index) {
  clearTimeout(editQueue.get(index));
  editQueue.delete(index);
  const cut = state.pkg?.cuts?.[index];
  if (!cut) return;
  cut.beats = buildBeats(cut);
  pruneNarrationCache();
  if (!state.playerOpen) return;

  const entry = narrationEntry(cut);
  if (narration.voice !== 'browser' && (!entry || entry.status !== 'ok')) {
    paintNarrationNote(`고친 문장의 음성을 준비 중 · Scene ${index + 1}`, 'busy');
    await fetchNarration(cut, { force: entry?.status === 'fail' });
    if (state.pkg && retimeToNarration()) player.beatIdx = -1;
    defaultNarrationNote();
  }
  player.beatIdx = -1;
  updateFrame(true);
  renderCues();
}

/** 문장이 바뀐 컷의 옛 음성은 버립니다 — 캐시가 부풀지 않게. */
function pruneNarrationCache() {
  const cuts = state.pkg?.cuts || [];
  staleNarrationKeys([...narration.cache.keys()], cuts, narration.voice).forEach((key) => narration.cache.delete(key));
}

/** 컷 길이가 바뀌었을 때 카드의 시간 배지를 다시 칩니다. */
function paintCardTimes() {
  if (!state.pkg) return;
  state.pkg.cuts.forEach((cut, i) => {
    const el = cardOf(i)?.querySelector(`[data-time="${i}"]`);
    if (el) el.textContent = `${clock(cut.start)} - ${clock(cut.end)}`;
  });
}

/* ───────────────────── 모드 배지 · 키 확인 ───────────────────── */

function paintModeBadge() {
  const badge = $('#modeBadge');
  if (!badge) return;
  const isGemini = state.mode === 'gemini';
  badge.textContent = isGemini ? `GEMINI${state.gemini?.model ? ` · ${state.gemini.model}` : ''}` : 'LOCAL TEMPLATE';
  badge.className = `ml-auto text-[10px] font-black tracking-wider px-2.5 py-1 rounded-full border ${
    isGemini ? 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10' : 'text-slate-400 border-white/10 bg-white/5'
  }`;
  badge.title = isGemini
    ? 'Gemini 가 레퍼런스를 읽고 대본을 직접 쓴 결과입니다.'
    : 'GEMINI_API_KEY 가 없거나 응답이 늦어 로컬 엔진이 대본을 만들었습니다(정직한 표시).';
}

async function loadHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    state.hasGeminiKey = Boolean(data.hasGeminiKey);
  } catch {
    state.hasGeminiKey = null;
  }
  updateAiBanner();
}

/** 키가 없어도 이제 무료 경로로 생성됩니다 — 배너는 '지금 무엇으로 만드는지'와 실제 실패만 안내합니다. */
function updateAiBanner() {
  const banner = $('#aiBanner');
  if (!banner) return;
  const title = $('#aiBannerTitle');
  const body = $('#aiBannerBody');

  const unfinished = Boolean(state.pkg && state.pkg.cuts.some((c) => !c.imageUrl));
  if (!ai.running && ai.error && unfinished) {
    banner.className = 'mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-[11px] leading-relaxed text-amber-200';
    if (title) title.textContent = '일부 컷 장면을 만들지 못했습니다.';
    if (body) body.textContent = String(ai.error).slice(0, 200);
    banner.classList.remove('hidden');
    return;
  }
  if (state.hasGeminiKey === false) {
    banner.className = 'mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] leading-relaxed text-slate-400';
    if (title) title.textContent = state.visualStyle === 'video' ? '🎬 움직이는 영상 모드 — 빌링 없이 동작합니다.' : state.visualStyle === 'real' ? '📷 실제 사진 모드 — 빌링 없이 동작합니다.' : '무료 모드 — 빌링 없이 동작합니다.';
    if (body) {
      body.textContent =
        state.visualStyle === 'video'
          ? '컷마다 실제로 움직이는 스톡 영상 클립을 먼저 찾습니다(Pixabay는 키가 있을 때 1순위, 없으면 Pexels → 위키미디어 커먼즈 영상 · 라이선스 표기 포함). 클립이 없는 컷은 실제 사진(켄번즈) → AI 이미지로 채웁니다. 영상은 같은 출처 프록시(/api/video-proxy)로 흘려보내므로 미리보기 재생과 영상 파일 합성에 CORS 오류가 없습니다.'
          : state.visualStyle === 'real'
            ? '컷마다 실제 장소·사물 사진을 위키미디어 커먼즈(라이선스 표기 포함)에서 먼저 찾습니다. 사진이 없는 컷만 무료 AI(Pollinations · FLUX.1-schnell)로 채웁니다. 서버가 이미지를 받아 data URL 로 넘기므로 영상 다운로드에 CORS 오류가 없습니다.'
            : 'GEMINI_API_KEY 가 없어도 컷별 9:16 장면을 무료 제공자(Pollinations · FLUX.1-schnell)로 만듭니다. 서버가 이미지 바이트를 받아 data URL 로 넘기므로 영상 다운로드에 CORS 오류가 없습니다.';
    }
    banner.classList.remove('hidden');
    return;
  }
  banner.classList.add('hidden');
}

function setToolStatus(text, ratio) {
  const box = $('#toolStatus');
  if (!box) return;
  if (!text) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('#toolStatusText').textContent = text;
  const fill = $('#toolStatusFill');
  if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, Number(ratio) || 0)) * 100)}%`;
}

/* ───────────────────── 🎨 컷별 AI 이미지 생성 ───────────────────── */

function applyCutImage(index) {
  const pkg = state.pkg;
  const cut = pkg?.cuts?.[index];
  if (!cut) return;
  // 영상 클립이 있으면 포스터가 없어도 장면은 채워진 것입니다(그라데이션 배경 위에 영상이 올라감).
  if (!cut.imageUrl && !cut.videoUrl) return;

  const scene = $('#sceneStack')?.children?.[index];
  if (scene) {
    scene.style.backgroundImage = cut.imageUrl
      ? `linear-gradient(rgba(0,0,0,.22), rgba(0,0,0,.45)), url("${cut.imageUrl}")`
      : `linear-gradient(155deg, ${cut.mood?.from || '#101014'} 0%, ${cut.mood?.to || '#2A3340'} 100%)`;
  }
  const slot = document.querySelector(`[data-shot="${index}"]`);
  if (slot) {
    if (cut.imageUrl) {
      slot.classList.remove('hidden');
      const img = slot.querySelector('img');
      if (img && img.getAttribute('src') !== cut.imageUrl) img.src = cut.imageUrl;
    } else {
      slot.classList.add('hidden');
    }
  }
  paintCutImageMeta(index);
}

/** 컷 카드의 🎬 영상 / 📷 실사 / 🎨 AI 배지 · 출처 · 다시 만들기 버튼 문구. */
function paintCutImageMeta(index) {
  const cut = state.pkg?.cuts?.[index];
  const card = cardOf(index);
  if (!cut || !card) return;
  const badge = card.querySelector(`[data-kind="${index}"]`);
  const credit = card.querySelector(`[data-credit="${index}"]`);
  const regen = card.querySelector(`[data-regen="${index}"]`);
  const kind = cutVisualKind(cut);
  const videoMode = state.visualStyle === 'video';
  if (regen) {
    const canPhoto = state.visualStyle === 'real';
    if (!kind) regen.textContent = videoMode ? '🎬 영상 클립 찾기' : canPhoto ? '📷 실제 사진 찾기' : '🔄 이 컷 장면 다시';
    else if (kind === 'video') regen.textContent = '🔄 다른 클립';
    else if (kind === 'photo') regen.textContent = videoMode ? '🎬 영상으로 바꾸기' : '🎨 AI로 바꾸기';
    else regen.textContent = videoMode ? '🎬 영상으로 바꾸기' : canPhoto ? '📷 실사로 바꾸기' : '🔄 다시 만들기';
  }
  if (!kind) {
    badge?.classList.add('hidden');
    credit?.classList.add('hidden');
    return;
  }
  if (badge) {
    const table = {
      video: { text: '🎬 영상', cls: 'text-sky-300 border-sky-400/30 bg-sky-400/10' },
      photo: { text: '📷 실사', cls: 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10' },
      ai: { text: '🎨 AI', cls: 'text-violet-300 border-violet-400/30 bg-violet-400/10' },
    };
    const looked = table[kind] || table.ai;
    badge.textContent = looked.text;
    badge.className = `text-[10px] font-bold px-2 py-1 rounded-full border ${looked.cls}`;
    badge.title =
      kind === 'video'
        ? `움직이는 스톡 클립 · ${providerName(cut.videoProvider)}${cut.videoLicense ? ` · ${cut.videoLicense}` : ''}`
        : kind === 'photo'
          ? `실제 사진 · ${providerName(cut.imageProvider)}${cut.imagePhoto?.license ? ` · ${cut.imagePhoto.license}` : ''}`
          : `AI 생성 · ${providerName(cut.imageProvider)}`;
    badge.classList.remove('hidden');
  }
  if (credit) {
    const text = kind === 'video' ? cut.videoCredit || '' : kind === 'photo' ? cut.imageCredit || '' : '';
    credit.textContent = text;
    credit.title = text;
    credit.classList.toggle('hidden', !text);
  }
}

/** 이미지 응답 하나를 컷 상태에 반영합니다(사진이면 출처도 함께). */
function setCutImageData(index, data, { styleUsed = '' } = {}) {
  const cut = state.pkg?.cuts?.[index];
  if (!cut || !data?.image) return;
  cut.imageUrl = data.image;
  cut.imageProvider = data.provider || 'free';
  cut.imageModel = data.model || '';
  cut.imageKind = data.kind === 'photo' ? 'photo' : 'ai';
  cut.imageCredit = data.photo?.credit || data.credit || '';
  cut.imagePhoto = data.photo || null;
  cut.imageStyleUsed = styleUsed || data.visualStyle || state.visualStyle;
  cut.imageNote = data.geminiNote && /사진 없음/.test(String(data.geminiNote)) ? '영상 클립·실제 사진을 못 찾아 AI로 채웠습니다.' : '';
  applyCutImage(index);
}

/** 움직이는 영상 클립 응답을 컷 상태에 반영합니다(출처·포스터도 함께). */
function setCutVideoData(index, data) {
  const cut = state.pkg?.cuts?.[index];
  if (!cut || !data?.videoUrl) return;
  cut.videoUrl = data.videoUrl;
  cut.videoSourceUrl = data.sourceUrl || '';
  cut.videoId = data.videoId || '';
  cut.videoProvider = data.provider || '';
  cut.videoPage = data.page || '';
  cut.videoTitle = data.title || '';
  cut.videoLicense = data.license || '';
  cut.videoArtist = data.artist || '';
  cut.videoCredit = data.credit || '';
  cut.videoDuration = Number(data.duration) || 0;
  cut.videoWidth = Number(data.width) || 0;
  cut.videoHeight = Number(data.height) || 0;
  cut.imageKind = 'video';
  cut.imageProvider = data.provider || '';
  cut.imageCredit = data.credit || '';
  cut.imageNote = '';
  // 포스터(첫 프레임)는 카드 썸네일·영상 로딩 중 배경으로 씁니다.
  if (data.posterUrl && !cut.imageUrl) cut.imageUrl = data.posterUrl;
  applyCutImage(index);
  if (state.playerOpen && cut.videoUrl) mountCutVideo(index);
}

/** 컷에 화면에 뿌릴 장면(영상·사진·AI 이미지)이 있는지 */
function cutHasVisual(cut) {
  return Boolean(cut && (cut.videoUrl || cut.imageUrl));
}

/** 컷이 지금 어떤 장면으로 채워졌는지 — 'video' | 'photo' | 'ai' | '' */
function cutVisualKind(cut) {
  if (!cut) return '';
  if (cut.videoUrl) return 'video';
  if (cut.imageKind === 'photo') return 'photo';
  if (cut.imageUrl) return 'ai';
  return '';
}

function applyAllCutImages() {
  if (!state.pkg) return;
  state.pkg.cuts.forEach((cut, i) => {
    if (cutHasVisual(cut)) applyCutImage(i);
  });
  refreshImageBadgeFromPkg();
}

/** 현재 상태를 배지 문구로 반영합니다(플레이어를 열 때·장면이 이미 있을 때). */
function refreshImageBadgeFromPkg() {
  if (!state.pkg || ai.running) return;
  const total = state.pkg.cuts.length;
  const made = state.pkg.cuts.filter((c) => cutHasVisual(c)).length;
  const videos = state.pkg.cuts.filter((c) => c.videoUrl).length;
  const photos = state.pkg.cuts.filter((c) => !c.videoUrl && c.imageKind === 'photo').length;
  const aiCount = made - videos - photos;
  const parts = [];
  if (videos) parts.push(`🎬 영상 ${videos}컷`);
  if (photos) parts.push(`📷 실사 ${photos}컷`);
  if (aiCount > 0) parts.push(`🎨 AI ${aiCount}컷`);
  const mix = parts.join(' · ') || '무료 AI';
  if (made === total) paintImageBadge(`장면 완료 · ${made}/${total} (${mix})`, 'ok');
  else if (made > 0) paintImageBadge(`장면 · ${made}/${total} 완료 (${mix})`, 'ok');
  else
    paintImageBadge(
      state.visualStyle === 'video'
        ? `🎬 스톡 영상 · 0/${total} 준비됨`
        : state.visualStyle === 'real'
          ? `📷 실제 사진 · 0/${total} 준비됨`
          : `무료 AI 이미지 · 0/${total} 준비됨`,
      'ok',
    );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function providerName(provider) {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'hf-flux-free') return 'FLUX.1-schnell 무료';
  if (provider === 'pollinations-free') return 'Pollinations 무료';
  if (provider === 'pixabay') return 'Pixabay 스톡 영상';
  if (provider === 'pexels') return 'Pexels 스톡 영상';
  if (provider === 'wikimedia-commons') return '위키미디어 커먼즈';
  if (provider === 'wikipedia-ko') return '위키백과';
  if (provider === 'wikipedia-en') return 'Wikipedia (EN)';
  return '무료 AI';
}

/** 무료 경로가 실제로 쓰인 제공자 요약 — 예: "Pollinations 무료 ×6 · FLUX 무료 ×1" */
function providerSummary() {
  return Object.entries(ai.providers)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${providerName(p)} ×${n}`)
    .join(' · ');
}

/** AI 카드 배지 + 9:16 플레이어 안쪽 칩을 같은 문구로 맞춥니다. */
function paintImageBadge(text, tone = 'ok') {
  const label = $('#imageProviderText');
  if (label) {
    label.textContent = text;
    label.className = `text-[11px] leading-relaxed ${
      tone === 'warn' ? 'text-amber-300' : tone === 'busy' ? 'text-violet-300' : 'text-emerald-300'
    }`;
  }
  const dot = $('#imageProviderDot');
  if (dot) {
    dot.className = `w-1.5 h-1.5 rounded-full ${tone === 'warn' ? 'bg-amber-400' : tone === 'busy' ? 'bg-violet-400' : 'bg-emerald-400'}${
      tone === 'busy' ? ' animate-pulse' : ''
    }`;
  }
  const chip = $('#sceneProviderBadge');
  if (chip) {
    // 플레이어 안쪽 칩은 한 줄로 — 제공자 요약(괄호)은 카드에만 남깁니다.
    chip.textContent = text.replace(/\s*\([^)]*\)/g, '');
    chip.classList.remove('hidden');
    chip.classList.toggle('text-amber-300', tone === 'warn');
    chip.classList.toggle('text-violet-300', tone === 'busy');
  }
}

/** 컷 1장 요청 — 서버가 실제 사진·무료 AI 경로까지 시도한 결과를 정직하게 해석합니다. */
async function requestCutImage(cut, { realPhoto = 'first', styleOverride = '' } = {}) {
  const index = Number(cut.index) || 0;
  // 요청 스타일 — 영상 모드에서 폴백할 때는 'real'(실제 사진 → AI)
  const style = styleOverride || state.visualStyle;
  // 같은 주제로 컷마다 다른 사진이 나오도록, 이미 쓴 사진 제목을 보내 뺀다.
  const exclude = (state.pkg?.cuts || [])
    .filter((c) => c !== cut && c.imageKind === 'photo' && c.imagePhoto?.title)
    .map((c) => c.imagePhoto.title)
    .slice(0, 40);
  try {
    const res = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: cut.visualPrompt,
        aspectRatio: '9:16',
        cutId: cut.id,
        cutIndex: index,
        style,
        realPhoto: style === 'real' ? realPhoto : 'skip',
        photoKo: cut.photoKo || '',
        photoEn: cut.photoEn || '',
        keyword: cut.photoKo || '',
        fallbackPhoto: state.pkg?.meta?.photoSubject || '',
        fallbackPhotoEn: state.pkg?.meta?.photoSubjectEn || '',
        exclude,
      }),
    });
    const data = await res.json().catch(() => null);
    if (data?.ok && data.image) return { ok: true, data };
    const retryAfterMs = Number(data?.retryAfterMs) || 0;
    const error = String(data?.error || `http-${res.status}`);
    return {
      ok: false,
      error,
      message: String(data?.message || `HTTP ${res.status}`),
      // 대기열 혼잡(free-busy)·429·네트워크는 다시 시도할 가치가 있습니다.
      retryable: error === 'free-busy' || res.status === 429 || res.status >= 500,
      retryAfterMs: retryAfterMs || (error === 'free-busy' ? 45_000 : 4_000),
    };
  } catch (err) {
    return { ok: false, error: 'network', message: String(err?.message || err), retryable: true, retryAfterMs: 5_000 };
  }
}

/** 컷 1개 스톡 영상 클립 요청 — 같은 출처 프록시 주소를 돌려받습니다. */
async function requestCutVideo(cut, { avoidCurrent = false } = {}) {
  const index = Number(cut.index) || 0;
  // 같은 클립이 두 컷에 겹치지 않도록 이미 쓴 클립 id 를 빼고 묻습니다.
  const exclude = (state.pkg?.cuts || [])
    .filter((c) => c !== cut && c.videoId)
    .map((c) => c.videoId)
    .slice(0, 40);
  if (avoidCurrent && cut.videoId) exclude.push(cut.videoId);
  try {
    const res = await fetch('/api/find-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photoKo: cut.photoKo || '',
        photoEn: cut.photoEn || '',
        keyword: cut.photoKo || '',
        fallbackPhoto: state.pkg?.meta?.photoSubject || '',
        fallbackPhotoEn: state.pkg?.meta?.photoSubjectEn || '',
        cutId: cut.id,
        cutIndex: index,
        exclude,
      }),
    });
    const data = await res.json().catch(() => null);
    if (data?.ok && data.videoUrl) return { ok: true, data };
    return {
      ok: false,
      error: String(data?.error || `http-${res.status}`),
      message: String(data?.message || `HTTP ${res.status}`),
    };
  } catch (err) {
    return { ok: false, error: 'network', message: String(err?.message || err) };
  }
}

/**
 * 🎬 영상 모드에서 한 컷을 채웁니다 — 클립 → 실제 사진 → (사진도 없으면 서버가 AI).
 *   한 컷이 실패해도 빈 화면을 남기지 않고, 무엇으로 채웠는지 그대로 알려 줍니다.
 */
async function fillCutWithVideo(cut, index) {
  const video = await requestCutVideo(cut);
  if (video.ok) {
    setCutVideoData(index, video.data);
    return { ok: true, kind: 'video', data: video.data };
  }
  const photo = await requestCutImage(cut, { styleOverride: 'real' });
  if (photo.ok) {
    setCutImageData(index, photo.data, { styleUsed: 'real' });
    return { ok: true, kind: photo.data.kind === 'photo' ? 'photo' : 'ai', data: photo.data, videoError: video };
  }
  return {
    ok: false,
    kind: '',
    error: photo.error,
    message: photo.message,
    retryable: photo.retryable,
    retryAfterMs: photo.retryAfterMs,
    videoError: video,
  };
}

/** 컷 하나만 다시 만들기 — 🎬 영상 ↔ 📷 실사 ↔ 🎨 AI 토글도 이 버튼으로 합니다. */
async function regenerateCutVisual(index, failureNote = '') {
  const cut = state.pkg?.cuts?.[index];
  if (!cut || ai.running) return;
  const videoMode = state.visualStyle === 'video';
  const wantPhoto = !videoMode && state.visualStyle === 'real' && cut.imageKind !== 'photo';
  const btn = cardOf(index)?.querySelector(`[data-regen="${index}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = videoMode ? '🎬 클립 찾는 중…' : wantPhoto ? '📷 사진 찾는 중…' : '🎨 만드는 중…';
  }
  ai.running = true;
  try {
    if (videoMode) {
      const r = await fillCutWithVideo(cut, index);
      if (r.ok) {
        toast(
          r.kind === 'video'
            ? `Scene ${index + 1} — 🎬 움직이는 클립으로 바꿨습니다.`
            : r.kind === 'photo'
              ? `Scene ${index + 1} — 이 컷은 클립을 찾지 못해 📷 실제 사진으로 채웠습니다.`
              : `Scene ${index + 1} — 클립·사진을 못 찾아 🎨 AI 이미지로 채웠습니다.`,
        );
        refreshImageBadgeFromPkg();
        return;
      }
      toast(failureNote ? `${failureNote} ${r.message || ''}` : r.message || '이 컷 장면을 채우지 못했습니다.');
      return;
    }
    const r = await requestCutImage(cut, { realPhoto: wantPhoto ? 'only' : 'skip' });
    if (r.ok) {
      setCutImageData(index, r.data, { styleUsed: state.visualStyle });
      const kind = r.data.kind === 'photo' ? '📷 실제 사진으로' : '🎨 AI 이미지로';
      toast(`Scene ${index + 1} — ${kind} 바꿨습니다.`);
      refreshImageBadgeFromPkg();
      return;
    }
    const note = r.error === 'no-real-photo' ? '실제 사진을 찾지 못했습니다. 🎨 AI로 다시 시도해 보세요.' : r.message || '다시 만들지 못했습니다.';
    toast(failureNote ? `${failureNote} ${note}` : note);
  } finally {
    ai.running = false;
    if (btn) btn.disabled = false;
    paintCutImageMeta(index);
  }
}

async function generateCutImages() {
  if (!state.pkg) return;
  if (ai.running) return;

  const cuts = state.pkg.cuts;
  let pending = cuts.map((cut, i) => ({ cut, i, skipVideo: false })).filter((x) => !cutHasVisual(x.cut));
  if (!pending.length) {
    toast('이미 모든 컷의 장면이 있습니다.');
    return;
  }

  const videoMode = state.visualStyle === 'video';
  const photoMode = state.visualStyle === 'real';
  const label = videoMode ? '🎬 스톡 영상' : photoMode ? '📷 실제 사진' : '무료 AI 이미지';
  ai.running = true;
  ai.providers = {};
  ai.rounds = 0;
  ai.total = cuts.length;
  ai.done = cuts.length - pending.length;
  ai.failed = 0;
  ai.error = '';
  const btn = $('#genImagesBtn');
  if (btn) btn.disabled = true;
  const remaining = () => cuts.filter((c) => !cutHasVisual(c)).length;
  const startedAt = Date.now();
  // 실제 촬영물(영상·사진)은 컷마다 다른 장면을 고르게 하려면 한 건씩 묻는 편이 좋습니다.
  // (동시에 보내면 같은 클립이 두 컷에 들어가고, 몰리면 429 를 받습니다.)
  const waveLimit = videoMode || photoMode ? 1 : 999;

  const paintProgress = (done, extra = '') => {
    const who = providerSummary();
    const text = `${label} 생성 중 · ${done}/${cuts.length} 완료${who ? ` (${who})` : ''}${extra}`;
    setToolStatus(text, done / cuts.length);
    paintImageBadge(`${label} 생성 중 · ${done}/${cuts.length} 완료`, 'busy');
  };

  setToolStatus(`${label} 생성 중 · ${ai.done}/${cuts.length} 완료`, ai.done / cuts.length);
  paintImageBadge(`${label} 생성 중 · ${ai.done}/${cuts.length} 완료`, 'busy');

  // 한 번에 다 보내고(파도), 대기열에 막힌 컷만 서버가 알려준 초만큼 쉬었다가 다시 보냅니다.
  while (pending.length && ai.rounds < AI_MAX_ROUNDS) {
    ai.rounds += 1;
    const wave = pending;
    pending = [];
    let waitMs = 0;

    for (let at = 0; at < wave.length; at += waveLimit) {
      const part = wave.slice(at, at + waveLimit);
      if ((videoMode || photoMode) && at > 0) await sleep(300);
      await Promise.all(
        part.map(async ({ cut, i, skipVideo }) => {
          const r =
            videoMode && !skipVideo ? await fillCutWithVideo(cut, i) : await requestCutImage(cut, { styleOverride: videoMode ? 'real' : '' });
          if (r.ok) {
            if (!videoMode || skipVideo) setCutImageData(i, r.data, { styleUsed: videoMode ? 'real' : state.visualStyle });
            const key = cut.videoUrl ? cut.videoProvider : cut.imageProvider;
            ai.providers[key || 'free'] = (ai.providers[key || 'free'] || 0) + 1;
            ai.done = cuts.length - remaining();
            paintProgress(ai.done);
            return;
          }
          ai.error = r.message || r.error;
          if (r.retryable) {
            // 영상 검색은 이미 실패했으니, 재시도는 사진·AI 경로로만 합니다.
            pending.push({ cut, i, skipVideo: true });
            waitMs = Math.max(waitMs, Number(r.retryAfterMs) || 0);
          } else {
            ai.failed += 1;
          }
        }),
      );
    }

    if (pending.length) {
      const waitSec = Math.max(8, Math.round(waitMs / 1000));
      setToolStatus(`${label} 대기 중 · ${waitSec}초 뒤 ${pending.length}컷 재시도 (${ai.rounds}/${AI_MAX_ROUNDS})`, ai.done / cuts.length);
      paintImageBadge(`${label} 대기 중 · ${ai.done}/${cuts.length} 완료 · ${waitSec}초 뒤 재시도`, 'busy');
      await sleep(Math.min(60_000, waitMs));
    }
  }

  ai.running = false;
  if (btn) btn.disabled = false;

  const total = cuts.length;
  const made = total - remaining();
  const took = Math.round((Date.now() - startedAt) / 1000);
  const videoCount = cuts.filter((c) => c.videoUrl).length;
  const photoCount = cuts.filter((c) => !c.videoUrl && c.imageKind === 'photo').length;
  const aiCount = Math.max(0, made - videoCount - photoCount);
  const kinds = [];
  if (videoCount) kinds.push(`🎬 영상 ${videoCount}컷`);
  if (photoCount) kinds.push(`📷 실사 ${photoCount}컷`);
  if (aiCount) kinds.push(`🎨 AI ${aiCount}컷`);
  const mix = kinds.join(' · ') || '장면 없음';

  if (!remaining()) {
    setToolStatus(`장면 ${made}개 완료 (${took}초 · ${mix}) — 플레이어에 반영했습니다.`, 1);
    paintImageBadge(`장면 완료 · ${made}/${total} (${mix})`, 'ok');
    toast(
      videoCount
        ? `컷별 장면을 채웠습니다 — 움직이는 영상 ${videoCount}컷${photoCount ? `, 실제 사진 ${photoCount}컷` : ''}${aiCount ? `, AI ${aiCount}컷` : ''}.`
        : photoCount
          ? `컷별 장면을 채웠습니다 — 실제 사진 ${photoCount}컷${aiCount ? `, AI ${aiCount}컷` : ''}.`
          : '컷별 AI 장면을 무료 생성해 플레이어에 입혔습니다.',
    );
    setTimeout(() => setToolStatus('', 0), 6000);
    return;
  }

  const left = remaining();
  ai.failed = Math.max(ai.failed, left);
  const reason = ai.error || '무료 대기열이 혼잡합니다';
  setToolStatus(`${label} 장면 ${made}/${total} 완료 · ${left}컷 남음 — ${reason.slice(0, 90)}`, made / total);
  paintImageBadge(`${label} · ${made}/${total} 완료 · ${left}컷은 잠시 뒤 다시 시도`, 'warn');
  toast(`${made}/${total}컷 완료 — 남은 ${left}컷은 잠시 뒤 버튼으로 다시 시도해 주세요.`);
  updateAiBanner();
}


/* ───────────────────── 🎙 내레이션 (중후한 남성 TTS) ───────────────────── */

function narrationEntry(cut) {
  return narration.cache.get(narrationKey(cut, narration.voice)) || null;
}

function narrationBuffer(cut) {
  const entry = narrationEntry(cut);
  return entry && entry.status === 'ok' ? entry.buffer : null;
}

/** 오디오 그래프(재생·녹화 공용) — 사용자 제스처 안에서 처음 만들고 계속 재사용합니다. */
function ensureAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!narration.ctx) {
    narration.ctx = new AC();
    narration.gain = narration.ctx.createGain();
    narration.gain.gain.value = player.mute ? 0 : 1;
    narration.gain.connect(narration.ctx.destination);
  }
  if (narration.ctx.state === 'suspended') narration.ctx.resume().catch(() => {});
  return narration.ctx;
}

function setGain(on) {
  if (!narration.gain || !narration.ctx) return;
  try {
    narration.gain.gain.setTargetAtTime(on ? 1 : 0, narration.ctx.currentTime, 0.01);
  } catch {
    narration.gain.gain.value = on ? 1 : 0;
  }
}

/** 서버 TTS 한 컷 — { status:'ok', buffer } 또는 { status:'fail', error }. force 면 실패 캐시도 다시 시도합니다. */
async function fetchNarration(cut, { force = false } = {}) {
  const key = narrationKey(cut, narration.voice);
  const existing = narration.cache.get(key);
  if (existing && existing.status !== 'loading' && !(force && existing.status === 'fail')) return existing;
  const ctx = ensureAudioContext();
  const text = speechText(cut);
  if (!ctx || !text) {
    const fail = { status: 'fail', error: 'no-audio-context' };
    narration.cache.set(key, fail);
    return fail;
  }
  narration.cache.set(key, { status: 'loading' });
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: narration.voice }),
    });
    if (!res.ok) {
      const info = await res.json().catch(() => null);
      throw new Error(info?.message || `음성 요청 실패 (HTTP ${res.status})`);
    }
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength) throw new Error('빈 음성');
    const buffer = await ctx.decodeAudioData(bytes);
    const entry = { status: 'ok', buffer, ms: Number(res.headers.get('X-TTS-Ms')) || 0 };
    narration.cache.set(key, entry);
    return entry;
  } catch (err) {
    narration.failed += 1;
    const entry = { status: 'fail', error: String(err?.message || err) };
    narration.cache.set(key, entry);
    return entry;
  }
}

function narrationCount() {
  if (!state.pkg) return { ready: 0, total: 0 };
  const cuts = state.pkg.cuts;
  return { ready: cuts.filter((c) => narrationBuffer(c)).length, total: cuts.length };
}

function paintNarrationNote(text, tone = 'ok') {
  const el = $('#voiceNote');
  if (!el) return;
  el.textContent = text;
  el.className = `mt-2 text-[11px] text-center ${
    tone === 'warn' ? 'text-amber-300' : tone === 'busy' ? 'text-violet-300' : 'text-slate-500'
  }`;
}

function defaultNarrationNote() {
  if (narration.voice === 'browser') {
    paintNarrationNote('브라우저 음성(Web Speech)으로 읽습니다. 영상 파일에는 음성이 들어가지 않습니다.');
    return;
  }
  const who = NARRATION_VOICES[narration.voice]?.label || '중후한 남성';
  if (!state.pkg) {
    paintNarrationNote(`${who} 내레이션으로 읽습니다 · 대본을 만들면 음성을 준비합니다.`);
    return;
  }
  const { ready, total } = narrationCount();
  if (ready === total && total) paintNarrationNote(`${who} 내레이션 ${ready}/${total} 준비 · 그대로 영상에 담깁니다.`);
  else paintNarrationNote(`${who} 내레이션 준비 중 · ${ready}/${total}`, 'busy');
}

/** 모든 컷의 음성을 미리 받아 둘니다(동시 3개 — 서버 부담과 대기 시간의 절충). */
async function prepareNarration() {
  const { total } = narrationCount();
  if (!state.pkg || !total || narration.voice === 'browser') return { ready: 0, total };
  const ctx = ensureAudioContext();
  if (!ctx) {
    paintNarrationNote('이 브라우저는 Web Audio 를 지원하지 않아 브라우저 음성으로 읽습니다.', 'warn');
    return { ready: 0, total };
  }
  const queue = state.pkg.cuts.filter((cut) => {
    const entry = narrationEntry(cut);
    return !entry || entry.status === 'loading';
  });
  const cuts = state.pkg.cuts;
  paintNarrationNote(`${NARRATION_VOICES[narration.voice]?.label || '내레이션'} 준비 중 · 0/${total}`, 'busy');
  const worker = async () => {
    while (queue.length) {
      const cut = queue.shift();
      if (!cut) return;
      await fetchNarration(cut);
      const ready = cuts.filter((c) => narrationBuffer(c)).length;
      paintNarrationNote(`${NARRATION_VOICES[narration.voice]?.label || '내레이션'} 준비 중 · ${ready}/${total}`, 'busy');
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  // 실패한 컷은 한 번만 더 시도합니다(업스트림이 순간적으로 거절했을 때).
  const failed = state.pkg.cuts.filter((cut) => narrationEntry(cut)?.status === 'fail');
  if (failed.length) {
    paintNarrationNote(`음성 재시도 중 · ${failed.length}컷`, 'busy');
    await sleep(700);
    await Promise.all(failed.slice(0, 4).map((cut) => fetchNarration(cut, { force: true })));
  }

  const result = narrationCount();
  if (result.ready === 0) {
    paintNarrationNote('음성 서버에 연결하지 못했습니다 — 브라우저 음성으로 대신 읽습니다(영상에는 음성 없음).', 'warn');
  } else if (result.ready < result.total) {
    paintNarrationNote(`${NARRATION_VOICES[narration.voice]?.label} ${result.ready}/${result.total} 준비 · 나머지 컷은 브라우저 음성으로 읽습니다.`, 'warn');
  } else {
    paintNarrationNote(`${NARRATION_VOICES[narration.voice]?.label} 내레이션 ${result.ready}/${result.total} 준비 · 그대로 영상에 담깁니다.`);
  }
  return result;
}

/** 컷 길이에 맞춘 재생 배속 — 음성이 컷 밖으로 넘치지 않게 합니다. */
function fitRate(cut, buffer) {
  const span = Math.max(0.6, cut.end - cut.start);
  return Math.min(1.8, Math.max(0.9, buffer.duration / span));
}

function stopNarration() {
  narration.sources.forEach((src) => {
    try {
      src.stop();
    } catch {
      /* 이미 끝났습니다 */
    }
  });
  narration.sources = [];
}

/** 현재 컷의 음성을 offset(초)부터 재생합니다. 음성이 없으면 false → 호출쪽이 Web Speech 로 폴백. */
function playNarration(idx, offsetSec = 0) {
  const cut = state.pkg?.cuts?.[idx];
  if (!cut || narration.voice === 'browser' || player.mute) return false;
  const ctx = ensureAudioContext();
  const buffer = narrationBuffer(cut);
  if (!ctx || !buffer) return false;
  stopNarration();
  const speed = Math.min(1.3, Math.max(0.75, player.rate / 1.21));
  const rate = Math.min(2, Math.max(0.6, fitRate(cut, buffer) * speed));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  src.connect(narration.gain);
  const offset = Math.min(Math.max(0, buffer.duration - 0.03), Math.max(0, offsetSec * rate));
  try {
    src.start(0, offset);
  } catch {
    return false;
  }
  narration.sources.push(src);
  src.onended = () => {
    narration.sources = narration.sources.filter((s) => s !== src);
  };
  return true;
}

/**
 * 내레이션 길이에 맞춰 컷 타임라인을 다시 잡습니다.
 *   · 36초 대본에 6~10초짜리 음성을 그대로 욱여넣으면 말이 잘립니다.
 *   · 절반 이상 컷에 음성이 준비되면, 컷 길이를 max(대본 길이, 음성+0.3초)로 늘려
 *     내레이션이 끝까지 들리는 영상으로 만듭니다(최대 14초/컷).
 */
function retimeToNarration() {
  const cuts = state.pkg?.cuts || [];
  if (!cuts.length) return false;
  const withAudio = cuts.filter((c) => narrationBuffer(c)).length;
  if (withAudio < Math.ceil(cuts.length * 0.5)) return false;

  let cursor = 0;
  let changed = false;
  cuts.forEach((cut) => {
    const scriptDur = Math.max(1.2, cut.end - cut.start);
    const buffer = narrationBuffer(cut);
    // 재생 배속으로 1.2배까지는 자연스럽게 담깁니다 — 그 뒤에도 남으면 컷을 늘립니다.
    const target = buffer ? Math.min(14, Math.max(scriptDur, buffer.duration / 1.2 + 0.25)) : scriptDur;
    if (Math.abs(target - scriptDur) > 0.05) changed = true;
    cut.start = Number(cursor.toFixed(2));
    cut.end = Number((cursor + target).toFixed(2));
    cursor = cut.end;
    cut.beats = buildBeats(cut);
  });

  if (!changed) return false;
  player.total = cursor;
  player.t = Math.min(player.t, cursor);
  if (state.pkg?.meta) state.pkg.meta.totalSec = Number(cursor.toFixed(1));
  const meta = $('#scriptMeta');
  if (meta) meta.textContent = `총 ${Math.round(cursor)}초 · 컷당 ${(cursor / cuts.length).toFixed(1)}초 · ${styleLabel()} · 내레이션에 맞춘 길이`;
  paintCardTimes();
  const wanted = Number(state.pkg?.meta?.length) || 0;
  if (wanted && cursor > wanted * 1.15 && !state.lengthNoticeShown) {
    state.lengthNoticeShown = true;
    toast(`내레이션 길이에 맞춰 영상이 ${Math.round(cursor)}초로 늘었습니다 — 대본을 줄이면 ${wanted}초에 가깝게 맞출 수 있어요.`);
  }
  return true;
}

/** 음성 pill — 바꾸면 캐시를 비우고 새 목소리로 다시 준비합니다. */
async function setNarrationVoice(name) {
  if (!NARRATION_VOICES[name] || narration.voice === name) return;
  narration.voice = name;
  narration.cache.clear();
  narration.failed = 0;
  stopNarration();
  paintVoicePills();
  if (name === 'browser') {
    paintNarrationNote('브라우저 음성으로 읽습니다. 영상 파일에는 음성이 들어가지 않습니다.');
    if (player.playing) speak(state.pkg.cuts[player.idx]);
    return;
  }
  if (!state.pkg) return;
  await prepareNarration();
  if (retimeToNarration()) updateFrame(true);
  if (player.playing) playNarration(player.idx, Math.max(0, player.t - state.pkg.cuts[player.idx].start));
}

function paintVoicePills() {
  $$('[data-voice]').forEach((btn) => {
    const on = btn.dataset.voice === narration.voice;
    btn.className = `px-3 py-2 rounded-xl text-[11px] font-bold border transition ${
      on
        ? 'bg-violet-500/20 border-violet-400/50 text-violet-200'
        : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
    }`;
    btn.setAttribute('aria-pressed', String(on));
  });
}

/** 비주얼 스타일 토글 — 대본 요청·이미지 요청 본문에 그대로 들어갑니다. */
function setVisualStyle(name) {
  if (!VISUAL_STYLES[name] || state.visualStyle === name) return;
  state.visualStyle = name;
  paintStyleToggle();
  const note =
    name === 'video'
      ? '🎬 움직이는 영상 — 실제 스톡 영상 클립(Pixabay → Pexels → 위키미디어 커먼즈)을 먼저 찾습니다. 클립이 없으면 실제 사진, 그다음 AI로 채웁니다. 대본을 다시 생성하면 컷마다 검색어(photoKo·photoEn)도 함께 만들어집니다.'
      : name === 'real'
        ? '📷 실제 사진 — 실제 장소·사물 사진을 먼저 찾습니다. 대본을 다시 생성하면 컷마다 검색어(photoKo·photoEn)도 함께 만들어집니다.'
        : `${VISUAL_STYLES[name].emoji} ${VISUAL_STYLES[name].label} 스타일로 새로 만듭니다 — 대본을 다시 생성해 주세요.`;
  toast(note);
  if (state.pkg) state.pkg.cuts.forEach((_, i) => paintCutImageMeta(i));
}

function paintStyleToggle() {
  $$('[data-style]').forEach((btn) => {
    const on = btn.dataset.style === state.visualStyle;
    btn.className = `px-3 py-3 rounded-xl text-xs font-bold border transition text-left ${
      on ? 'bg-violet-500/15 border-violet-400/50 text-violet-100' : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
    }${btn.dataset.style === 'real' || btn.dataset.style === 'video' ? ' col-span-2' : ''}`;
    btn.setAttribute('aria-pressed', String(on));
  });
  const note = $('#styleNote');
  if (note) {
    note.textContent =
      state.visualStyle === 'video'
        ? '실제로 움직이는 스톡 클립을 먼저 찾습니다(Pixabay → Pexels → 위키미디어 커먼즈). 클립이 없는 컷은 실제 사진(켄번즈) → AI 이미지로 채우고, 9:16 미리보기·영상 파일에서 장면이 실제로 움직입니다.'
        : state.visualStyle === 'real'
          ? '실제 장소·사물 사진을 먼저 찾습니다(위키미디어 커먼즈 → 위키백과). 롯데타워 같은 실제 대상이 그대로 나오고, 사진이 없는 컷만 AI로 채웁니다.'
          : state.visualStyle === '3d'
            ? '미니어처 다이오라마 · 등각 투시 · GI 조명 — 3D 쇼츠 느낌의 컷 이미지를 만듭니다.'
            : '필름 스틸 · 자연광 · 얕은 심도 — 실사 다큐 느낌의 컷 이미지를 만듭니다.';
  }
  const genBtn = $('#genImagesBtn');
  if (genBtn) {
    genBtn.textContent =
      state.visualStyle === 'video'
        ? '🎬 컷별 영상 클립 채우기'
        : state.visualStyle === 'real'
          ? '📷 컷별 실제 사진 채우기'
          : '🎨 컷별 AI 이미지 생성';
  }
  updateAiBanner();
}

/* ───────────────────── ⏱ 영상 길이 선택 ───────────────────── */

/** 길이 선택기 — 고른 초와 컷 수가 대본 요청 본문(length·cutCount)에 그대로 들어갑니다. */
function setLength(sec) {
  const option = LENGTH_OPTIONS.find((o) => o.sec === Number(sec));
  if (!option || state.lengthSec === option.sec) return;
  state.lengthSec = option.sec;
  state.cutCount = option.cuts;
  paintLengthPicker();
  const note = state.pkg ? ` — 대본을 다시 생성하면 ${option.cuts}컷으로 다시 씁니다.` : '';
  toast(`약 ${option.sec}초 · ${option.cuts}컷${note}`);
}

function paintLengthPicker() {
  $$('[data-length]').forEach((btn) => {
    const on = Number(btn.dataset.length) === state.lengthSec;
    btn.className = `px-1.5 py-2.5 rounded-xl text-[11px] font-bold border transition ${
      on ? 'bg-violet-500/20 border-violet-400/50 text-violet-100' : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
    }`;
    btn.setAttribute('aria-pressed', String(on));
  });
  const note = $('#lengthNote');
  const option = LENGTH_OPTIONS.find((o) => o.sec === state.lengthSec);
  if (note) note.textContent = `약 ${state.lengthSec}초 · ${state.cutCount}컷 — ${option?.note || '선택한 길이로 대본을 씁니다'}`;
}

/* ───────────────────── 🎬 영상 파일 내보내기 ───────────────────── */

function recorderMime(withAudio = false) {
  if (typeof window.MediaRecorder === 'undefined') return '';
  // H.264 MP4 가 최상(아이폰·퀵타임 호환)이지만, 크롬은 `video/mp4` 만 물어보면
  //  VP9 를 MP4 에 담아 버립니다(아이폰에서 안 열림). 그래서 **코덱까지 지정한 것만** 먼저 믿고,
  //  안 되면 WebM, 마지막에야 iOS 사파리용 `video/mp4` 를 씁니다.
  //  내레이션을 넣을 때는 오디오 코덱까지 같이 지정합니다 — 크롬은 AAC(mp4a)를 지원하지 않아
  //  avc1+opus MP4 로 가고, 사파리는 mp4a(AAC) 를 지원합니다.
  const withSound = withAudio
    ? [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
      ]
    : [];
  const candidates = [
    ...withSound,
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4',
    'video/webm',
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* 무시 */
    }
  }
  return '';
}

/** 바이트 → ASCII 문자열 (큰 배열을 한 번에 펼치면 스택이 넘칩니다 — 8KB 청크로 나눕니다). */
function bytesToAscii(bytes, limit = 524288) {
  const n = Math.min(bytes.length, limit);
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < n; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(n, i + CHUNK)));
  }
  return out;
}

/** 녹화된 blob 의 실제 컨테이너·코덱·오디오 트랙 유무를 확인합니다(안내 문구를 정직하게). */
async function sniffVideo(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 524288).arrayBuffer());
    const text = bytesToAscii(head);
    const audioMarks = /(soun|mp4a|Opus|dOps|A_OPUS|A_VORBIS)/.test(text);
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return {
        container: 'webm',
        ext: 'webm',
        codec: /V_VP9/.test(text) ? 'vp9' : /V_VP8/.test(text) ? 'vp8' : 'unknown',
        audio: /A_OPUS/.test(text) ? 'opus' : /A_VORBIS/.test(text) ? 'vorbis' : audioMarks ? 'unknown' : 'none',
      };
    }
    if (String.fromCharCode.apply(null, head.subarray(4, 8)) === 'ftyp') {
      return {
        container: 'mp4',
        ext: 'mp4',
        codec: /avc1/.test(text) ? 'h264' : /vp09/.test(text) ? 'vp9' : /hvc1|hev1/.test(text) ? 'hevc' : 'unknown',
        audio: /mp4a/.test(text) ? 'aac' : /(Opus|dOps)/.test(text) ? 'opus' : 'none',
      };
    }
    return {
      container: 'unknown',
      ext: blob.type.includes('mp4') ? 'mp4' : 'webm',
      codec: 'unknown',
      audio: audioMarks ? 'unknown' : 'none',
    };
  } catch {
    return { container: 'unknown', ext: blob.type.includes('mp4') ? 'mp4' : 'webm', codec: 'unknown', audio: 'unknown' };
  }
}

function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** 자막을 [강조] 단위로 쪼개 줄바꿈해 그립니다(1080 캔버스 기준). */
function drawSubtitle(ctx, text, width, y, fontSize, lineHeight) {
  const src = String(text || '').trim();
  if (!src) return;
  ctx.font = `900 ${fontSize}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const tokens = [];
  const re = /\[([^\]]+)\]|([^\s\[]+)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(src)) !== null) {
    const gap = src.slice(lastEnd, m.index);
    if (tokens.length && gap.includes(' ')) tokens.push({ space: true });
    tokens.push({ text: m[1] || m[2], hl: Boolean(m[1]) });
    lastEnd = re.lastIndex;
  }
  if (!tokens.length) return;

  const maxWidth = width * 0.86;
  const lines = [];
  let line = [];
  let lineWidth = 0;
  const spaceWidth = ctx.measureText(' ').width;
  for (const tk of tokens) {
    if (tk.space) {
      if (line.length) {
        line.push({ space: true });
        lineWidth += spaceWidth;
      }
      continue;
    }
    const w = ctx.measureText(tk.text).width;
    if (line.length && lineWidth + w > maxWidth) {
      lines.push({ tokens: line, width: lineWidth });
      line = [];
      lineWidth = 0;
    }
    line.push(tk);
    lineWidth += w;
  }
  if (line.length) lines.push({ tokens: line, width: lineWidth });

  const shown = lines.slice(0, 3);
  const blockHeight = shown.length * lineHeight;
  const startY = y - blockHeight / 2 + lineHeight / 2;
  shown.forEach((ln, li) => {
    let x = (width - ln.width) / 2;
    const cy = startY + li * lineHeight;
    for (const tk of ln.tokens) {
      if (tk.space) {
        x += spaceWidth;
        continue;
      }
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillText(tk.text, x + fontSize * 0.035, cy + fontSize * 0.035);
      ctx.fillStyle = tk.hl ? '#C4B5FD' : '#FFFFFF';
      ctx.fillText(tk.text, x, cy);
      x += ctx.measureText(tk.text).width;
    }
  });
}

/** 움직이는 클립 한 프레임 — 9:16 을 꽉 채우도록 자릅니다(cover). */
function drawVideoCover(ctx, video, W, H) {
  const vw = Number(video.videoWidth) || 0;
  const vh = Number(video.videoHeight) || 0;
  if (!vw || !vh) return false;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  try {
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return true;
  } catch {
    // 디코더가 아직 프레임을 못 줬습니다 — 다음 프레임에서 다시 시도합니다.
    return false;
  }
}

/**
 * 내보내기 전에 모든 클립을 미리 받아 둡니다 — 컷 중간에 검은 화면이 뜨지 않게.
 *   · 3개씩 병렬(모바일 메모리·대역폭 보호), URL 당 12초 한도.
 *   · 준비된 클립만 map 에 담아 돌려줍니다 — 못 받은 컷은 포스터·켄번즈로 그립니다.
 */
async function prepareCutVideos({ perCutMs = 12_000 } = {}) {
  const ready = new Map();
  const todo = (state.pkg?.cuts || []).map((cut, i) => ({ cut, i })).filter((x) => x.cut.videoUrl);
  if (!todo.length) return ready;
  for (let at = 0; at < todo.length; at += 3) {
    const part = todo.slice(at, at + 3);
    setToolStatus(`영상 클립 준비 중… ${Math.min(todo.length, at)}/${todo.length}`, 0.05);
    await Promise.all(
      part.map(async ({ i }) => {
        const video = mountCutVideo(i);
        if (!video) return;
        const ok = await waitForVideo(video, perCutMs);
        videoLoad.set(i, ok ? 'ready' : 'failed');
        if (ok) ready.set(i, video);
      }),
    );
  }
  const missing = todo.length - ready.size;
  if (missing > 0) toast(`영상 클립 ${missing}컷을 준비하지 못해 포스터·사진으로 대신 그렸습니다.`);
  return ready;
}

/** <video> 가 첫 프레임을 그릴 수 있을 때까지(또는 한도까지) 기다립니다. */
function waitForVideo(video, timeoutMs = 12_000) {
  if (video.readyState >= 2 && video.videoWidth) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onLoad);
      video.removeEventListener('error', onErr);
      resolve(ok);
    };
    const onLoad = () => finish(video.readyState >= 2 && Boolean(video.videoWidth));
    const onErr = () => finish(false);
    const timer = setTimeout(() => finish(false), Math.max(2000, timeoutMs));
    video.addEventListener('loadeddata', onLoad);
    video.addEventListener('error', onErr);
    try {
      video.load?.();
    } catch {
      /* noop */
    }
  });
}

/** 녹화 중 클립 재생 위치를 컷 타임라인에 맞춥니다. */
function syncExportVideos(t, videos) {
  if (!videos || !videos.size) return;
  const cuts = state.pkg.cuts;
  const idx = Math.min(cuts.length - 1, cutIndexAt(t));
  const cut = cuts[idx];
  cutVideos.forEach((video, i) => {
    if (i === idx) return;
    try {
      video.pause();
    } catch {
      /* noop */
    }
  });
  const video = videos.get(idx);
  if (!video) return;
  const want = clipTimeFor(video, cut, Math.max(0, t - cut.start));
  if (Math.abs((Number(video.currentTime) || 0) - want) > 0.35) {
    try {
      video.currentTime = want;
    } catch {
      /* noop */
    }
  }
  if (video.paused) {
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}

function drawGradientScene(ctx, cut, W, H) {
  const g = ctx.createLinearGradient(0, 0, W * 0.6, H);
  g.addColorStop(0, cut.mood?.from || '#101014');
  g.addColorStop(1, cut.mood?.to || '#2A3340');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.7, H * 0.22, 0, W * 0.7, H * 0.22, W * 0.8);
  glow.addColorStop(0, 'rgba(255,255,255,.16)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawKenBurnsImage(ctx, img, cut, local, idx, W, H) {
  const move = camMove(idx);
  const scale = move.s0 + (move.s1 - move.s0) * local;
  // 무료 제공자(Pollinations) 이미지는 하단 1.2~2.4%(≈14px)에 작은 워터마크가 붙습니다(실측).
  // 9:16 캔버스에 맞춰 자를 때 소스 하단 5%를 제외해 프레임 밖으로 보냅니다.
  const SAFE_BOTTOM = 0.05;
  const sw = img.width;
  const sh = Math.max(1, Math.round(img.height * (1 - SAFE_BOTTOM)));
  const ratio = sw / sh;
  const canvasRatio = W / H;
  let dw;
  let dh;
  if (ratio > canvasRatio) {
    dh = H * scale;
    dw = dh * ratio;
  } else {
    dw = W * scale;
    dh = dw / ratio;
  }
  const dx = (W - dw) / 2 + (move.x / 100) * W * local;
  const dy = (H - dh) / 2 + (move.y / 100) * H * local;
  ctx.drawImage(img, 0, 0, sw, sh, dx, dy, dw, dh);
}

function drawVideoFrame(ctx, t, images, W, H, videos = null) {
  const pkg = state.pkg;
  const cuts = pkg.cuts;
  const idx = Math.min(cuts.length - 1, cutIndexAt(t));
  const cut = cuts[idx];
  const local = Math.min(1, Math.max(0, (t - cut.start) / Math.max(0.001, cut.end - cut.start)));

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0B1020';
  ctx.fillRect(0, 0, W, H);
  // 🎬 움직이는 클립이 우선 — 재생 중인 프레임을 그대로 그립니다.
  const video = videos && typeof videos.get === 'function' ? videos.get(idx) : null;
  if (video && video.readyState >= 2 && video.videoWidth) drawVideoCover(ctx, video, W, H);
  else if (images[idx]) drawKenBurnsImage(ctx, images[idx], cut, local, idx, W, H);
  else drawGradientScene(ctx, cut, W, H);

  // 가독성용 그라데이션 + 비네트
  const bottom = ctx.createLinearGradient(0, H * 0.55, 0, H);
  bottom.addColorStop(0, 'rgba(0,0,0,0)');
  bottom.addColorStop(1, 'rgba(0,0,0,.62)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);

  // 큰 워터마크 단어
  const bigWord = cut.bigWord || '';
  if (bigWord) {
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(W * 0.115)}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    ctx.fillText(bigWord, W / 2, H * 0.26);
    ctx.restore();
  }

  // 상단 컷 진행 세그먼트
  const gap = Math.round(W * 0.008);
  const segW = (W - gap * (cuts.length + 1)) / cuts.length;
  cuts.forEach((c, i) => {
    const p = t <= c.start ? 0 : t >= c.end ? 1 : (t - c.start) / (c.end - c.start);
    const x = gap + i * (segW + gap);
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.fillRect(x, gap, segW, Math.round(H * 0.004));
    if (p > 0) {
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.fillRect(x, gap, segW * p, Math.round(H * 0.004));
    }
  });

  // 컷 카운터
  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${Math.round(W * 0.026)}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  ctx.fillText(`${idx + 1} / ${cuts.length}`, gap + W * 0.02, gap + H * 0.008);
  ctx.textAlign = 'right';
  ctx.fillText(`${t.toFixed(1)}s`, W - gap - W * 0.02, gap + H * 0.008);

  // HOOK 배지
  if (idx === 0) {
    const label = 'HOOK';
    ctx.font = `900 ${Math.round(W * 0.024)}px -apple-system, sans-serif`;
    const bw = ctx.measureText(label).width + W * 0.03;
    const bh = H * 0.03;
    ctx.fillStyle = '#A78BFA';
    ctx.fillRect(gap + W * 0.02, gap + H * 0.032, bw, bh);
    ctx.fillStyle = '#0B1020';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, gap + W * 0.032, gap + H * 0.047);
  }

  // 자막(현재 비트)
  const beats = cut.beats || [];
  let text = cut.subtitle;
  for (let i = 0; i < beats.length; i += 1) {
    if (t < beats[i].end - 0.0001) {
      text = beats[i].text;
      break;
    }
    text = beats[beats.length - 1].text;
  }
  drawSubtitle(ctx, text, W, H * 0.78, Math.round(W * 0.058), Math.round(W * 0.076));
}

function slugForFile() {
  return (state.pkg?.meta?.topic || 'remix').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 28) || 'remix';
}

async function exportVideo() {
  if (!state.pkg || exporter.running) return;

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const W = isIOS ? 720 : 1080;
  const H = Math.round((W * 16) / 9);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    toast('캔버스를 만들지 못했습니다.');
    return;
  }

  const btn = $('#downloadVideoBtn');
  const hasImages = state.pkg.cuts.some((c) => cutHasVisual(c));
  if (!hasImages) toast('아직 장면이 없어 그라데이션 장면으로 렌더합니다. 🎬 버튼으로 장면을 먼저 만들면 더 좋습니다.');

  pause();
  exporter.running = true;
  exporter.cancelled = false;
  if (btn) btn.disabled = true;

  try {
    /* ① 내레이션 먼저 준비 — 영상에는 실제로 소리가 들어가야 합니다. */
    setToolStatus('내레이션 음성 준비 중…', 0);
    let withAudio = 0;
    if (narration.voice !== 'browser') {
      await prepareNarration();
      if (retimeToNarration()) updateFrame(true);
      withAudio = state.pkg.cuts.filter((c) => narrationBuffer(c)).length;
    }
    const total = state.pkg.cuts[state.pkg.cuts.length - 1].end;
    const mime = recorderMime(withAudio > 0);
    if (!mime) {
      toast('이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않습니다. 사파리/크롬 최신 버전에서 시도해 주세요.');
      return;
    }

    setToolStatus(`장면 이미지 준비 중… (약 ${Math.round(total)}초 실시간 렌더)`, 0);
    const images = await Promise.all(state.pkg.cuts.map((c) => loadImage(c.imageUrl)));
    // 🎬 움직이는 클립은 미리 다 받아 둔 뒤, 녹화 중에는 재생 프레임을 캔버스에 그립니다.
    const videos = await prepareCutVideos();
    if (exporter.cancelled) throw new Error('rendering-cancelled');

    /* ② 캔버스 영상 + 내레이션 오디오를 한 스트림으로 */
    const stream = canvas.captureStream(30);
    const audioCtx = withAudio > 0 ? ensureAudioContext() : null;
    let audioDest = null;
    if (audioCtx) {
      audioDest = audioCtx.createMediaStreamDestination();
      const track = audioDest.stream.getAudioTracks()[0];
      if (track) stream.addTrack(track);
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 6_000_000,
      ...(audioDest ? { audioBitsPerSecond: 128_000 } : {}),
    });
    exporter.recorder = recorder;
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    const stopped = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });

    // 첫 프레임을 먼저 그려 두면 녹화 시작이 검은 화면으로 잡히지 않습니다.
    syncExportVideos(0, videos);
    drawVideoFrame(ctx, 0, images, W, H, videos);
    recorder.start(250);

    /* ③ 컷마다 내레이션을 정확한 시각에 예약합니다(A/V 동기). */
    const audioSources = [];
    let audioStartAt = 0;
    if (audioDest) {
      audioStartAt = audioCtx.currentTime + 0.15;
      state.pkg.cuts.forEach((cut) => {
        const buffer = narrationBuffer(cut);
        if (!buffer) return;
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        // 음성이 컷보다 길면 말이 잘리지 않도록 살짝 당겨 재생(최대 2배).
        src.playbackRate.value = Math.min(2, Math.max(1, buffer.duration / Math.max(0.5, cut.end - cut.start)));
        src.connect(audioDest);
        src.start(audioStartAt + cut.start);
        audioSources.push(src);
      });
    }

    const started = performance.now();
    // 오디오가 있을 때는 오디오 시계를 기준으로 그립니다(녹화 시점과 어긋나지 않도록).
    const clockNow = () =>
      audioDest ? Math.max(0, (audioCtx.currentTime - audioStartAt)) : (performance.now() - started) / 1000;

    await new Promise((resolve) => {
      const step = () => {
        const t = Math.min(total, clockNow());
        syncExportVideos(t, videos);
        drawVideoFrame(ctx, t, images, W, H, videos);
        const audioNote = withAudio ? ` · 음성 ${withAudio}/${state.pkg.cuts.length}` : ' · 음성 없음';
        setToolStatus(`영상 렌더링 ${Math.round((t / total) * 100)}% · ${t.toFixed(1)}/${total.toFixed(1)}초${audioNote}`, t / total);
        if (exporter.cancelled || t >= total) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    audioSources.forEach((src) => {
      try {
        src.stop();
      } catch {
        /* 이미 끝났습니다 */
      }
    });
    pauseCutVideos();
    stream.getAudioTracks().forEach((track) => track.stop());

    recorder.stop();
    await stopped;
    exporter.recorder = null;

    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (!blob.size) throw new Error('빈 파일이 만들어졌습니다. 다시 시도해 주세요.');
    const kind = await sniffVideo(blob);
    if (kind.audio === 'none') {
      // 녹화에 쓴 mime 이 오디오 코덱을 지정했다면 그 코덱이 실제로 들어간 것입니다.
      if (/mp4a/.test(mime)) kind.audio = 'aac';
      else if (/opus/.test(mime)) kind.audio = 'opus';
    }
    const name = `${slugForFile()}_shorts_${W}x${H}.${kind.ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    const codecNote = kind.codec === 'h264' ? 'H.264 MP4' : kind.codec === 'vp9' || kind.codec === 'vp8' ? `${kind.codec.toUpperCase()} WebM` : kind.container.toUpperCase();
    const warn = kind.container === 'mp4' && kind.codec === 'vp9' ? ' · 일부 아이폰 플레이어에서 안 열릴 수 있습니다' : '';
    const audioNote = kind.audio !== 'none' ? ` · ${audioLabel(kind.audio)} 내레이션 포함` : ' · 음성 트랙 없음';
    const opusWarn =
      kind.container === 'mp4' && kind.audio === 'opus' ? ' · 아이폰 사진 앱에서 소리가 빠질 수 있습니다(유튜브·인스타 업로드/PC 재생은 정상)' : '';
    setToolStatus(`${name} · ${(blob.size / 1024 / 1024).toFixed(1)}MB · ${codecNote}${warn}${audioNote}`, 1);
    toast(
      kind.audio !== 'none'
        ? `영상 파일(${codecNote})을 내려받았습니다. 중후한 남성 내레이션이 함께 담겼습니다.${opusWarn ? ' 아이폰 사진 앱에서는 소리가 빠질 수 있습니다.' : ''}`
        : `영상 파일(${codecNote})을 내려받았습니다. 음성은 포함되지 않았습니다.`,
    );
    setTimeout(() => setToolStatus('', 0), 8000);
  } catch (err) {
    setToolStatus('', 0);
    toast(`영상 렌더 실패: ${String(err?.message || err).slice(0, 100)}`);
  } finally {
    exporter.running = false;
    if (btn) btn.disabled = false;
  }
}

function audioLabel(codec) {
  if (codec === 'aac') return 'AAC';
  if (codec === 'opus') return 'Opus';
  if (codec === 'vorbis') return 'Vorbis';
  return '음성';
}

/* ───────────────────────── 9:16 플레이어 ───────────────────────── */

/** 한 컷의 자막을 화면에 순차로 띄울 '비트'로 나눕니다 (숏츠 자막 호흡). */
function buildBeats(cut) {
  const text = String(cut.subtitle || '').trim();
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const pieces = [];
  // [강조] 대괄호 안에서 끊으면 다음 비트에 "노선]" 처럼 닫는 괄호만 남습니다. 바깥 위치로 물러섭니다.
  const outsideEmphasis = (source, at) => {
    let depth = 0;
    for (let i = 0; i < at; i += 1) {
      if (source[i] === '[') depth += 1;
      else if (source[i] === ']') depth = Math.max(0, depth - 1);
    }
    let pos = at;
    while (pos > 0 && depth > 0) {
      pos -= 1;
      if (source[pos] === '[') depth -= 1;
      else if (source[pos] === ']') depth += 1;
    }
    // 대괄호를 가로지른 자리면 그 앞 공백까지 물러섭니다.
    while (pos > 6 && source[pos] !== ' ') pos -= 1;
    return pos;
  };
  for (const sentence of sentences) {
    const plain = stripMarkup(sentence);
    if (plain.length <= 26) {
      pieces.push(sentence);
      continue;
    }
    // 긴 문장만 쉼표 → 어절 순서로 끊습니다 (말이 중간에서 끊기지 않게).
    const commaAt = outsideEmphasis(sentence, Math.max(sentence.lastIndexOf(', ', 26), sentence.lastIndexOf(' ', 24)));
    if (commaAt > 8 && commaAt < sentence.length - 2) {
      pieces.push(sentence.slice(0, commaAt + 1).trim());
      pieces.push(sentence.slice(commaAt + 1).trim());
    } else {
      const cutAt = outsideEmphasis(sentence, sentence.lastIndexOf(' ', 24));
      if (cutAt > 8) {
        pieces.push(sentence.slice(0, cutAt).trim());
        pieces.push(sentence.slice(cutAt + 1).trim());
      } else {
        pieces.push(sentence);
      }
    }
  }
  const totalChars = pieces.reduce((n, p) => n + stripMarkup(p).length, 0) || 1;
  const span = Math.max(0.6, cut.end - cut.start);
  let cursor = cut.start;
  return pieces.map((textPiece, i) => {
    const share = stripMarkup(textPiece).length / totalChars;
    const start = Number(cursor.toFixed(2));
    const end = i === pieces.length - 1 ? cut.end : Number((cursor + span * share).toFixed(2));
    cursor = end;
    return { start, end, text: textPiece };
  });
}

const CAM_MOVES = [
  { s0: 1.02, s1: 1.1, x: 0, y: -1.2 },
  { s0: 1.1, s1: 1.02, x: 0, y: 1.2 },
  { s0: 1.04, s1: 1.12, x: -1.6, y: 0 },
  { s0: 1.12, s1: 1.04, x: 1.6, y: 0 },
];

/** 3D 다이오라마용 켄번즈 — 조금 더 큰 푸시·팬으로 미니어처를 들여다보는 느낌을 냅니다. */
const CAM_MOVES_3D = [
  { s0: 1.04, s1: 1.16, x: -1.4, y: -1.8 },
  { s0: 1.14, s1: 1.03, x: 1.4, y: 1.6 },
  { s0: 1.06, s1: 1.18, x: -2.0, y: 0.4 },
  { s0: 1.18, s1: 1.05, x: 2.0, y: -0.4 },
];

/** 비주얼 스타일에 맞는 카메라 무빙 */
function camMove(idx) {
  const set = state.visualStyle === '3d' ? CAM_MOVES_3D : CAM_MOVES;
  return set[idx % set.length];
}

/* ───────────── 🎬 컷별 영상 클립 재생 (미리보기·내보내기 공용) ───────────── */

function videoLayer() {
  return $('#sceneVideoLayer');
}

/** 영상 레이어를 비우고 <video> 핸들을 초기화합니다(플레이어를 다시 만들 때). */
function resetCutVideos() {
  cutVideos.forEach((video) => {
    try {
      video.pause();
    } catch {
      /* noop */
    }
    video.removeAttribute('src');
    video.remove?.();
  });
  cutVideos.clear();
  videoLoad.clear();
  const layer = videoLayer();
  if (layer) layer.innerHTML = '';
}

/**
 * 컷 index 의 <video> 를 만들어 둡니다(이미 있으면 재사용).
 *   · muted + playsinline — 아이폰에서도 소리 없이 자동 재생됩니다.
 *   · 표시만 opacity 로 바꿉니다(display:none 이면 일부 브라우저가 프레임을 그리지 않아
 *     캔버스 drawImage 가 빈 화면이 됩니다).
 */
function mountCutVideo(index) {
  const cut = state.pkg?.cuts?.[index];
  const layer = videoLayer();
  if (!cut?.videoUrl || !layer) return null;
  let video = cutVideos.get(index);
  if (!video) {
    video = document.createElement('video');
    video.className = 'scene-video absolute inset-0 h-full w-full object-cover';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('aria-hidden', 'true');
    video.loop = true;
    video.preload = 'metadata';
    video.style.opacity = '0';
    video.addEventListener('loadeddata', () => videoLoad.set(index, 'ready'));
    video.addEventListener('error', () => videoLoad.set(index, 'failed'));
    layer.appendChild(video);
    cutVideos.set(index, video);
  }
  if (video.dataset.src !== cut.videoUrl) {
    video.dataset.src = cut.videoUrl;
    video.src = cut.videoUrl;
    videoLoad.set(index, 'loading');
    try {
      video.load();
    } catch {
      /* noop */
    }
  }
  return video;
}

/** 반복 재생 클립의 현재 위치 — 컷 안에서 흐른 시간을 클립 길이로 감쌉니다. */
function clipTimeFor(video, cut, local) {
  const dur = Number(video?.duration) || Number(cut?.videoDuration) || 0;
  if (!dur || !Number.isFinite(dur)) return Math.max(0, local);
  return Math.max(0, local) % dur;
}

/** 컷 전환 — 그 컷의 클립만 보이게 하고, 처음부터(또는 이어서) 재생합니다. */
function activateCutVideo(index, local = 0, playing = player.playing) {
  cutVideos.forEach((video, i) => {
    if (i === index) return;
    try {
      video.pause();
    } catch {
      /* noop */
    }
    video.style.opacity = '0';
  });
  const shade = $('#sceneVideoShade');
  const cut = state.pkg?.cuts?.[index];
  const video = cut?.videoUrl ? mountCutVideo(index) : null;
  if (!video) {
    if (shade) shade.style.opacity = '0';
    return false;
  }
  video.style.opacity = '1';
  if (shade) shade.style.opacity = '1';
  const want = clipTimeFor(video, cut, local);
  if (Math.abs((Number(video.currentTime) || 0) - want) > 0.4) {
    try {
      video.currentTime = want;
    } catch {
      /* 메타데이터 전이면 무시 */
    }
  }
  if (playing) {
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } else {
    try {
      video.pause();
    } catch {
      /* noop */
    }
  }
  return true;
}

/** 재생 중 드리프트 보정 — 클립이 컷 타임라인과 어긋나면 살짝 당깁니다. */
function syncCutVideo(index, local) {
  const video = cutVideos.get(index);
  if (!video || video.style.opacity !== '1') return;
  if (!player.playing) return;
  const cut = state.pkg?.cuts?.[index];
  const want = clipTimeFor(video, cut, local);
  const cur = Number(video.currentTime) || 0;
  const dur = Number(video.duration) || 0;
  // 되감김(루프 경계)은 정상이므로 큰 차이만 보정합니다.
  const gap = Math.min(Math.abs(cur - want), dur ? Math.abs(Math.abs(cur - want) - dur) : Infinity);
  if (gap > 0.8) {
    try {
      video.currentTime = want;
    } catch {
      /* noop */
    }
  }
  if (video.paused) {
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}

/** 모든 클립 정지 — 일시정지·플레이어 닫기·내보내기 시작에서 부릅니다. */
function pauseCutVideos() {
  cutVideos.forEach((video) => {
    try {
      video.pause();
    } catch {
      /* noop */
    }
  });
}

function buildPlayer() {
  resetCutVideos();
  const pkg = state.pkg;
  if (!pkg) return;
  const stack = $('#sceneStack');
  const segs = $('#segments');
  stack.innerHTML = '';
  segs.innerHTML = '';

  pkg.cuts.forEach((cut, i) => {
    const scene = document.createElement('div');
    scene.className = 'scene-layer';
    scene.style.backgroundImage = cut.imageUrl
      ? `linear-gradient(rgba(0,0,0,.25), rgba(0,0,0,.45)), url("${cut.imageUrl}")`
      : `linear-gradient(155deg, ${cut.mood.from} 0%, ${cut.mood.to} 100%)`;
    stack.appendChild(scene);

    const seg = document.createElement('button');
    seg.type = 'button';
    seg.className = 'flex-1 h-[3px] rounded-sm bg-white/25 overflow-hidden';
    seg.setAttribute('aria-label', `${i + 1}번 컷으로 이동`);
    seg.innerHTML = '<span class="block h-full w-0 bg-white"></span>';
    seg.addEventListener('click', () => seekToCut(i, true));
    segs.appendChild(seg);
  });

  player.total = pkg.cuts[pkg.cuts.length - 1].end;
  player.t = 0;
  player.idx = -1;
  player.beatIdx = -1;
  renderCues();
  updateFrame(true);
}

function renderCues() {
  const wrap = $('#cueList');
  if (!wrap) return;
  wrap.innerHTML = '';
  state.pkg.cuts.forEach((cut, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'w-full text-left px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5 hover:border-violet-500/40 transition';
    btn.innerHTML = `
      <span class="block text-[10px] font-bold text-violet-300">${clock(cut.start)} - ${clock(cut.end)}</span>
      <span class="block text-xs text-slate-300 leading-snug mt-0.5">${escapeHtml(stripMarkup(cut.subtitle)).slice(0, 60)}</span>
    `;
    btn.addEventListener('click', () => seekToCut(i, true));
    wrap.appendChild(btn);
  });
}

function beatAt(cut) {
  const beats = cut.beats || [];
  for (let i = 0; i < beats.length; i += 1) if (player.t < beats[i].end - 0.0001) return { index: i, text: beats[i].text };
  return beats.length ? { index: beats.length - 1, text: beats[beats.length - 1].text } : null;
}

function cutIndexAt(t) {
  const cuts = state.pkg.cuts;
  for (let i = 0; i < cuts.length; i += 1) if (t < cuts[i].end - 0.0001) return i;
  return cuts.length - 1;
}

function updateFrame(force = false) {
  const pkg = state.pkg;
  if (!pkg) return;
  const idx = cutIndexAt(player.t);
  if (idx !== player.idx || force) {
    player.idx = idx;
    onCutEnter(idx);
  }
  const beat = beatAt(pkg.cuts[idx]);
  if (beat && beat.index !== player.beatIdx) {
    player.beatIdx = beat.index;
    paintSubtitle(beat.text, true);
  }
  const cut = pkg.cuts[idx];
  const local = Math.min(1, Math.max(0, (player.t - cut.start) / Math.max(0.001, cut.end - cut.start)));
  const move = camMove(idx);
  const scene = $('#sceneStack').children[idx];
  if (scene) {
    const scale = move.s0 + (move.s1 - move.s0) * local;
    scene.style.transform = `translate3d(${move.x * local}%, ${move.y * local}%, 0) scale(${scale})`;
  }
  // 움직이는 클립은 켄번즈 대신 실제 재생 위치를 컷 타임라인에 맞춥니다.
  syncCutVideo(idx, Math.max(0, player.t - cut.start));
  [...$('#segments').children].forEach((seg, i) => {
    const c = pkg.cuts[i];
    const p = player.t <= c.start ? 0 : player.t >= c.end ? 1 : (player.t - c.start) / (c.end - c.start);
    seg.firstElementChild.style.width = `${(p * 100).toFixed(1)}%`;
  });
  $('#timeCounter').textContent = `${player.t.toFixed(1)}s`;
}

function onCutEnter(idx) {
  const cut = state.pkg.cuts[idx];
  $('#cutCounter').textContent = `${idx + 1} / ${state.pkg.cuts.length}`;
  $('#hookBadge').classList.toggle('hidden', idx !== 0);
  $('#bigWord').textContent = cut.bigWord || '';
  player.beatIdx = -1;
  [...$('#sceneStack').children].forEach((s, i) => s.classList.toggle('is-active', i === idx));
  // 🎬 이 컷에 영상 클립이 있으면 그 클립만 보이게 하고 이어서 재생합니다.
  activateCutVideo(idx, Math.max(0, player.t - cut.start));
  if (player.playing && !player.mute) {
    const offset = Math.max(0, player.t - cut.start);
    if (!playNarration(idx, offset)) speak(cut);
  }
}

function paintSubtitle(text, animate) {
  const el = $('#subtitle');
  // 줄바꿈보다 먼저 [강조] 를 토큰으로 묶습니다 — 그래야 대괄호가 줄 사이에서 쪼개지지 않습니다.
  const lines = wrapTokens(tokenizeCaption(text), 15).slice(0, 3);
  el.innerHTML = lines
    .map((line) => {
      const html = line
        .map((part) => {
          if (part.space) return ' ';
          return `<span class="${part.hl ? 'text-violet-300' : ''}">${escapeHtml(part.text)}</span>`;
        })
        .join('');
      return `<span class="block">${html}</span>`;
    })
    .join('');
  // 비트가 바뀔 때 자막 블록 전체가 살짝 떠오릅니다 (단어별 애니메이션은 줄바꿈에서 겹쳐 보였습니다).
  el.classList.remove('animate-pop-in');
  if (animate) {
    void el.offsetWidth;
    el.classList.add('animate-pop-in');
  }
}

/** `[강조 구절]`(여러 단어 가능)과 낱말을 같은 토큰 목록으로 만듭니다. */
function tokenizeCaption(text) {
  const src = String(text || '');
  const tokens = [];
  const re = /\[([^\]]*)\]|([^\s\[]+)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(src)) !== null) {
    if (lastEnd === 0 && m.index > 0) {
      /* 앞쪽 공백은 무시 */
    } else if (m.index > lastEnd && /\s/.test(src.slice(lastEnd, m.index))) {
      tokens.push({ space: true });
    }
    tokens.push({ text: m[1] != null ? m[1] : m[2], hl: m[1] != null });
    lastEnd = re.lastIndex;
  }
  return tokens;
}

function wrapTokens(tokens, maxChars) {
  const lines = [[]];
  let len = 0;
  tokens.forEach((tk) => {
    if (tk.space) {
      const line = lines[lines.length - 1];
      if (line.length) {
        line.push(tk);
        len += 1;
      }
      return;
    }
    const width = [...tk.text].length;
    if (len && len + width > maxChars) {
      lines.push([]);
      len = 0;
    }
    lines[lines.length - 1].push(tk);
    len += width;
  });
  return lines.filter((line) => line.some((tk) => !tk.space));
}


function speak(cut) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(speechText(cut));
    u.lang = 'ko-KR';
    u.rate = player.rate;
    u.pitch = 0.98;
    if (player.voice) u.voice = player.voice;
    window.speechSynthesis.speak(u);
  } catch {
    /* 음성 미지원 브라우저는 조용히 넘어갑니다 */
  }
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices() || [];
  const ko = voices.filter((v) => /^ko/i.test(v.lang));
  if (!ko.length) return;
  player.voice = ko.find((v) => /Google/i.test(v.name)) || ko.find((v) => /(Sora|Yuna|Suhyun|SunHi)/i.test(v.name)) || ko[0];
  // 서버 TTS 를 쓰는 중에는 안내 문구를 건드리지 않습니다(내레이션 상태가 우선).
  if (narration.voice === 'browser') {
    $('#voiceNote').textContent = `음성: ${player.voice.name} · 브라우저 음성(Web Speech) · 아이폰은 무음 모드를 해제하세요.`;
  }
}

function play() {
  if (!state.pkg || player.playing) return;
  if (player.t >= player.total - 0.05) player.t = 0;
  player.playing = true;
  $('#bigPlay').classList.add('opacity-0', 'pointer-events-none');
  $('#playBtn').textContent = '❚❚ 일시정지';
  player.last = performance.now();
  updateFrame(true);
  cancelAnimationFrame(player.raf);
  player.raf = requestAnimationFrame(frame);
}

function frame(now) {
  if (!player.playing) return;
  const dt = Math.min(0.12, (now - player.last) / 1000);
  player.last = now;
  player.t += dt;
  if (player.t >= player.total) {
    player.t = player.total;
    updateFrame();
    pause();
    return;
  }
  updateFrame();
  player.raf = requestAnimationFrame(frame);
}

function pause() {
  player.playing = false;
  cancelAnimationFrame(player.raf);
  pauseCutVideos();
  $('#bigPlay')?.classList.remove('opacity-0', 'pointer-events-none');
  const btn = $('#playBtn');
  if (btn) btn.textContent = '▶ 재생';
  stopNarration();
  try {
    window.speechSynthesis && window.speechSynthesis.cancel();
  } catch {
    /* noop */
  }
}

function seekToCut(i, autoplay = false) {
  if (!state.pkg) return;
  const cut = state.pkg.cuts[i];
  player.t = cut.start;
  player.idx = -1;
  player.beatIdx = -1;
  updateFrame(true);
  if (autoplay) {
    if (player.playing) {
      player.last = performance.now();
      stopNarration();
      if (!player.mute && !playNarration(i, 0)) speak(cut);
    } else {
      play();
    }
  } else {
    stopNarration();
  }
}

async function openPlayer() {
  if (!state.pkg) return;
  const section = $('#playerSection');
  section.classList.remove('hidden');
  state.playerOpen = true;
  buildPlayer();
  refreshImageBadgeFromPkg();
  player.rate = state.pkg.tts.rate;
  $('#speedRange').value = String(player.rate);
  $('#speedVal').textContent = `${player.rate.toFixed(2)}x`;
  paintVoicePills();
  paintStyleToggle();
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 내레이션을 먼저 준비한 뒤 재생합니다 — 재생 중에 컷 길이가 바뀌면 말이 끊기기 때문입니다.
  // 문장을 고친 컷이 있어 일부만 준비된 경우에도 새 문장 음성을 마저 받습니다.
  const prepared = narrationCount();
  if (narration.voice !== 'browser' && prepared.ready < prepared.total) {
    pause();
    await prepareNarration();
    if (!state.playerOpen) return;
    if (retimeToNarration()) {
      updateFrame(true);
      renderCues();
    }
  } else {
    defaultNarrationNote();
  }
  play();
}

function closePlayer() {
  pause();
  state.playerOpen = false;
  $('#playerSection')?.classList.add('hidden');
}

/* ───────────────────────── 내보내기 ───────────────────────── */

function scriptText() {
  const pkg = state.pkg;
  const bp = state.blueprint || {};
  const photos = pkg.cuts.filter((c) => !c.videoUrl && c.imageKind === 'photo' && c.imageCredit);
  const clips = pkg.cuts.filter((c) => c.videoUrl);
  const head = [
    `# ${bp.source?.title ? `${pkg.meta.topic} (${bp.source.title.slice(0, 40)} 리믹스)` : pkg.meta.topic}`,
    `총 ${Math.round(pkg.meta.totalSec)}초 · ${pkg.cuts.length}컷 · 템포 ${pkg.tts.rate}x · ${pkg.meta.strategyLabel}`,
    `해시태그: ${(pkg.hashtags || []).map((h) => `#${h}`).join(' ')}`,
    '',
  ];
  const body = pkg.cuts.map(
    (c) =>
      `[${c.index + 1}] ${clock(c.start)}-${clock(c.end)} · ${c.label}\n내레이션: ${c.narration || stripMarkup(c.subtitle)}\n자막: ${c.subtitle}\n연출: ${c.visualKo}\n카메라: ${c.camera}\n`,
  );
  // 실사 사진·스톡 영상은 라이선스 표기가 필요합니다 — 영상 설명에 붙여넣을 수 있게 함께 내보냅니다.
  const credits = photos.length || clips.length
    ? [
        '',
        '[장면 출처 — 영상 설명에 함께 적어 주세요]',
        ...clips.map(
          (c) =>
            `Scene ${c.index + 1}: ${c.videoCredit || providerName(c.videoProvider)}${c.videoPage ? ` (${c.videoPage})` : ''}`,
        ),
        ...photos.map((c) => `Scene ${c.index + 1}: ${c.imageCredit}${c.imagePhoto?.page ? ` (${c.imagePhoto.page})` : ''}`),
      ]
    : [];
  return [...head, ...body, ...credits].join('\n');
}

function promptsText() {
  return state.pkg.cuts
    .map((c) => `#${c.index + 1} ${c.label} (${c.start.toFixed(1)}s–${c.end.toFixed(1)}s)\n${c.visualKo}\nEN: ${c.visualPrompt}`)
    .join('\n\n');
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(okMsg);
    } catch {
      toast('복사가 막혔습니다. 길게 눌러 직접 복사해 주세요.');
    }
    ta.remove();
  }
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`${name} 내려받기 시작`);
}

function doExport(kind) {
  if (!state.pkg) return;
  const slug = state.pkg.meta.topic.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 28) || 'remix';
  if (kind === 'script') return copyText(scriptText(), '전체 스크립트를 복사했습니다.');
  if (kind === 'prompts') return copyText(promptsText(), '장면 프롬프트를 복사했습니다.');
  if (kind === 'srt') return download(`${slug}.srt`, buildSrt(state.pkg.cuts), 'application/x-subrip');
  if (kind === 'json')
    return download(`${slug}_package.json`, JSON.stringify({ ...state.pkg, blueprint: state.blueprint }, null, 2), 'application/json');
}

/* ───────────────────────── 이벤트 ───────────────────────── */

function bind() {
  $('#remixForm').addEventListener('submit', generate);
  $('#ctaButton').addEventListener('click', openPlayer);
  $('#closePlayer').addEventListener('click', closePlayer);

  /* 씬 카드 인라인 편집 — 카드가 다시 그려져도 살아 있게 목록에 위임합니다. */
  const scenes = $('#scenesList');
  scenes.addEventListener('input', onSceneEdit);
  scenes.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-regen]');
    if (!btn) return;
    event.preventDefault();
    regenerateCutVisual(Number(btn.dataset.regen));
  });
  scenes.addEventListener('focusout', (event) => {
    const field = event.target.closest('[data-edit]');
    if (!field) return;
    commitCutEdit(Number(field.dataset.cut));
  });

  $('#playBtn').addEventListener('click', () => (player.playing ? pause() : play()));
  $('#bigPlay').addEventListener('click', () => play());
  $('#restartBtn').addEventListener('click', () => {
    const wasPlaying = player.playing;
    pause();
    player.t = 0;
    player.idx = -1;
    updateFrame(true);
    if (wasPlaying) play();
  });
  $('#muteBtn').addEventListener('click', () => {
    player.mute = !player.mute;
    const b = $('#muteBtn');
    b.setAttribute('aria-pressed', String(!player.mute));
    b.textContent = player.mute ? '🔇 무음' : '🔊 음성';
    setGain(!player.mute);
    if (player.mute) {
      stopNarration();
      try {
        window.speechSynthesis && window.speechSynthesis.cancel();
      } catch {
        /* noop */
      }
    } else if (player.playing && state.pkg) {
      const cut = state.pkg.cuts[player.idx];
      if (!playNarration(player.idx, Math.max(0, player.t - cut.start))) speak(cut);
    }
  });
  $('#speedRange').addEventListener('input', (e) => {
    player.rate = Number(e.target.value);
    $('#speedVal').textContent = `${player.rate.toFixed(2)}x`;
    if (player.playing && !player.mute && state.pkg) {
      const cut = state.pkg.cuts[player.idx];
      if (!playNarration(player.idx, Math.max(0, player.t - cut.start))) speak(cut);
    }
  });

  $$('[data-voice]').forEach((btn) => btn.addEventListener('click', () => setNarrationVoice(btn.dataset.voice)));
  $$('[data-style]').forEach((btn) => btn.addEventListener('click', () => setVisualStyle(btn.dataset.style)));
  $$('[data-length]').forEach((btn) => btn.addEventListener('click', () => setLength(btn.dataset.length)));

  $$('[data-export]').forEach((btn) => btn.addEventListener('click', () => doExport(btn.dataset.export)));

  $('#genImagesBtn')?.addEventListener('click', generateCutImages);
  $('#downloadVideoBtn')?.addEventListener('click', exportVideo);
  paintImageBadge('무료 AI 이미지 · 준비됨', 'ok');
  paintStyleToggle();
  paintLengthPicker();
  paintVoicePills();
  defaultNarrationNote();
  loadHealth();

  document.addEventListener('keydown', (e) => {
    if (!state.pkg || !state.playerOpen) return;
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      player.playing ? pause() : play();
    }
  });

  if ('speechSynthesis' in window) {
    pickVoice();
    window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }
}

bind();

/* 같은 창에서 다시 만들 때 이전 음성이 남지 않도록 */
window.addEventListener('pagehide', () => {
  try {
    window.speechSynthesis && window.speechSynthesis.cancel();
  } catch {
    /* noop */
  }
});

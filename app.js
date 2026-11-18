/**
 * app.js — VIRAL REMIX · AI SHORTS STUDIO
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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  pkg: null,
  blueprint: null,
  loading: false,
  playerOpen: false,
};

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
  startProgress();
  closePlayer();
  $('#resultSection').classList.add('hidden');

  try {
    const res = await fetch('/api/analyze-and-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: parsed.canonical, topic, tone: 'auto', length: 36 }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw new Error((data && data.message) || `요청 실패 (HTTP ${res.status})`);

    state.pkg = data.package;
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

  $('#resultSub').textContent = `${pkg.meta.strategyLabel} · ${pkg.cuts.length}컷 · 약 ${Math.round(pkg.meta.totalSec)}초`;
  $('#scriptTopic').textContent = pkg.meta.topic;
  $('#scriptMeta').textContent = `총 ${Math.round(pkg.meta.totalSec)}초 · 컷당 ${(pkg.meta.totalSec / pkg.cuts.length).toFixed(1)}초 · 템포 ${pkg.tts.rate}x`;

  /* Viral DNA */
  const hook = bp.hook || {};
  $('#dnaHook').textContent = hook.label || '호기심 갭 훅';
  $('#dnaHookDesc').textContent = hook.why || '첫 문장에서 결론을 미루는 구조';

  const rhythm = bp.rhythm || {};
  if (rhythm.measured) {
    $('#dnaCaption').textContent = `${Math.max(6, rhythm.avgSentenceChars - 3)}~${rhythm.avgSentenceChars + 3}자`;
    $('#dnaCaptionDesc').textContent = `레퍼런스 대사 평균 ${rhythm.avgSentenceChars}자 · 짧고 직관적인 자막`;
  } else {
    $('#dnaCaption').textContent = `${bp.subtitle?.maxCharsPerLine || 18}자 이내`;
    $('#dnaCaptionDesc').textContent = '숏츠 표준값 · 짧고 직관적인 자막';
  }

  $('#dnaPace').textContent = `${bp.pacing?.tempo || 1.21}x · 컷당 ${bp.pacing?.cutSecAvg || 5}초`;
  $('#dnaPaceDesc').textContent = rhythm.wpm ? `분당 ${rhythm.wpm}어절 · 무음 없이 이어 붙이기` : '1~3초 단위 화면 전환 · 무음 없음';

  const srcMap = { page: '영상 페이지', oembed: 'oEmbed', 'data-api': 'YouTube API', none: '메타데이터 없음' };
  $('#dnaSource').textContent = bp.source?.title
    ? `${bp.source.title.slice(0, 70)} · ${bp.source.channel || '채널 미확인'} · ${bp.source.durationKnown ? `${bp.source.durationSec}초` : '길이 추정'} · 읽은 경로: ${srcMap[bp.source.fetchedBy] || bp.source.fetchedBy}`
    : '레퍼런스 메타데이터를 못 가져와 표준값으로 분석했습니다.';

  $('#dnaEvidence').innerHTML = (bp.evidence || []).map((line) => `<li>· ${escapeHtml(line)}</li>`).join('');

  /* Scenes */
  const list = $('#scenesList');
  list.innerHTML = '';
  pkg.cuts.forEach((cut, i) => {
    const card = document.createElement('article');
    card.className = 'rounded-2xl bg-[#131B2E] border border-white/10 p-6 hover:border-violet-500/40 transition';
    card.dataset.cue = String(i);
    card.innerHTML = `
      <div class="flex items-center justify-between mb-5 gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <span class="text-violet-400 font-black text-xl leading-none">${two(i + 1)}</span>
          <div class="min-w-0">
            <h5 class="font-bold">Scene ${i + 1}</h5>
            <p class="text-xs text-slate-500">${escapeHtml(cut.label)}</p>
          </div>
        </div>
        <span class="shrink-0 text-xs text-slate-400 bg-white/5 px-3 py-2 rounded-full">${clock(cut.start)} - ${clock(cut.end)}</span>
      </div>
      <div class="grid md:grid-cols-2 gap-4">
        <div class="bg-[#0B1020] rounded-xl p-5">
          <p class="text-xs text-violet-400 font-bold mb-3">🎙 SCRIPT / DIALOGUE</p>
          <p class="text-sm leading-7 text-slate-200">${highlight(cut.subtitle)}</p>
        </div>
        <div class="bg-[#0B1020] rounded-xl p-5">
          <p class="text-xs text-blue-400 font-bold mb-3">🎬 VISUAL DIRECTION</p>
          <p class="text-sm leading-7 text-slate-400">${escapeHtml(cut.visualKo)}<span class="block mt-1 text-slate-500">카메라: ${escapeHtml(cut.camera)}</span></p>
        </div>
      </div>
    `;
    list.appendChild(card);
  });
}

function highlight(text) {
  // [강조] 표기를 보라색 굵게
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]/g, '<span class="text-violet-300 font-bold">$1</span>')
    .replace(/\n/g, '<br />');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ───────────────────────── 9:16 플레이어 ───────────────────────── */

/** 한 컷의 자막을 화면에 순차로 띄울 '비트'로 나눕니다 (숏츠 자막 호흡). */
function buildBeats(cut) {
  const text = String(cut.subtitle || '').trim();
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const pieces = [];
  for (const sentence of sentences) {
    const plain = stripMarkup(sentence);
    if (plain.length <= 26) {
      pieces.push(sentence);
      continue;
    }
    // 긴 문장만 쉼표 → 어절 순서로 끊습니다 (말이 중간에서 끊기지 않게).
    const commaAt = Math.max(sentence.lastIndexOf(', ', 26), sentence.lastIndexOf(' ', 24));
    if (commaAt > 8 && commaAt < sentence.length - 2) {
      pieces.push(sentence.slice(0, commaAt + 1).trim());
      pieces.push(sentence.slice(commaAt + 1).trim());
    } else {
      const cut = sentence.lastIndexOf(' ', 24);
      if (cut > 8) {
        pieces.push(sentence.slice(0, cut).trim());
        pieces.push(sentence.slice(cut + 1).trim());
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

function buildPlayer() {
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
  const move = CAM_MOVES[idx % CAM_MOVES.length];
  const scene = $('#sceneStack').children[idx];
  if (scene) {
    const scale = move.s0 + (move.s1 - move.s0) * local;
    scene.style.transform = `translate3d(${move.x * local}%, ${move.y * local}%, 0) scale(${scale})`;
  }
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
  if (player.playing && !player.mute) speak(cut);
}

function paintSubtitle(text, animate) {
  const el = $('#subtitle');
  const lines = wrapLines(text || '', 15).slice(0, 3);
  el.innerHTML = lines
    .map((line) => {
      const parts = [];
      const re = /\[([^\]]+)\]|([^\s\[]+)/g;
      let m;
      while ((m = re.exec(line)) !== null) parts.push({ text: m[1] || m[2], hl: Boolean(m[1]) });
      let html = '';
      parts.forEach((part, i) => {
        
        const glue = i > 0 && !/^[,.\u00b7!?~)\]…]/.test(part.text) ? ' ' : '';
        html += `${glue}<span class="${part.hl ? 'text-violet-300' : ''}">${escapeHtml(part.text)}</span>`;
      });
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

function wrapLines(text, maxChars) {
  const tokens = String(text || '').split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const tk of tokens) {
    const plain = stripMarkup(tk);
    if (line && [...stripMarkup(line)].length + plain.length > maxChars) {
      lines.push(line);
      line = tk;
    } else {
      line = line ? `${line} ${tk}` : tk;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function speak(cut) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripMarkup(cut.subtitle));
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
  $('#voiceNote').textContent = `음성: ${player.voice.name} · 브라우저 음성(Web Speech) · 아이폰은 무음 모드를 해제하세요.`;
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
  $('#bigPlay')?.classList.remove('opacity-0', 'pointer-events-none');
  const btn = $('#playBtn');
  if (btn) btn.textContent = '▶ 재생';
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
      if (!player.mute) speak(cut);
    } else {
      play();
    }
  }
}

function openPlayer() {
  if (!state.pkg) return;
  const section = $('#playerSection');
  section.classList.remove('hidden');
  state.playerOpen = true;
  buildPlayer();
  player.rate = state.pkg.tts.rate;
  $('#speedRange').value = String(player.rate);
  $('#speedVal').textContent = `${player.rate.toFixed(2)}x`;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  const head = [
    `# ${bp.source?.title ? `${pkg.meta.topic} (${bp.source.title.slice(0, 40)} 리믹스)` : pkg.meta.topic}`,
    `총 ${Math.round(pkg.meta.totalSec)}초 · ${pkg.cuts.length}컷 · 템포 ${pkg.tts.rate}x · ${pkg.meta.strategyLabel}`,
    `해시태그: ${(pkg.hashtags || []).map((h) => `#${h}`).join(' ')}`,
    '',
  ];
  const body = pkg.cuts.map(
    (c) =>
      `[${c.index + 1}] ${clock(c.start)}-${clock(c.end)} · ${c.label}\n자막: ${c.subtitle}\n연출: ${c.visualKo}\n카메라: ${c.camera}\n`,
  );
  return [...head, ...body].join('\n');
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
    if (player.mute) {
      try {
        window.speechSynthesis && window.speechSynthesis.cancel();
      } catch {
        /* noop */
      }
    } else if (player.playing) {
      speak(state.pkg.cuts[player.idx]);
    }
  });
  $('#speedRange').addEventListener('input', (e) => {
    player.rate = Number(e.target.value);
    $('#speedVal').textContent = `${player.rate.toFixed(2)}x`;
    if (player.playing && !player.mute) speak(state.pkg.cuts[player.idx]);
  });

  $$('[data-export]').forEach((btn) => btn.addEventListener('click', () => doExport(btn.dataset.export)));

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

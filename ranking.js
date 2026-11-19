/**
 * ranking.js — 🏆 TOP 5 랭킹 짜집기 모드 (TakeOne 화면)
 * ─────────────────────────────────────────────────────────────
 * · 왼쪽(레퍼런스 리믹스)은 app.js 가 그대로 담당합니다. 이 파일은 모드 전환만 건드리고,
 *   랭킹 화면·미리보기·내보내기는 모두 여기 안에서 끝냅니다(서로의 상태를 섞지 않습니다).
 * · 클립은 사용자가 브라우저에서 직접 올린 파일(object URL)만 씁니다 — 유튜브 다운로드 없음.
 * · AI 대본은 /api/analyze-ranking. Gemini 가 없으면 서버가 로컬 템플릿으로 폴백하고
 *   화면은 그 사실을 모드 배지에 그대로 적습니다.
 */
import {
  RANKS,
  rankMeta,
  normalizeSlots,
  slotDurationSec,
  effectiveTrim,
  buildRankingTimeline,
  segmentAt,
  validateSlots,
  applyRankingScript,
  splitCaptionLines,
  rankSpeechText,
  rankingExportName,
  recorderMimeCandidates,
  sniffVideoBytes,
} from './lib/ranking.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const rk = {
  mode: 'remix',
  topic: '',
  slots: normalizeSlots([]),
  voice: 'deep',
  clips: new Map(), // rank → { id, url, name, durationSec }
  images: new Map(), // rank → { url, name }
  clipSeq: 0,
  ai: { running: false },
  exporting: false,
  ready: false,
};

const rkPlayer = {
  playing: false,
  t: 0,
  total: 0,
  raf: 0,
  last: 0,
  idx: -1,
  segments: [],
  videos: new Map(),
  narration: new Map(),
  ctx: null,
  gain: null,
  dest: null,
  sources: [],
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = 0;
function rkToast(message) {
  const el = $('#rkToast');
  if (!el) return;
  $('#rkToastText').textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 3200);
}

function slotOf(rank) {
  return rk.slots.find((slot) => slot.rank === Number(rank)) || normalizeSlots(rk.slots)[0];
}

/* ───────────────────────── 모드 전환 ───────────────────────── */

function setMode(mode) {
  const next = mode === 'ranking' ? 'ranking' : 'remix';
  rk.mode = next;
  const remix = $('#remixMode');
  const ranking = $('#rankingMode');
  if (remix) remix.hidden = next === 'ranking';
  if (ranking) ranking.hidden = next !== 'ranking';
  $$('#modeSwitch [data-mode]').forEach((btn) => {
    const on = btn.dataset.mode === next;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', String(on));
  });
  if (next === 'ranking') {
    // 리믹스 플레이어가 돌고 있으면 멈춥니다(숨은 화면에서 소리만 나는 일 방지).
    const playBtn = $('#playBtn');
    if (playBtn && /일시정지/.test(playBtn.textContent || '')) playBtn.click();
    if (!rk.ready) initRanking();
    paintSummary();
  } else {
    pauseRanking();
  }
  try {
    const url = new URL(window.location.href);
    if (next === 'ranking') url.searchParams.set('mode', 'ranking');
    else url.searchParams.delete('mode');
    window.history.replaceState({}, '', url);
  } catch {
    /* 주소를 못 바꿔도 화면은 그대로 동작합니다 */
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ───────────────────────── 슬롯 카드 ───────────────────────── */

function slotStateText(slot, clip = null, image = null) {
  if (clip) return `🎞 ${clip.name}${clip.durationSec ? ` · ${clip.durationSec.toFixed(1)}초` : ' · 길이 미확인'}`;
  if (image) return `🖼 ${image.name} · 클립이 없을 때 이 이미지를 씁니다`;
  return '클립 없음 · 그라데이션 카드로 나옵니다';
}

function cardHtml(slot) {
  const meta = rankMeta(slot.rank);
  const clip = rk.clips.get(slot.rank);
  const image = rk.images.get(slot.rank);
  const trim = effectiveTrim(slot);
  return `
    <article class="rk-slot${meta.gold ? ' is-gold' : ''}" data-rank="${slot.rank}">
      <header class="rk-slot-head">
        <span class="rk-rank-pill">${meta.label}</span>
        <span class="rk-slot-state">${escapeHtml(slotStateText(slot, clip, image))}</span>
      </header>

      <div class="rk-url-row">
        <input class="rk-input rk-url" type="url" inputmode="url" autocomplete="off" spellcheck="false"
          placeholder="https://youtube.com/shorts/..." value="${escapeHtml(slot.url)}" aria-label="${meta.label} 유튜브 주소" />
        <button type="button" class="rk-btn rk-btn-ghost rk-fetch">🔎 정보</button>
      </div>
      <p class="rk-hint rk-yt">${escapeHtml(slot.ytNote || (slot.ytTitle ? `유튜브: ${slot.ytTitle}${slot.ytChannel ? ` · ${slot.ytChannel}` : ''}` : '유튜브 주소를 넣고 정보를 불러오면 제목·자막을 채웁니다. (선택)'))}</p>

      <label class="rk-label">제목
        <input class="rk-input rk-title" maxlength="80" placeholder="항목 이름 — 예: '운동은 1분' 발언"
          value="${escapeHtml(slot.title)}" />
      </label>

      <label class="rk-label">코멘트 · 자막
        <textarea class="rk-input rk-caption" rows="2" maxlength="160"
          placeholder="화면 자막 · 내레이션 — [ ]는 보라색 강조">${escapeHtml(slot.caption)}</textarea>
      </label>

      <div class="rk-trim">
        <label class="rk-label rk-trim-item">시작초
          <input class="rk-input rk-tstart" type="number" min="0" step="0.1" inputmode="decimal" value="${slot.trimStart || ''}" />
        </label>
        <label class="rk-label rk-trim-item">길이(초)
          <input class="rk-input rk-tlen" type="number" min="0" step="0.5" inputmode="decimal" value="${slot.trimSec || ''}" />
        </label>
        <span class="rk-trim-note">기본 ${slot.clipDurationSec ? `클립 ${slot.clipDurationSec.toFixed(1)}초 중 ` : ''}${trim.sec.toFixed(1)}초</span>
      </div>

      <div class="rk-file-row">
        <label class="rk-file">
          <input class="rk-clip" type="file" accept="video/*" />
          <span>🎞 클립 올리기</span>
        </label>
        <span class="rk-file-name">${escapeHtml(clip ? `${clip.name} · ${clip.durationSec.toFixed(1)}초` : 'MP4 · MOV · WebM')}</span>
        <button type="button" class="rk-btn rk-btn-mini rk-clip-clear" ${clip ? '' : 'hidden'}>지우기</button>
      </div>

      <div class="rk-file-row">
        <label class="rk-file rk-file-sub">
          <input class="rk-img" type="file" accept="image/*" />
          <span>🖼 대체 이미지</span>
        </label>
        <span class="rk-file-name">${escapeHtml(image ? image.name : '없으면 그라데이션 카드')}</span>
        <button type="button" class="rk-btn rk-btn-mini rk-img-clear" ${image ? '' : 'hidden'}>지우기</button>
      </div>
    </article>
  `;
}

function renderSlots() {
  const wrap = $('#rkSlots');
  if (!wrap) return;
  wrap.innerHTML = rk.slots.map(cardHtml).join('');
  $$('.rk-slot', wrap).forEach(bindSlot);
}

function readSlotInput(rank, name, value) {
  const slot = slotOf(rank);
  if (!slot) return;
  if (name === 'trimStart' || name === 'trimSec') {
    const n = Number(value);
    slot[name] = Number.isFinite(n) && n > 0 ? n : 0;
  } else {
    slot[name] = String(value ?? '');
  }
  // 제목·코멘트만 고쳐도 '내보내기' 버튼과 준비 상태가 바로 따라오게 합니다.
  paintSummary();
}

function bindSlot(card) {
  const rank = Number(card.dataset.rank);
  const on = (selector, name, event = 'input') => {
    const el = $(selector, card);
    if (!el) return;
    el.addEventListener(event, () => readSlotInput(rank, name, el.value));
    if (event === 'input') el.addEventListener('change', () => readSlotInput(rank, name, el.value));
  };
  on('.rk-url', 'url');
  on('.rk-title', 'title');
  on('.rk-caption', 'caption');
  on('.rk-tstart', 'trimStart');
  on('.rk-tlen', 'trimSec');

  $('.rk-fetch', card).addEventListener('click', () => fetchSlotInfo(rank, card));
  $('.rk-clip', card).addEventListener('change', (event) => attachClip(rank, event.target.files?.[0]));
  $('.rk-img', card).addEventListener('change', (event) => attachImage(rank, event.target.files?.[0]));
  $('.rk-clip-clear', card).addEventListener('click', () => clearClip(rank));
  $('.rk-img-clear', card).addEventListener('click', () => clearImage(rank));
}

/* ───────────────────────── 클립·이미지 ───────────────────────── */

function videoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      v.removeAttribute('src');
      v.remove();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.style.display = 'none';
    v.onloadedmetadata = () => finish(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => finish(0);
    v.src = url;
    // 문서에 붙여야 아이폰 사파리·크로미움 모두 메타데이터를 읽습니다(떼어 둔 요소는 로드하지 않는 경우가 있음).
    document.body.appendChild(v);
    setTimeout(() => finish(Number.isFinite(v.duration) ? v.duration : 0), 8000);
  });
}

async function attachClip(rank, file) {
  if (!file) return;
  const type = String(file.type || '');
  const name = file.name || 'clip';
  if (type && !type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(name)) {
    rkToast('영상 파일이 아닙니다 — MP4 · MOV · WebM 을 올려 주세요.');
    return;
  }
  const duration = await videoDuration(file);
  const previous = rk.clips.get(rank);
  if (previous?.url) URL.revokeObjectURL(previous.url);
  rk.clipSeq += 1;
  rk.clips.set(rank, {
    id: `clip-${rk.clipSeq}`,
    url: URL.createObjectURL(file),
    name,
    durationSec: duration,
  });
  const slot = slotOf(rank);
  slot.clipName = name;
  slot.clipDurationSec = Math.round(duration * 10) / 10;
  if (!slot.trimSec && duration > 0) slot.trimSec = Math.min(6, Math.round(duration * 10) / 10);
  rkPlayer.videos.delete(rank); // 다음 재생에서 새 파일로 다시 붙입니다
  renderSlots();
  paintSummary();
  if (!duration) rkToast('클립을 붙였지만 길이를 읽지 못했습니다. 시작초·길이(초)를 직접 넣어 주세요.');
}

function clearClip(rank) {
  const entry = rk.clips.get(rank);
  if (entry?.url) URL.revokeObjectURL(entry.url);
  rk.clips.delete(rank);
  const video = rkPlayer.videos.get(rank);
  if (video) {
    video.pause();
    video.remove();
    rkPlayer.videos.delete(rank);
  }
  const slot = slotOf(rank);
  slot.clipName = '';
  slot.clipDurationSec = 0;
  renderSlots();
  paintSummary();
}

function attachImage(rank, file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    rkToast('이미지 파일이 아닙니다.');
    return;
  }
  const previous = rk.images.get(rank);
  if (previous?.url) URL.revokeObjectURL(previous.url);
  rk.images.set(rank, { url: URL.createObjectURL(file), name: file.name || 'image' });
  const slot = slotOf(rank);
  slot.imageName = file.name || 'image';
  renderSlots();
  paintSummary();
}

function clearImage(rank) {
  const entry = rk.images.get(rank);
  if (entry?.url) URL.revokeObjectURL(entry.url);
  rk.images.delete(rank);
  slotOf(rank).imageName = '';
  renderSlots();
  paintSummary();
}

/* ───────────────────────── 유튜브 정보 ───────────────────────── */

async function fetchSlotInfo(rank, card) {
  const slot = slotOf(rank);
  const url = String(slot.url || '').trim();
  if (!url) {
    rkToast('유튜브 주소를 먼저 넣어 주세요.');
    return;
  }
  const btn = $('.rk-fetch', card);
  const note = $('.rk-yt', card);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  if (note) note.textContent = '영상 정보를 가져오는 중…';
  try {
    const res = await fetch('/api/analyze-ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'slot', rank, url, topic: rk.topic }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.message || `영상 정보를 가져오지 못했습니다 (HTTP ${res.status})`);
    const info = data.slot || {};
    slot.videoId = info.videoId || slot.videoId;
    slot.ytTitle = info.title || slot.ytTitle;
    slot.ytChannel = info.channel || slot.ytChannel;
    slot.ytDurationSec = Number(info.durationSec) || slot.ytDurationSec;
    slot.ytTranscript = info.transcript || '';
    slot.ytNote = info.transcriptNote || '';
    slot.ytFetchedBy = info.fetchedBy || '';
    if (!slot.title.trim() && info.title) slot.title = info.title;
    if (!slot.caption.trim() && info.captionSuggestion) slot.caption = info.captionSuggestion;
    renderSlots();
    paintSummary();
    const bits = [];
    if (info.title) bits.push(`제목: ${info.title}`);
    if (info.durationSec) bits.push(`${info.durationSec}초`);
    if (info.transcriptChars) bits.push(`자막 ${info.transcriptChars}자`);
    if (info.captionSuggestion) bits.push('코멘트 후보를 채웠습니다');
    rkToast(`${rankMeta(rank).label} · ${bits.join(' · ') || '정보를 가져왔습니다'}`);
  } catch (err) {
    const message = String(err?.message || err).slice(0, 140);
    if (note) note.textContent = message;
    rkToast(message);
  } finally {
    const fresh = $(`.rk-slot[data-rank="${rank}"] .rk-fetch`);
    if (fresh) {
      fresh.disabled = false;
      fresh.textContent = '🔎 정보';
    }
  }
}

/* ───────────────────────── AI 랭킹 대본 ───────────────────────── */

function paintAiNote(text, tone = '') {
  const el = $('#rkAiNote');
  if (!el) return;
  el.textContent = text;
  el.className = `rk-ai-note${tone ? ` is-${tone}` : ''}`;
}

function paintAiBadge(mode, model = '') {
  const el = $('#rkAiBadge');
  if (!el) return;
  if (!mode) {
    el.textContent = '—';
    el.className = 'rk-ai-badge';
    return;
  }
  const gemini = mode === 'gemini';
  el.textContent = gemini ? `GEMINI${model ? ` · ${model}` : ''}` : '로컬 템플릿';
  el.className = `rk-ai-badge ${gemini ? 'is-gemini' : 'is-template'}`;
}

async function generateRankingScript() {
  if (rk.ai.running) return;
  if (!rk.topic.trim() && !rk.slots.some((slot) => slot.url || slot.title || slot.caption)) {
    rkToast('영상 제목(주제)이나 항목을 하나 이상 넣어 주세요.');
    $('#rkTopic')?.focus();
    return;
  }
  const btn = $('#rkAiBtn');
  const overwrite = Boolean($('#rkOverwrite')?.checked);
  rk.ai.running = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '✨ 만드는 중…';
  }
  paintAiBadge('');
  paintAiNote('TOP 5 → TOP 1 코멘트를 쓰는 중입니다…', 'busy');
  try {
    const res = await fetch('/api/analyze-ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'script',
        topic: rk.topic,
        slots: rk.slots.map((slot) => ({ rank: slot.rank, url: slot.url, title: slot.title, caption: slot.caption })),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.message || `대본을 만들지 못했습니다 (HTTP ${res.status})`);
    const applied = applyRankingScript(rk.slots, data.ranking, { overwrite, topic: rk.topic });
    rk.slots = applied.slots;
    renderSlots();
    paintSummary();
    paintAiBadge(data.mode, data.gemini?.model || '');
    const bits = [`${applied.filled}칸 채움`];
    if (applied.kept) bits.push(`직접 쓴 ${applied.kept}칸은 그대로`);
    if (applied.missing?.length) bits.push(`비어 있는 순위: ${applied.missing.map((r) => `TOP ${r}`).join(', ')}`);
    const notice = Array.isArray(data.notices) && data.notices.length ? ` · ${data.notices[0]}` : '';
    paintAiNote(`${bits.join(' · ')}${notice}`, data.mode === 'gemini' ? 'ok' : 'warn');
    rkToast(data.mode === 'gemini' ? 'Gemini 가 랭킹 대본을 썼습니다.' : '로컬 템플릿으로 랭킹 대본을 채웠습니다.');
  } catch (err) {
    paintAiNote(String(err?.message || err).slice(0, 160), 'bad');
    rkToast('AI 대본 생성에 실패했습니다 — 코멘트를 직접 써도 미리보기·내보내기는 됩니다.');
  } finally {
    rk.ai.running = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✨ AI 랭킹 대본·코멘트 생성';
    }
  }
}

/* ───────────────────────── 준비 상태 ───────────────────────── */

function paintOrderList() {
  const wrap = $('#rkOrderList');
  if (!wrap) return;
  wrap.innerHTML = rk.slots
    .map((slot) => {
      const meta = rankMeta(slot.rank);
      const dur = slotDurationSec(slot);
      const mark = rk.clips.get(slot.rank) ? '🎞' : rk.images.get(slot.rank) ? '🖼' : '▦';
      const label = slot.title || slot.ytTitle || slot.caption || '비어 있음';
      return `<button type="button" class="rk-order-item${meta.gold ? ' is-gold' : ''}" data-rank="${slot.rank}">
        <b>${meta.label}</b><span>${escapeHtml(`${mark} ${label}`)}</span><em>${dur.toFixed(1)}s</em>
      </button>`;
    })
    .join('');
  $$('.rk-order-item', wrap).forEach((btn) =>
    btn.addEventListener('click', () => {
      const seg = rkPlayer.segments.find((item) => item.rank === Number(btn.dataset.rank));
      if (seg) seekRanking(seg.start, true);
    }),
  );
}

function paintSummary() {
  const check = validateSlots(rk.slots);
  paintOrderList();
  const el = $('#rkSummary');
  if (!el) return;
  const bits = [`${RANKS.length}칸 중 ${check.filled}칸 준비`];
  if (check.noClip.length) bits.push(`클립 없음 ${check.noClip.map((r) => `TOP ${r}`).join('·')}`);
  if (check.noCaption.length) bits.push(`코멘트 없음 ${check.noCaption.map((r) => `TOP ${r}`).join('·')}`);
  el.textContent = bits.join(' · ');
  const exportBtn = $('#rkExportBtn');
  if (exportBtn) exportBtn.disabled = !check.ok || rk.exporting;
}

/* ───────────────────────── 9:16 미리보기 ───────────────────────── */

function ensureCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!rkPlayer.ctx) {
    rkPlayer.ctx = new AC();
    rkPlayer.gain = rkPlayer.ctx.createGain();
    rkPlayer.gain.gain.value = 1;
    rkPlayer.gain.connect(rkPlayer.ctx.destination);
  }
  if (rkPlayer.ctx.state === 'suspended') rkPlayer.ctx.resume().catch(() => {});
  return rkPlayer.ctx;
}

function mountVideo(rank) {
  const clip = rk.clips.get(rank);
  const layer = $('#rkVideoLayer');
  if (!clip || !layer) return null;
  let video = rkPlayer.videos.get(rank);
  if (!video) {
    video = document.createElement('video');
    video.className = 'rk-video';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('aria-hidden', 'true');
    video.preload = 'auto';
    video.style.opacity = '0';
    layer.appendChild(video);
    rkPlayer.videos.set(rank, video);
  }
  if (video.dataset.clipId !== clip.id) {
    video.dataset.clipId = clip.id;
    video.src = clip.url;
    try {
      video.load();
    } catch {
      /* noop */
    }
  }
  return video;
}

function activateClip(rank, local = 0) {
  rkPlayer.videos.forEach((video, other) => {
    if (other === rank) return;
    try {
      video.pause();
    } catch {
      /* noop */
    }
    video.style.opacity = '0';
  });
  const clip = rk.clips.get(rank);
  const video = clip ? mountVideo(rank) : null;
  if (!video) return false;
  video.style.opacity = '1';
  const trim = effectiveTrim(slotOf(rank));
  const want = trim.start + Math.min(Math.max(0, local), trim.sec - 0.05);
  if (Math.abs((Number(video.currentTime) || 0) - want) > 0.3) {
    try {
      video.currentTime = want;
    } catch {
      /* 메타데이터 전이면 무시 */
    }
  }
  if (rkPlayer.playing) {
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  return true;
}

function narrationKey(rank) {
  return `${rk.voice}|${rankSpeechText(slotOf(rank))}`;
}

function narrationEntry(rank) {
  return rkPlayer.narration.get(narrationKey(rank)) || null;
}

async function fetchNarration(rank) {
  if (rk.voice === 'off') return { status: 'off' };
  const text = rankSpeechText(slotOf(rank));
  const key = narrationKey(rank);
  const cached = rkPlayer.narration.get(key);
  if (cached && cached.status !== 'loading') return cached;
  const ctx = ensureCtx();
  if (!ctx || !text) return { status: 'fail', error: 'no-text' };
  rkPlayer.narration.set(key, { status: 'loading' });
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: 'deep' }),
    });
    if (!res.ok) throw new Error(`음성 요청 실패 (HTTP ${res.status})`);
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength) throw new Error('빈 음성');
    const buffer = await ctx.decodeAudioData(bytes);
    const entry = { status: 'ok', buffer, duration: buffer.duration };
    rkPlayer.narration.set(key, entry);
    return entry;
  } catch (err) {
    const entry = { status: 'fail', error: String(err?.message || err) };
    rkPlayer.narration.set(key, entry);
    return entry;
  }
}

/** 슬롯 5개의 음성을 준비하고 { 5: 3.2, … } 길이를 돌려줍니다. */
async function prepareNarration({ onStep } = {}) {
  const durations = {};
  const failed = [];
  if (rk.voice === 'off') return { durations, failed, ready: 0, total: 0 };
  const targets = rk.slots.filter((slot) => rankSpeechText(slot));
  let done = 0;
  for (const slot of targets) {
    const entry = await fetchNarration(slot.rank);
    done += 1;
    if (onStep) onStep(done, targets.length);
    if (entry.status === 'ok') durations[slot.rank] = entry.duration;
    else failed.push(slot.rank);
  }
  return { durations, failed, ready: Object.keys(durations).length, total: targets.length };
}

function stopRankingNarration() {
  rkPlayer.sources.forEach((src) => {
    try {
      src.stop();
    } catch {
      /* 이미 끝났습니다 */
    }
  });
  rkPlayer.sources = [];
}

function playRankNarration(rank) {
  if (rk.voice === 'off') return false;
  const entry = narrationEntry(rank);
  if (!entry || entry.status !== 'ok') return false;
  const ctx = ensureCtx();
  if (!ctx) return false;
  stopRankingNarration();
  const src = ctx.createBufferSource();
  src.buffer = entry.buffer;
  src.connect(rkPlayer.gain);
  src.start();
  rkPlayer.sources.push(src);
  return true;
}

function captionHtml(text) {
  const lines = splitCaptionLines(text, { maxChars: 15, maxLines: 3 });
  if (!lines.length) return '';
  return lines
    .map((line) => {
      const inner = line.parts
        .map((part) => `${part.space ? ' ' : ''}${part.hl ? `<span class="rk-hl">${escapeHtml(part.text)}</span>` : escapeHtml(part.text)}`)
        .join('');
      return `<span class="rk-line">${inner}</span>`;
    })
    .join('');
}

function paintBackdrop(rank) {
  const meta = rankMeta(rank);
  const card = $('#rkCardLayer');
  const imageLayer = $('#rkImageLayer');
  const hasClip = Boolean(rk.clips.get(rank));
  const hasImage = Boolean(rk.images.get(rank));
  if (card) {
    card.style.background = `linear-gradient(160deg, ${meta.gradient[0]} 0%, ${meta.gradient[1]} 100%)`;
    card.style.opacity = hasClip || hasImage ? '0' : '1';
  }
  if (imageLayer) {
    const image = rk.images.get(rank);
    imageLayer.style.backgroundImage = image ? `url("${image.url}")` : '';
    imageLayer.style.opacity = image && !hasClip ? '1' : '0';
  }
  // 클립·이미지가 있으면 큰 순위 숫자는 영상 위에 겹치지 않게 숨깁니다(그라데이션 카드에서만).
  const bigRank = $('#rkBigRank');
  if (bigRank) bigRank.style.opacity = hasClip || hasImage ? '0' : '1';
}

function enterSegment(seg) {
  const slot = slotOf(seg.rank);
  const meta = rankMeta(seg.rank);
  const badge = $('#rkBadge');
  if (badge) {
    badge.textContent = meta.label;
    badge.classList.toggle('is-gold', meta.gold);
  }
  const title = slot.title || slot.ytTitle || `${rk.topic || 'TOP 5'} ${meta.ordinal}`;
  if ($('#rkTitle')) $('#rkTitle').textContent = title;
  if ($('#rkBigRank')) $('#rkBigRank').textContent = String(seg.rank);
  if ($('#rkCaption')) {
    $('#rkCaption').innerHTML = captionHtml(slot.caption || title);
    $('#rkCaption').classList.remove('is-pop');
    void $('#rkCaption').offsetWidth;
    $('#rkCaption').classList.add('is-pop');
  }
  paintBackdrop(seg.rank);
  activateClip(seg.rank, 0);
  if (rkPlayer.playing) playRankNarration(seg.rank);
}

function buildSegmentBars() {
  const wrap = $('#rkSegments');
  if (!wrap) return;
  wrap.innerHTML = rkPlayer.segments
    .map(
      (seg) =>
        `<button type="button" class="rk-seg${seg.gold ? ' is-gold' : ''}" data-rank="${seg.rank}" aria-label="${seg.label}로 이동"><span></span></button>`,
    )
    .join('');
  $$('.rk-seg', wrap).forEach((btn) => {
    btn.addEventListener('click', () => {
      const seg = rkPlayer.segments.find((s) => s.rank === Number(btn.dataset.rank));
      if (!seg) return;
      seekRanking(seg.start, true);
    });
  });
}

function paintSegments() {
  const seg = segmentAt(rkPlayer.segments, rkPlayer.t);
  $$('#rkSegments .rk-seg').forEach((btn) => {
    const s = rkPlayer.segments.find((item) => item.rank === Number(btn.dataset.rank));
    const fill = btn.firstElementChild;
    if (!s || !fill) return;
    const p = rkPlayer.t <= s.start ? 0 : rkPlayer.t >= s.end ? 1 : (rkPlayer.t - s.start) / (s.end - s.start);
    fill.style.width = `${(p * 100).toFixed(1)}%`;
  });
  if ($('#rkCounter')) {
    const position = seg ? rkPlayer.segments.findIndex((s) => s.rank === seg.rank) + 1 : 1;
    $('#rkCounter').textContent = `${position} / ${rkPlayer.segments.length}`;
  }
}

function updatePreview(force = false) {
  if (!rkPlayer.segments.length) return;
  const seg = segmentAt(rkPlayer.segments, rkPlayer.t);
  if (!seg) return;
  if (seg.index !== rkPlayer.idx || force) {
    rkPlayer.idx = seg.index;
    enterSegment(seg);
  }
  const video = rkPlayer.videos.get(seg.rank);
  if (video && rk.clips.get(seg.rank)) {
    // 클립은 구간 시작에서 한 번만 위치를 맞추고 그대로 재생합니다.
    // (재생 중 currentTime 을 계속 고치면 아이폰·크로미움 모두 프레임이 튀고, 녹화 중에는 렌더러가 불안정해집니다.)
    if (rkPlayer.playing && video.paused) {
      const trim = effectiveTrim(slotOf(seg.rank));
      if (video.currentTime >= trim.start + trim.sec - 0.06) {
        try {
          video.currentTime = trim.start;
        } catch {
          /* noop */
        }
      }
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }
  paintSegments();
}

function rankFrame(now) {
  if (!rkPlayer.playing) return;
  const dt = Math.min(0.12, (now - rkPlayer.last) / 1000);
  rkPlayer.last = now;
  rkPlayer.t += dt;
  if (rkPlayer.t >= rkPlayer.total) {
    rkPlayer.t = rkPlayer.total;
    updatePreview();
    pauseRanking();
    return;
  }
  updatePreview();
  rkPlayer.raf = requestAnimationFrame(rankFrame);
}

function playRanking() {
  if (!rkPlayer.segments.length) rebuildTimeline();
  if (rkPlayer.t >= rkPlayer.total - 0.05) rkPlayer.t = 0;
  rkPlayer.playing = true;
  rkPlayer.idx = -1;
  if ($('#rkPlayBig')) $('#rkPlayBig').classList.add('is-hidden');
  if ($('#rkPlayBtn')) $('#rkPlayBtn').textContent = '❚❚ 일시정지';
  ensureCtx();
  rkPlayer.last = performance.now();
  updatePreview(true);
  cancelAnimationFrame(rkPlayer.raf);
  rkPlayer.raf = requestAnimationFrame(rankFrame);
}

function pauseRanking() {
  rkPlayer.playing = false;
  cancelAnimationFrame(rkPlayer.raf);
  rkPlayer.videos.forEach((video) => {
    try {
      video.pause();
    } catch {
      /* noop */
    }
  });
  stopRankingNarration();
  if ($('#rkPlayBig')) $('#rkPlayBig').classList.remove('is-hidden');
  if ($('#rkPlayBtn')) $('#rkPlayBtn').textContent = '▶ 재생';
}

function seekRanking(t, autoplay = false) {
  rkPlayer.t = Math.max(0, Math.min(rkPlayer.total || 0, Number(t) || 0));
  rkPlayer.idx = -1;
  updatePreview(true);
  if (autoplay && !rkPlayer.playing) playRanking();
}

function rebuildTimeline(narrationDur = {}) {
  const layout = buildRankingTimeline(rk.slots, { narration: narrationDur });
  rkPlayer.segments = layout.segments;
  rkPlayer.total = layout.total;
  return layout;
}

async function openPreview() {
  const check = validateSlots(rk.slots);
  if (!check.ok) {
    rkToast('제목이나 코멘트를 하나 이상 채워 주세요.');
    return;
  }
  const section = $('#rkPlayerSection');
  if (section) section.hidden = false;
  rebuildTimeline();
  buildSegmentBars();
  rkPlayer.t = 0;
  rkPlayer.idx = -1;
  updatePreview(true);

  const note = $('#rkPlayerNote');
  if (note) note.textContent = rk.voice === 'off' ? '음성 없이 재생합니다.' : '내레이션 음성을 준비하는 중…';
  if (rk.voice !== 'off') {
    pauseRanking();
    const prep = await prepareNarration({
      onStep: (done, total) => {
        if (note) note.textContent = `내레이션 음성 준비 ${done}/${total}…`;
      },
    });
    const layout = rebuildTimeline(prep.durations);
    buildSegmentBars();
    if (note) {
      note.textContent = prep.failed.length
        ? `${prep.ready}/${prep.total} 음성 준비 · ${prep.failed.map((r) => `TOP ${r}`).join('·')}는 음성 없이 자막만 나옵니다.`
        : `${prep.ready}/${prep.total} 내레이션 준비 · 총 ${layout.total.toFixed(1)}초`;
    }
  } else if (note) {
    note.textContent = `음성 없이 재생합니다 · 총 ${rkPlayer.total.toFixed(1)}초`;
  }
  playRanking();
  section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ───────────────────────── 1080×1920 MP4 내보내기 ───────────────────────── */

function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function waitForVideo(video, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!video) return resolve(false);
    if (video.readyState >= 2) return resolve(true);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
      resolve(ok);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', onError);
    setTimeout(() => finish(video.readyState >= 2), timeoutMs);
  });
}

function drawCover(ctx, source, sw, sh, W, H, scale = 1) {
  const ratio = Math.max(W / sw, H / sh) * scale;
  const dw = sw * ratio;
  const dh = sh * ratio;
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawCaptionLines(ctx, text, W, H, W2) {
  const lines = splitCaptionLines(text, { maxChars: 14, maxLines: 3 });
  if (!lines.length) return;
  const fontSize = Math.round(W * 0.058);
  const lineHeight = Math.round(fontSize * 1.24);
  const baseY = H - Math.round(H * 0.115) - (lines.length - 1) * lineHeight;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `900 ${fontSize}px -apple-system, "Apple SD Gothic Neo", "Noto Sans CJK KR", "Malgun Gothic", sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = Math.round(fontSize * 0.45);
  ctx.shadowOffsetY = Math.round(fontSize * 0.08);
  lines.forEach((line, index) => {
    const widths = line.parts.map((part) => ctx.measureText(part.text).width);
    const total = widths.reduce((sum, w, i) => sum + w + (line.parts[i].space ? ctx.measureText(' ').width : 0), 0);
    let x = (W - total) / 2;
    const y = baseY + index * lineHeight;
    line.parts.forEach((part, i) => {
      if (part.space) x += ctx.measureText(' ').width;
      ctx.fillStyle = part.hl ? '#C4B5FD' : '#FFFFFF';
      ctx.fillText(part.text, x, y);
      x += widths[i];
    });
  });
  ctx.restore();
}

function drawFrame(ctx, t, W, H, images) {
  const seg = segmentAt(rkPlayer.segments, t);
  if (!seg) return;
  const meta = rankMeta(seg.rank);
  const slot = slotOf(seg.rank);
  const local = Math.max(0, t - seg.start);
  const progress = seg.dur ? Math.min(1, local / seg.dur) : 0;

  ctx.fillStyle = '#090D19';
  ctx.fillRect(0, 0, W, H);

  const video = rkPlayer.videos.get(seg.rank);
  let drew = false;
  if (video && video.readyState >= 2 && video.videoWidth) {
    drawCover(ctx, video, video.videoWidth, video.videoHeight, W, H);
    drew = true;
  }
  if (!drew) {
    const image = images.get(seg.rank);
    if (image && image.width) {
      drawCover(ctx, image, image.width, image.height, W, H, 1 + progress * 0.06);
    } else {
      const grad = ctx.createLinearGradient(0, 0, W * 0.4, H);
      grad.addColorStop(0, meta.gradient[0]);
      grad.addColorStop(1, meta.gradient[1]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // 큰 순위 숫자 워터마크
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.round(W * 0.62)}px -apple-system, "Noto Sans CJK KR", sans-serif`;
      ctx.fillText(String(seg.rank), W / 2, H * 0.52);
      ctx.restore();
    }
  }

  // 가독성 그라데이션
  const shade = ctx.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, 'rgba(3,6,15,0.72)');
  shade.addColorStop(0.3, 'rgba(3,6,15,0.04)');
  shade.addColorStop(0.62, 'rgba(3,6,15,0.08)');
  shade.addColorStop(1, 'rgba(3,6,15,0.9)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);

  // 상단 진행 세그먼트
  const pad = Math.round(W * 0.05);
  const gap = Math.round(W * 0.012);
  const barW = (W - pad * 2 - gap * (rkPlayer.segments.length - 1)) / rkPlayer.segments.length;
  const barY = Math.round(H * 0.028);
  rkPlayer.segments.forEach((item, i) => {
    const x = pad + i * (barW + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    roundRect(ctx, x, barY, barW, Math.max(4, Math.round(H * 0.004)), 3);
    ctx.fill();
    const p = t <= item.start ? 0 : t >= item.end ? 1 : (t - item.start) / (item.end - item.start);
    if (p > 0) {
      ctx.fillStyle = '#FFFFFF';
      roundRect(ctx, x, barY, Math.max(2, barW * p), Math.max(4, Math.round(H * 0.004)), 3);
      ctx.fill();
    }
  });

  // 순위 배지
  const badgeFont = Math.round(W * 0.05);
  ctx.font = `900 ${badgeFont}px -apple-system, "Noto Sans CJK KR", sans-serif`;
  const badgeText = meta.label;
  const textW = ctx.measureText(badgeText).width;
  const badgeH = Math.round(badgeFont * 1.75);
  const badgeX = pad;
  const badgeY = barY + Math.round(H * 0.022);
  const badgeW = textW + Math.round(badgeFont * 1.1);
  if (meta.gold) {
    const grad = ctx.createLinearGradient(badgeX, badgeY, badgeX + badgeW, badgeY + badgeH);
    grad.addColorStop(0, '#FFE07A');
    grad.addColorStop(1, '#E3A008');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = '#7C3AED';
  }
  roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
  ctx.fill();
  ctx.fillStyle = meta.badgeText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 1);

  // 순서 카운터 (오른쪽)
  const position = rkPlayer.segments.findIndex((s) => s.rank === seg.rank) + 1;
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = `800 ${Math.round(W * 0.036)}px -apple-system, "Noto Sans CJK KR", sans-serif`;
  ctx.fillText(`${position} / ${rkPlayer.segments.length}`, W - pad, badgeY + badgeH / 2);

  // 제목
  const title = slot.title || slot.ytTitle || `${rk.topic || 'TOP 5'} ${meta.ordinal}`;
  const titleSize = Math.round(W * 0.046);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 ${titleSize}px -apple-system, "Apple SD Gothic Neo", "Noto Sans CJK KR", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = Math.round(titleSize * 0.35);
  const maxTitle = Math.floor((W - pad * 2) / (titleSize * 0.55));
  const titleLines = [];
  let current = '';
  [...String(title)].forEach((ch) => {
    if ([...current].length >= maxTitle) {
      titleLines.push(current);
      current = '';
    }
    current += ch;
  });
  if (current) titleLines.push(current);
  const titleY = badgeY + badgeH + Math.round(titleSize * 1.5);
  titleLines.slice(0, 2).forEach((line, i) => {
    const text = i === 1 && titleLines.length > 2 ? `${[...line].slice(0, -1).join('')}…` : line;
    ctx.fillText(text, pad, titleY + i * Math.round(titleSize * 1.25));
  });
  ctx.shadowBlur = 0;

  // 하단 굵은 자막
  drawCaptionLines(ctx, slot.caption || title, W, H, W);
}

async function exportRanking() {
  if (rk.exporting) return;
  const check = validateSlots(rk.slots);
  if (!check.ok) {
    rkToast('제목이나 코멘트를 하나 이상 채워 주세요.');
    return;
  }
  if (typeof window.MediaRecorder === 'undefined') {
    rkToast('이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않습니다. 사파리/크롬 최신 버전에서 시도해 주세요.');
    return;
  }

  const isIOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const W = isIOS ? 720 : 1080;
  const H = Math.round((W * 16) / 9);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    rkToast('캔버스를 만들지 못했습니다.');
    return;
  }

  const btn = $('#rkExportBtn');
  rk.exporting = true;
  if (btn) btn.disabled = true;
  if ($('#rkPlayerSection')) $('#rkPlayerSection').hidden = false;
  pauseRanking();
  const status = (text, ratio = 0) => {
    const note = $('#rkExportStatus');
    if (note) note.textContent = text;
    const fill = $('#rkExportFill');
    if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  };
  status('내레이션 음성 준비 중…', 0);

  try {
    /* ① 음성 — 슬롯 길이를 음성에 맞춰 늘립니다(말이 잘리지 않게). */
    const prep = await prepareNarration({
      onStep: (done, total) => status(`내레이션 음성 준비 ${done}/${total}…`, (done / Math.max(1, total)) * 0.15),
    });
    const layout = rebuildTimeline(prep.durations);
    buildSegmentBars();
    const withAudio = Object.keys(prep.durations).length;

    /* ② 클립·이미지 준비 — 녹화 중에는 재생 프레임을 그대로 그립니다. */
    status('클립 준비 중…', 0.18);
    for (const [rank] of rk.clips) {
      const video = mountVideo(rank);
      await waitForVideo(video);
    }
    const images = new Map();
    for (const [rank, entry] of rk.images) {
      const image = await loadImage(entry.url);
      if (image) images.set(rank, image);
    }

    /* ③ 캔버스 + 내레이션을 한 스트림으로 */
    const stream = canvas.captureStream(30);
    const audioCtx = withAudio ? ensureCtx() : null;
    let audioDest = null;
    let audioStartAt = 0;
    const audioSources = [];
    if (audioCtx) {
      audioDest = audioCtx.createMediaStreamDestination();
      const track = audioDest.stream.getAudioTracks()[0];
      if (track) stream.addTrack(track);
      audioStartAt = audioCtx.currentTime + 0.2;
    }

    let mime = '';
    for (const candidate of recorderMimeCandidates(withAudio > 0)) {
      try {
        if (MediaRecorder.isTypeSupported(candidate)) {
          mime = candidate;
          break;
        }
      } catch {
        /* 무시 */
      }
    }
    if (!mime) throw new Error('이 브라우저에서 쓸 수 있는 녹화 포맷이 없습니다.');

    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 6_000_000,
      ...(audioDest ? { audioBitsPerSecond: 128_000 } : {}),
    });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });

    // 미리 듣는 소리가 녹음과 겹치지 않게 재생 게인을 잠시 0으로.
    const previousGain = rkPlayer.gain ? rkPlayer.gain.gain.value : 1;
    if (rkPlayer.gain) rkPlayer.gain.gain.value = 0;
    if (audioDest) {
      layout.segments.forEach((seg) => {
        const entry = narrationEntry(seg.rank);
        if (!entry || entry.status !== 'ok') return;
        const src = audioCtx.createBufferSource();
        src.buffer = entry.buffer;
        src.playbackRate.value = Math.min(2, Math.max(1, entry.buffer.duration / Math.max(0.6, seg.dur)));
        src.connect(audioDest);
        src.start(audioStartAt + seg.start);
        audioSources.push(src);
      });
    }

    // 첫 프레임을 먼저 그려 검은 화면이 잡히지 않게.
    syncExportVideos(0);
    drawFrame(ctx, 0, W, H, images);
    recorder.start(250);
    status(`렌더링 시작 · ${layout.total.toFixed(1)}초`, 0.2);

    const started = performance.now();
    const clockNow = () =>
      audioDest ? Math.max(0, audioCtx.currentTime - audioStartAt) : (performance.now() - started) / 1000;

    await new Promise((resolve) => {
      const step = () => {
        const t = Math.min(layout.total, clockNow());
        syncExportVideos(t);
        drawFrame(ctx, t, W, H, images);
        status(
          `영상 렌더링 ${Math.round((t / layout.total) * 100)}% · ${t.toFixed(1)}/${layout.total.toFixed(1)}초${
            withAudio ? ` · 음성 ${withAudio}/${layout.segments.length}` : ' · 음성 없음'
          }`,
          0.2 + (t / layout.total) * 0.78,
        );
        if (t >= layout.total) {
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
    rkPlayer.videos.forEach((video) => {
      try {
        video.pause();
      } catch {
        /* noop */
      }
    });
    stream.getAudioTracks().forEach((track) => track.stop());
    recorder.stop();
    await stopped;
    if (rkPlayer.gain) rkPlayer.gain.gain.value = previousGain;

    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (!blob.size) throw new Error('빈 파일이 만들어졌습니다. 다시 시도해 주세요.');
    const head = new Uint8Array(await blob.slice(0, 524288).arrayBuffer());
    const kind = sniffVideoBytes(head);
    if (kind.audio === 'none') {
      if (/mp4a/.test(mime)) kind.audio = 'aac';
      else if (/opus/.test(mime)) kind.audio = 'opus';
    }
    const name = rankingExportName(rk.topic, W, H, kind.ext);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const codecNote =
      kind.container === 'mp4'
        ? kind.codec === 'h264'
          ? 'H.264 MP4'
          : `MP4(${kind.codec === 'vp9' ? 'VP9' : kind.codec})`
        : kind.codec === 'vp9' || kind.codec === 'vp8'
          ? `${kind.codec.toUpperCase()} WebM`
          : kind.container.toUpperCase();
    const audioNote = kind.audio !== 'none' ? ' · 내레이션 포함' : ' · 음성 트랙 없음';
    const iphoneNote = kind.container === 'mp4' && kind.codec !== 'h264' ? ' · 아이폰 사진 앱에서는 안 열릴 수 있습니다' : '';
    status(`${name} · ${(blob.size / 1024 / 1024).toFixed(1)}MB · ${codecNote}${audioNote} · ${W}×${H}${iphoneNote}`, 1);
    rkToast(`영상 파일(${codecNote}, ${W}×${H})을 내려받았습니다.`);
  } catch (err) {
    status(`영상 렌더 실패: ${String(err?.message || err).slice(0, 120)}`, 0);
    rkToast(`영상 렌더 실패: ${String(err?.message || err).slice(0, 100)}`);
  } finally {
    rk.exporting = false;
    if (btn) btn.disabled = false;
    paintSummary();
  }
}

/** 내보내기 프레임과 클립 재생 위치를 맞춥니다(그린 프레임 = 실제 클립 프레임).
 *   구간에 들어갈 때 한 번만 위치를 잡고, 재생 중에는 큰 드리프트(>1.5초)만 보정합니다 —
 *   녹화 중 잦은 seek 는 프레임을 튀게 하고 렌더러를 불안정하게 만듭니다.
 */
function syncExportVideos(t) {
  const seg = segmentAt(rkPlayer.segments, t);
  if (!seg) return;
  rkPlayer.videos.forEach((video, rank) => {
    if (rank !== seg.rank) {
      try {
        video.pause();
      } catch {
        /* noop */
      }
      return;
    }
    const trim = effectiveTrim(slotOf(rank));
    const want = Math.min(trim.start + trim.sec - 0.06, trim.start + Math.max(0, t - seg.start));
    const cur = Number(video.currentTime) || 0;
    if (video.paused) {
      if (video.ended || Math.abs(cur - want) > 0.4) {
        try {
          video.currentTime = Math.max(trim.start, want);
        } catch {
          /* noop */
        }
      }
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return;
    }
    if (Math.abs(cur - want) > 1.5) {
      try {
        video.currentTime = Math.max(trim.start, want);
      } catch {
        /* noop */
      }
    }
  });
}

/* ───────────────────────── 초기화 ───────────────────────── */

export function initRanking() {
  if (rk.ready) return;
  rk.ready = true;

  $$('#modeSwitch [data-mode]').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

  renderSlots();
  paintSummary();
  paintAiBadge('');
  paintAiNote('Gemini 가 자막 발췌를 보고 순위별 코멘트를 씁니다. 실패하면 로컬 템플릿으로 대체합니다.');

  $('#rkTopic')?.addEventListener('input', (event) => {
    rk.topic = event.target.value;
  });

  $('#rkAiBtn')?.addEventListener('click', generateRankingScript);
  $('#rkPreviewBtn')?.addEventListener('click', openPreview);
  $('#rkExportBtn')?.addEventListener('click', exportRanking);
  $('#rkClosePlayer')?.addEventListener('click', () => {
    pauseRanking();
    if ($('#rkPlayerSection')) $('#rkPlayerSection').hidden = true;
  });
  $('#rkPlayBtn')?.addEventListener('click', () => (rkPlayer.playing ? pauseRanking() : playRanking()));
  $('#rkPlayBig')?.addEventListener('click', () => playRanking());
  $('#rkRestartBtn')?.addEventListener('click', () => {
    seekRanking(0, true);
  });
  $$('#rkVoice [data-rkvoice]').forEach((btn) =>
    btn.addEventListener('click', () => {
      rk.voice = btn.dataset.rkvoice === 'off' ? 'off' : 'deep';
      $$('#rkVoice [data-rkvoice]').forEach((other) => {
        const on = other.dataset.rkvoice === rk.voice;
        other.classList.toggle('is-on', on);
        other.setAttribute('aria-pressed', String(on));
      });
      const note = $('#rkPlayerNote');
      if (note) note.textContent = rk.voice === 'off' ? '음성 없이 재생합니다.' : '내레이션 음성 — 재생할 때 준비합니다.';
      if (rk.voice === 'off') stopRankingNarration();
    }),
  );

  if (new URLSearchParams(window.location.search).get('mode') === 'ranking') setMode('ranking');
}

initRanking();

/**
 * app.js — 쇼츠 클론 스튜디오 화면
 * 입력 → /api/analyze-and-generate → 9:16 플레이어 · 컷 편집 · 내보내기
 */
import {
  TONES,
  STRATEGY_INFO,
  LENGTHS,
  PRESETS,
  ensureEmphasis,
  stripMarkup,
  emphasisWords,
  buildSrt,
  parseYouTubeUrl,
} from './lib/engine.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const TOPIC_HINTS = ['검단신도시 2028년 교통 호재', '우리 동네 숨은 국밥집', '30대 직장인 앱테크 루틴'];

const state = {
  tone: 'auto',
  length: 36,
  pkg: null,
  blueprint: null,
  analysis: null,
  busy: false,
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
  voice: null,
  speaking: false,
};

/* ─────────────────────────── 초기 화면 ─────────────────────────── */

function renderPresets() {
  const row = $('#presetRow');
  row.innerHTML = '';
  const unique = [];
  for (const p of PRESETS) if (!unique.some((u) => u.topic === p.topic)) unique.push(p);
  for (const p of unique) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.textContent = `↯ ${p.label}`;
    btn.addEventListener('click', () => {
      $('#urlInput').value = p.url;
      $('#topicInput').value = p.topic;
      $('#topicInput').focus();
    });
    row.appendChild(btn);
  }
}

function renderTopicHints() {
  const box = $('#topicHints');
  box.innerHTML = '';
  for (const t of TOPIC_HINTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topic-hint';
    btn.textContent = t;
    btn.addEventListener('click', () => {
      $('#topicInput').value = t;
      if (!$('#urlInput').value) $('#urlInput').value = PRESETS[0].url;
    });
    box.appendChild(btn);
  }
}

function renderSegmented(container, items, current, onPick) {
  container.innerHTML = '';
  for (const item of items) {
    const id = item.id ?? item.sec;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.role = 'radio';
    btn.textContent = item.label;
    btn.title = item.hint || '';
    btn.setAttribute('aria-checked', String(id === current));
    btn.addEventListener('click', () => {
      [...container.children].forEach((c) => c.setAttribute('aria-checked', 'false'));
      btn.setAttribute('aria-checked', 'true');
      onPick(id);
    });
    container.appendChild(btn);
  }
}

function renderForm() {
  renderPresets();
  renderTopicHints();
  renderSegmented($('#toneRow'), TONES, state.tone, (id) => {
    state.tone = id;
    if (state.pkg) regenerate();
  });
  renderSegmented($('#lengthRow'), LENGTHS, state.length, (id) => {
    state.length = Number(id);
    if (state.pkg) regenerate();
  });
}

/* ─────────────────────────── 생성 ─────────────────────────── */

function setStatus(text, kind = '') {
  const el = $('#formStatus');
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function generate() {
  if (state.busy) return;
  const url = $('#urlInput').value.trim();
  const topic = $('#topicInput').value.trim();
  const parsed = parseYouTubeUrl(url);
  if (!parsed.ok) {
    setStatus('유튜브 쇼츠 주소를 확인해 주세요. 예: https://www.youtube.com/shorts/영상ID', 'error');
    $('#urlInput').focus();
    return;
  }
  if (!topic) {
    setStatus('만들 주제를 한 줄로 적어 주세요.', 'error');
    $('#topicInput').focus();
    return;
  }

  const btn = $('#generateBtn');
  state.busy = true;
  btn.disabled = true;
  $('.btn-label').textContent = '레퍼런스 읽고 대본 쓰는 중…';
  setStatus('레퍼런스 메타데이터를 가져와 분석하는 중입니다.', 'working');

  try {
    const res = await fetch('/api/analyze-and-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: parsed.canonical,
        topic,
        tone: state.tone,
        length: state.length,
        facts: $('#factsInput').value.trim(),
        referenceText: $('#refTextInput').value.trim(),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.message) || `요청이 실패했습니다 (HTTP ${res.status})`);
    }
    state.pkg = data.package;
    state.blueprint = data.analysis?.blueprint || data.package.reference;
    state.analysis = data.analysis;
    enterStudio();
    setStatus('');
  } catch (err) {
    setStatus(String(err.message || err), 'error');
  } finally {
    state.busy = false;
    btn.disabled = false;
    $('.btn-label').textContent = '쇼츠 만들기';
  }
}

async function regenerate() {
  if (state.busy || !state.pkg) return;
  const topic = state.pkg.meta.topic;
  state.busy = true;
  setStatus('말투·길이를 바꿔 다시 쓰는 중입니다.', 'working');
  try {
    const res = await fetch('/api/analyze-and-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: state.blueprint?.source?.url || $('#urlInput').value.trim(),
        topic,
        tone: state.tone,
        length: state.length,
        facts: $('#factsInput').value.trim(),
        reference: state.blueprint,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw new Error((data && data.message) || '다시 만들기에 실패했습니다');
    state.pkg = data.package;
    state.blueprint = data.analysis?.blueprint || state.blueprint;
    renderStudio();
    setStatus('');
  } catch (err) {
    setStatus(String(err.message || err), 'error');
  } finally {
    state.busy = false;
  }
}

/* ─────────────────────────── 스튜디오 ─────────────────────────── */

function enterStudio() {
  $('#viewHome').classList.add('hidden');
  $('#viewStudio').classList.remove('hidden');
  $('#newBtn').classList.remove('hidden');
  renderStudio();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function leaveStudio() {
  pause();
  state.pkg = null;
  state.blueprint = null;
  $('#viewStudio').classList.add('hidden');
  $('#viewHome').classList.remove('hidden');
  $('#newBtn').classList.add('hidden');
  window.scrollTo({ top: 0 });
}

function renderStudio() {
  const pkg = state.pkg;
  if (!pkg) return;
  $('#studioTopic').textContent = pkg.meta.topic;
  $('#studioEyebrow').textContent = `${pkg.meta.strategyLabel} · ${pkg.cuts.length}컷 · 약 ${Math.round(pkg.meta.totalSec)}초`;

  const cutAccent = STRATEGY_INFO[pkg.meta.strategy]?.accent || '#FFE14D';
  document.documentElement.style.setProperty('--cut-accent', cutAccent);

  renderBlueprint();
  renderTitles();
  renderCuts();
  renderPrompts();
  buildPlayer();
  player.rate = pkg.tts.rate;
  $('#speedRange').value = String(pkg.tts.rate);
  $('#speedVal').textContent = `${pkg.tts.rate.toFixed(2)}x`;
}

function renderBlueprint() {
  const bp = state.blueprint;
  if (!bp) return;
  $('#bpTitle').textContent = bp.source?.title || '(제목을 못 가져왔습니다)';
  const srcMap = { page: '영상 페이지', oembed: 'oEmbed', 'data-api': 'YouTube API', none: '메타데이터 없음', 'client-cache': '캐시' };
  const badge = $('#bpSource');
  badge.textContent = srcMap[bp.source?.fetchedBy] || bp.source?.fetchedBy || '—';
  badge.className = `badge ${bp.source?.fetchedBy === 'none' ? '' : 'live'}`;

  const items = [
    ['길이', bp.source?.durationKnown ? `${bp.source.durationSec}초` : '추정'],
    ['훅 유형', bp.hook?.label || '—'],
    ['컷 구성', `${bp.cuts?.count || 7}컷 · 컷당 ${bp.cuts?.avgSec || 5}초`],
    ['템포', `${bp.pacing?.tempo || 1.21}x · 무음 없음`],
    [
      '문장 리듬',
      bp.rhythm?.measured
        ? `분당 ${bp.rhythm.wpm}어절 · ${bp.rhythm.avgSentenceChars}자${bp.source?.transcriptSource === 'auto' ? ' (자동 자막)' : ''}`
        : '표준값 사용',
    ],
    ['자막', bp.subtitle?.style || '2줄 굵게'],
    ['비주얼', bp.visual?.mood || '—'],
    ['채널', bp.source?.channel || '—'],
  ];
  $('#bpGrid').innerHTML = items
    .map(([k, v]) => `<div class="bp-item"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join('');
  $('#bpEvidence').innerHTML = (bp.evidence || []).map((e) => `<li>${esc(e)}</li>`).join('');
}

function renderTitles() {
  const list = $('#titleList');
  list.innerHTML = '';
  for (const t of state.pkg.titles || []) {
    const li = document.createElement('li');
    li.innerHTML = `<div><div class="t">${esc(t.text)}</div><div class="w">${esc(t.why)}</div></div><span class="copy">복사</span>`;
    li.addEventListener('click', () => copy(t.text, '제목을 복사했습니다'));
    list.appendChild(li);
  }
}

/* ───────────── 컷 목록 ───────────── */

function renderCuts() {
  const pkg = state.pkg;
  const wrap = $('#cutsList');
  wrap.innerHTML = '';
  $('#cutCount').textContent = `${pkg.cuts.length}컷 · 약 ${Math.round(pkg.meta.totalSec)}초`;

  pkg.cuts.forEach((cut, i) => {
    const card = document.createElement('article');
    card.className = 'cut';
    card.dataset.index = String(i);

    const top = document.createElement('div');
    top.className = 'cut-top';
    top.innerHTML = `
      <span class="cut-idx">${i + 1}</span>
      <span class="cut-label">${esc(cut.label)}</span>
      <span class="cut-time">
        <input type="number" step="0.1" min="0" value="${cut.start.toFixed(1)}" aria-label="${i + 1}번 컷 시작(초)" data-time="start" />
        <span>~</span>
        <input type="number" step="0.1" min="0" value="${cut.end.toFixed(1)}" aria-label="${i + 1}번 컷 끝(초)" data-time="end" />
        <span>s</span>
      </span>
      <button class="cut-seek" type="button">▶</button>
    `;
    top.querySelector('.cut-seek').addEventListener('click', () => {
      seekToCut(i, true);
    });
    top.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => applyTimeEdit(i, inp.dataset.time, Number(inp.value)));
    });

    const sub = document.createElement('textarea');
    sub.className = 'cut-sub-input';
    sub.rows = 2;
    sub.value = cut.subtitle;
    sub.setAttribute('aria-label', `${i + 1}번 컷 자막(강조는 [ ])`);
    sub.addEventListener('input', () => {
      cut.subtitle = sub.value;
      cut.narration = stripMarkup(sub.value);
      const hl = emphasisWords(sub.value);
      if (hl.length) cut.bigWord = hl[0];
      if (player.idx === i) paintSubtitle(cut, false);
      paintPromptAndScript();
    });

    const meta = document.createElement('div');
    meta.className = 'cut-meta';
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`${pkg.meta.topic} ${cut.factHint || ''}`)}`;
    meta.innerHTML = `
      <span class="chip">🎥 ${esc(cut.camera)}</span>
      <span class="chip">🎨 ${esc(cut.mood?.name || '')}</span>
      ${cut.factHint ? `<span class="chip fact">🔎 ${esc(cut.factHint)} · <a href="${searchUrl}" target="_blank" rel="noopener">검색</a></span>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'cut-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ctrl-btn';
    copyBtn.textContent = '연출 프롬프트 복사';
    copyBtn.addEventListener('click', () => copy(cut.visualPrompt, `${i + 1}번 컷 프롬프트를 복사했습니다`));
    actions.appendChild(copyBtn);

    card.append(top, sub, meta, actions);
    wrap.appendChild(card);
  });
}

function paintPromptAndScript() {
  // 편집 즉시 프롬프트 탭·내보내기 문구에 반영되도록 필요한 부분만 다시 그립니다.
  renderPrompts();
}

function applyTimeEdit(index, which, value) {
  const cuts = state.pkg.cuts;
  const cut = cuts[index];
  const v = Math.max(0, Number(value) || 0);
  if (which === 'start') {
    cut.start = Math.min(v, cut.end - 0.3);
  } else {
    cut.end = Math.max(v, cut.start + 0.3);
  }
  cut.duration = Number((cut.end - cut.start).toFixed(2));
  // 뒤 컷들을 이어 붙입니다 (빈 구간·겹침 방지)
  for (let i = index + 1; i < cuts.length; i += 1) {
    cuts[i].start = Number(cuts[i - 1].end.toFixed(2));
    cuts[i].end = Number((cuts[i].start + cuts[i].duration).toFixed(2));
  }
  state.pkg.meta.totalSec = Number(cuts[cuts.length - 1].end.toFixed(2));
  renderCuts();
  buildPlayer();
}

/* ───────────── 9:16 플레이어 ───────────── */

const CAM_MOVES = [
  { s0: 1.02, s1: 1.1, x: 0, y: -1.2 },
  { s0: 1.1, s1: 1.02, x: 0, y: 1.2 },
  { s0: 1.04, s1: 1.12, x: -1.6, y: 0 },
  { s0: 1.12, s1: 1.04, x: 1.6, y: 0 },
];

function buildPlayer() {
  const pkg = state.pkg;
  const stack = $('#sceneStack');
  const segs = $('#segments');
  stack.innerHTML = '';
  segs.innerHTML = '';
  player.total = pkg.cuts[pkg.cuts.length - 1].end;
  player.idx = -1;
  player.t = Math.min(player.t, player.total);

  pkg.cuts.forEach((cut, i) => {
    const scene = document.createElement('div');
    scene.className = 'scene';
    scene.dataset.index = String(i);
    const grad = `linear-gradient(155deg, ${cut.mood.from} 0%, ${cut.mood.to} 100%)`;
    scene.style.backgroundImage = cut.imageUrl ? `linear-gradient(rgba(0,0,0,.25), rgba(0,0,0,.45)), url("${cut.imageUrl}")` : grad;
    stack.appendChild(scene);

    const seg = document.createElement('button');
    seg.type = 'button';
    seg.setAttribute('aria-label', `${i + 1}번 컷으로 이동`);
    seg.innerHTML = '<span class="fill"></span>';
    seg.addEventListener('click', () => seekToCut(i, true));
    segs.appendChild(seg);
  });

  $('#cutCounter').textContent = `1 / ${pkg.cuts.length}`;
  $('#timeCounter').textContent = '0.0s';
  updateFrame(true);
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
  const cut = pkg.cuts[idx];
  const local = Math.min(1, Math.max(0, (player.t - cut.start) / Math.max(0.001, cut.end - cut.start)));
  const move = CAM_MOVES[idx % CAM_MOVES.length];
  const scene = $('#sceneStack').children[idx];
  if (scene) {
    const scale = move.s0 + (move.s1 - move.s0) * local;
    scene.style.transform = `translate3d(${move.x * local}%, ${move.y * local}%, 0) scale(${scale})`;
  }
  // 진행 바
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
  paintSubtitle(cut, true);

  [...$('#sceneStack').children].forEach((s, i) => s.classList.toggle('active', i === idx));
  $$('#cutsList .cut').forEach((c, i) => c.classList.toggle('playing', i === idx));

  if (player.playing && !player.mute) speak(cut);
}

function paintSubtitle(cut, animate) {
  const el = $('#subtitle');
  const text = cut.subtitle || '';
  const lines = wrapLines(text, 17).slice(0, 3);
  el.innerHTML = lines
    .map((line) => {
      const parts = [];
      const re = /\[([^\]]+)\]|([^\s\[]+)/g;
      let m;
      while ((m = re.exec(line)) !== null) parts.push({ text: m[1] || m[2], hl: Boolean(m[1]) });
      let html = '';
      parts.forEach((part, i) => {
        const delay = animate ? ` style="animation-delay:${i * 32}ms"` : '';
        const glue = i > 0 && !/^[,.·!?~)\]…]/.test(part.text) ? ' ' : '';
        html += `${glue}<span class="chunk${part.hl ? ' hl' : ''}"${delay}>${esc(part.text)}</span>`;
      });
      return `<span class="line">${html}</span>`;
    })
    .join('');
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
    player.speaking = true;
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
  $('#voiceNote').textContent = `음성: ${player.voice.name} · 1.0~1.4배속 조절 가능. 아이폰은 무음 모드를 해제해야 소리가 납니다.`;
}

function play() {
  if (!state.pkg || player.playing) return;
  if (player.t >= player.total - 0.05) player.t = 0;
  player.playing = true;
  $('#phone').classList.add('playing');
  $('#playBtn').textContent = '❚❚ 일시정지';
  player.last = performance.now();
  updateFrame(true); // 첫 컷 음성은 사용자 제스처 안에서 시작
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
  $('#phone')?.classList.remove('playing');
  const btn = $('#playBtn');
  if (btn) btn.textContent = '▶ 재생';
  try {
    window.speechSynthesis && window.speechSynthesis.cancel();
  } catch {
    /* noop */
  }
}

function seekToCut(i, autoplay = false) {
  const cut = state.pkg.cuts[i];
  player.t = cut.start;
  player.idx = -1;
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

/* ───────────── 프롬프트 탭 ───────────── */

function renderPrompts() {
  const wrap = $('#promptList');
  wrap.innerHTML = '';
  state.pkg.cuts.forEach((cut, i) => {
    const card = document.createElement('article');
    card.className = 'prompt-card';
    card.innerHTML = `
      <div class="prompt-head"><span class="cut-idx">${i + 1}</span> ${esc(cut.label)} · ${cut.start.toFixed(1)}s–${cut.end.toFixed(1)}s</div>
      <div class="prompt-ko">${esc(cut.visualKo)}</div>
      <div class="prompt-en">${esc(cut.visualPrompt)}</div>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctrl-btn';
    btn.textContent = '프롬프트 복사';
    btn.addEventListener('click', () => copy(cut.visualPrompt, `${i + 1}번 컷 프롬프트를 복사했습니다`));
    card.appendChild(btn);
    wrap.appendChild(card);
  });
}

/* ───────────── 내보내기 ───────────── */

function scriptText() {
  const pkg = state.pkg;
  const head = [
    `# ${pkg.titles?.[0]?.text || pkg.meta.topic}`,
    `레퍼런스: ${state.blueprint?.source?.title || ''} · ${state.blueprint?.source?.url || ''}`,
    `총 ${Math.round(pkg.meta.totalSec)}초 · ${pkg.cuts.length}컷 · 템포 ${pkg.tts.rate}x · ${pkg.meta.strategyLabel}`,
    `해시태그: ${(pkg.hashtags || []).map((h) => `#${h}`).join(' ')}`,
    '',
  ];
  const body = pkg.cuts.map(
    (c) =>
      `[${c.index + 1}] ${c.start.toFixed(1)}s–${c.end.toFixed(1)}s · ${c.label}\n자막: ${c.subtitle}\n연출: ${c.visualKo}\n카메라: ${c.camera}\n`,
  );
  return [...head, ...body].join('\n');
}

function promptsText() {
  return state.pkg.cuts
    .map((c) => `#${c.index + 1} ${c.label} (${c.start.toFixed(1)}s–${c.end.toFixed(1)}s)\n${c.visualKo}\nEN: ${c.visualPrompt}`)
    .join('\n\n');
}

function ttsText() {
  return state.pkg.cuts.map((c) => `[${c.start.toFixed(1)}s] ${stripMarkup(c.subtitle)}`).join('\n');
}

function storyboardHtml() {
  const pkg = state.pkg;
  const cards = pkg.cuts
    .map(
      (c) => `
    <section style="border:1px solid #262632;border-radius:16px;overflow:hidden;margin:0 0 14px;background:#101017">
      <div style="height:8px;background:linear-gradient(90deg,${c.mood.from},${c.mood.to})"></div>
      <div style="padding:14px 16px 18px">
        <div style="font-size:12px;color:#8b93a3;font-weight:700">${c.index + 1} / ${pkg.cuts.length} · ${esc(c.label)} · ${c.start.toFixed(1)}s–${c.end.toFixed(1)}s</div>
        <h2 style="font-size:20px;margin:8px 0 6px;color:#fff;letter-spacing:-.02em">${esc(stripMarkup(c.subtitle))}</h2>
        <p style="margin:0 0 10px;color:#c3cad6;font-size:13px">${esc(c.visualKo)} · ${esc(c.camera)}</p>
        <pre style="white-space:pre-wrap;font-size:11.5px;line-height:1.6;color:#9fb0c9;background:#0a0a10;border:1px solid #22222e;border-radius:10px;padding:10px;margin:0">${esc(c.visualPrompt)}</pre>
      </div>
    </section>`,
    )
    .join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(pkg.meta.topic)} — 쇼츠 스토리보드</title></head>
  <body style="margin:0;background:#08080c;color:#eef1f6;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;padding:20px 16px 60px">
    <div style="max-width:720px;margin:0 auto">
      <p style="font-size:11px;letter-spacing:.16em;color:#6f7583;font-weight:800;margin:0 0 6px">SHORTS STORYBOARD</p>
      <h1 style="font-size:24px;margin:0 0 4px">${esc(pkg.meta.topic)}</h1>
      <p style="color:#9aa0ad;font-size:13px;margin:0 0 18px">${pkg.cuts.length}컷 · 약 ${Math.round(pkg.meta.totalSec)}초 · 템포 ${pkg.tts.rate}x · ${esc(pkg.meta.strategyLabel)}</p>
      ${cards}
      <p style="color:#6f7583;font-size:11.5px;margin-top:18px">레퍼런스: ${esc(state.blueprint?.source?.url || '')} — 쇼츠 클론 스튜디오</p>
    </div>
  </body></html>`;
}

async function doExport(kind) {
  const pkg = state.pkg;
  if (!pkg) return;
  const slug = pkg.meta.topic.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) || 'shorts';
  if (kind === 'script') return copy(scriptText(), '전체 스크립트를 복사했습니다');
  if (kind === 'prompts') return copy(promptsText(), '컷별 프롬프트를 복사했습니다');
  if (kind === 'tts') return copy(ttsText(), 'TTS 청크를 복사했습니다');
  if (kind === 'srt') return download(`${slug}.srt`, buildSrt(pkg.cuts), 'application/x-subrip');
  if (kind === 'json') return download(`${slug}.json`, JSON.stringify({ ...pkg, blueprint: state.blueprint }, null, 2), 'application/json');
  if (kind === 'html') return download(`${slug}_스토리보드.html`, storyboardHtml(), 'text/html');
}

/* ───────────── 공통 ───────────── */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1900);
}

async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || '복사했습니다');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(okMsg || '복사했습니다');
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

/* ───────────── 이벤트 연결 ───────────── */

function bind() {
  $('#briefForm').addEventListener('submit', (e) => {
    e.preventDefault();
    generate();
  });
  $('#backBtn').addEventListener('click', leaveStudio);
  $('#newBtn').addEventListener('click', leaveStudio);

  $('#playBtn').addEventListener('click', () => (player.playing ? pause() : play()));
  $('#bigPlay').addEventListener('click', () => (player.playing ? pause() : play()));
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

  $$('#tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('#tabs .tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    });
  });

  $$('[data-export]').forEach((btn) => btn.addEventListener('click', () => doExport(btn.dataset.export)));

  document.addEventListener('keydown', (e) => {
    if (!state.pkg) return;
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

renderForm();
bind();

/**
 * tests/style-help.test.mjs — 03. Visual Style 버튼 정리 + ⓘ 안내 툴팁
 *   · 선택기는 '실제 자료 찾기' / 'AI로 새로 그리기' 두 묶음 × 두 칸(2열)의 작은 타일이다
 *   · 버튼 안에는 이름 한 줄만 — 설명 꼬리표(서브텍스트)는 없다. 자세한 설명은 ⓘ 패널에 있다
 *   · 버튼은 폼을 제출하지 않고(type=button), 패널은 처음엔 닫혀 있으며 aria 로 이어져 있다
 *   · 토글(다시 누르면 닫기) · 바깥 탭 닫기 · Esc 닫기가 app.js 에 물려 있다
 *   · styles.css 를 다시 빌드하지 않아도 되는지(=컴파일된 CSS 에 규칙이 있는지) 확인
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

const pickerStart = html.indexOf('id="stylePicker"');
const panelStart = html.indexOf('id="styleHelpPanel"');
const panelHtml = html.slice(panelStart, pickerStart);
const pickerHtml = html.slice(pickerStart, html.indexOf('04. Video Length', pickerStart));

/** `<button data-style="…">…</button>` 네 개를 순서대로 뽑습니다. */
const styleButtons = [...pickerHtml.matchAll(/<button[^>]*data-style="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map(
  (m) => ({ style: m[1], openTag: m[0].slice(0, m[0].indexOf('>') + 1), inner: m[2] })
);

test('ⓘ 버튼: 폼을 제출하지 않고 안내 패널과 aria 로 이어진다', () => {
  const btn = html.match(/<button[^>]*id="styleHelpBtn"[^>]*>/s);
  assert.ok(btn, 'styleHelpBtn 버튼이 있습니다');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /aria-expanded="false"/);
  assert.match(btn[0], /aria-controls="styleHelpPanel"/);
  assert.match(btn[0], /aria-label="[^"]*비주얼 스타일/);
});

test('안내 패널: 처음엔 닫혀 있고 03. Visual Style 선택기 바로 위에 있다', () => {
  assert.ok(panelStart > 0, 'styleHelpPanel 이 있습니다');
  const openTag = html.slice(html.lastIndexOf('<div', panelStart), panelStart + 200);
  assert.match(openTag, /id="styleHelpPanel"/);
  assert.match(openTag, /\shidden(?:\s|>)/, '처음엔 닫힌 상태(hidden)로 시작합니다');

  const labelAt = html.indexOf('03. Visual Style');
  const nextLabel = html.indexOf('04. Video Length');
  assert.ok(labelAt < panelStart && panelStart < pickerStart && pickerStart < nextLabel, '03번 항목 안, 선택기 위에 놓입니다');
  assert.equal((html.match(/id="styleHelpPanel"/g) || []).length, 1, '패널은 하나만');
});

test('설명 패널: 두 묶음(실제 자료 찾기 / AI로 새로 그리기)과 네 스타일이 모두 담긴다', () => {
  assert.match(panelHtml, /실제 자료 찾기/);
  assert.match(panelHtml, /자동 모션/);
  assert.match(panelHtml, /AI로 새로 그리기/);

  for (const name of ['🎬 움직이는 영상', '📷 실제 사진', '🎨 3D 입체 렌더링', '🎥 실사 시네마틱']) {
    assert.ok(panelHtml.includes(name), `${name} 설명이 있습니다`);
  }

  /* 실제 자료 찾기 묶음 — 출처와 대체 순서, 추천 주제 */
  assert.match(panelHtml, /Pixabay/);
  assert.match(panelHtml, /클립이 없으면 실제\s*사진\(줌·이동\) → AI/);
  assert.match(panelHtml, /강아지·도시·자연/);
  assert.match(panelHtml, /위키백과·커먼즈/);
  assert.match(panelHtml, /롯데타워·경복궁/);
  assert.match(panelHtml, /실물 고증/);
  assert.match(panelHtml, /추천/);

  /* AI 묶음 — '검색 없이' 모든 컷을 그린다는 점 */
  assert.match(panelHtml, /검색 없이 AI가 모든 컷을 3D 미니어처·다이오라마/);
  assert.match(panelHtml, /검색 없이 AI가 모든 컷을 영화 스틸컷 같은 실사풍/);
});

test('선택기: 두 묶음 라벨 + 묶음마다 2열 타일 두 개, 순서는 영상·사진 / 3D·시네마틱', () => {
  assert.ok(pickerStart > 0, 'stylePicker 가 있습니다');

  const labels = [...pickerHtml.matchAll(/<p class="style-group-label">([^<]+)<\/p>/g)].map((m) => m[1].trim());
  assert.deepEqual(labels, ['실제 자료 찾기', 'AI로 새로 그리기']);

  assert.equal((pickerHtml.match(/class="style-group-grid"/g) || []).length, 2, '묶음마다 2열 그리드 하나');
  assert.equal((pickerHtml.match(/class="style-group"/g) || []).length, 2);

  assert.deepEqual(
    styleButtons.map((b) => b.style),
    ['video', 'real', '3d', 'cinematic'],
    '실제 자료 찾기(영상·사진) 다음 AI(3D·시네마틱)'
  );

  /* 라벨 → 버튼 순서: 첫 묶음 라벨이 영상 버튼보다 앞, AI 라벨이 3D 버튼보다 앞 */
  const videoAt = pickerHtml.indexOf('data-style="video"');
  const aiLabelAt = pickerHtml.indexOf('AI로 새로 그리기');
  const threeDAt = pickerHtml.indexOf('data-style="3d"');
  assert.ok(pickerHtml.indexOf('실제 자료 찾기') < videoAt && videoAt < aiLabelAt && aiLabelAt < threeDAt);
});

test('버튼: 이름 한 줄만 — 서브텍스트·꼬리표·줄바꿈이 없고 type=button 이다', () => {
  assert.equal(styleButtons.length, 4, '네 개의 스타일 버튼');
  const expected = {
    video: '🎬 움직이는 영상',
    real: '📷 실제 사진',
    '3d': '🎨 3D 입체 렌더링',
    cinematic: '🎥 실사 시네마틱',
  };

  for (const btn of styleButtons) {
    assert.match(btn.openTag, /type="button"/, `${btn.style}: 폼을 제출하지 않습니다`);
    assert.match(btn.openTag, /\bstyle-btn\b/, `${btn.style}: 컴팩트 타일 클래스`);
    assert.doesNotMatch(btn.openTag, /col-span-2/, `${btn.style}: 두 칸을 다 차지하지 않습니다`);
    assert.equal(btn.inner.replace(/\s+/g, ' ').trim(), expected[btn.style], `${btn.style}: 버튼 글자는 이름뿐`);
    assert.doesNotMatch(btn.inner, /<(span|small|br|i|em)\b/, `${btn.style}: 안쪽 서브텍스트·줄바꿈 없음`);
    assert.doesNotMatch(btn.inner, /스톡 클립|실사 우선|다이오라마|등각|필름 스틸|없으면/, `${btn.style}: 설명 문구 없음`);
  }
});

test('선택기 아래 중복 안내문(#styleNote)은 없고, 설명은 ⓘ 패널 하나로 모인다', () => {
  assert.equal(html.includes('id="styleNote"'), false, '중복 안내문을 지웠습니다');
  assert.equal(app.includes("$('#styleNote')"), false, 'app.js 도 #styleNote 를 건드리지 않습니다');
  assert.match(app, /function paintStyleToggle\(\)/);
  assert.doesNotMatch(app, /col-span-2/, 'paintStyleToggle 이 두 칸 차지를 다시 붙이지 않습니다');
  assert.match(app, /btn\.setAttribute\('aria-pressed', String\(on\)\)/, '선택 상태는 aria-pressed 로만 표시');
});

test('app.js: ⓘ 토글 · 바깥 탭 닫기 · Esc 닫기가 물려 있다', () => {
  assert.match(app, /function setStyleHelp\(open\)/);
  assert.match(app, /panel\.hidden = !open/);
  assert.match(app, /btn\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(app, /function bindStyleHelp\(\)/);
  assert.match(app, /btn\.addEventListener\('click', \(event\) => \{\s*event\.stopPropagation\(\);\s*setStyleHelp\(panel\.hidden\);/);
  assert.match(app, /document\.addEventListener\('click', \(\) => setStyleHelp\(false\)\)/);
  assert.match(app, /event\.key === 'Escape' && !panel\.hidden/);
  assert.ok(/bindStyleHelp\(\);/.test(app.slice(app.indexOf('function bind()'))), 'bind() 에서 호출합니다');
});

test('styles.css: 안내 버튼·패널·컴팩트 타일 규칙이 빌드에 들어 있다(다시 빌드하지 않아도 됨)', () => {
  assert.match(css, /\.style-help-btn\{/);
  assert.match(css, /\.style-help-panel\{/);
  assert.match(css, /\.style-help-panel\[hidden\]\{display:none\}/);
  assert.match(css, /\.style-help-btn\[aria-expanded=true\]/);

  /* 두 칸 그리드 · 작은 타일 · 390px 에서도 줄바꿈 없음 */
  assert.match(css, /\.style-group-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.style-btn\{[^}]*min-height:2\.5rem/);
  assert.match(css, /\.style-btn\{[^}]*white-space:nowrap/);
  assert.match(css, /\.style-btn\[aria-pressed=true\]\{/);
  assert.match(css, /\.style-group-label\{/);
});

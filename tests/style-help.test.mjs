/**
 * tests/style-help.test.mjs — 03. Visual Style ⓘ 안내 툴팁
 *   · 네 가지 스타일이 '실제 자료 찾기' / 'AI로 새로 그리기' 두 묶음으로 설명된다
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

const panelStart = html.indexOf('id="styleHelpPanel"');
const panelHtml = html.slice(panelStart, html.indexOf('class="grid grid-cols-2 gap-2"', panelStart));

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
  const gridAt = html.indexOf('class="grid grid-cols-2 gap-2"', panelStart);
  const nextLabel = html.indexOf('04. Video Length');
  assert.ok(labelAt < panelStart && panelStart < gridAt && gridAt < nextLabel, '03번 항목 안, 선택기 위에 놓입니다');
  assert.equal((html.match(/id="styleHelpPanel"/g) || []).length, 1, '패널은 하나만');
});

test('설명: 두 묶음(실제 자료 찾기 / AI로 새로 그리기)과 네 스타일이 모두 담긴다', () => {
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

test('styles.css: 안내 버튼·패널 규칙이 빌드에 들어 있다(다시 빌드하지 않아도 됨)', () => {
  assert.match(css, /\.style-help-btn\{/);
  assert.match(css, /\.style-help-panel\{/);
  assert.match(css, /\.style-help-panel\[hidden\]\{display:none\}/);
  assert.match(css, /\.style-help-btn\[aria-expanded=true\]/);
});

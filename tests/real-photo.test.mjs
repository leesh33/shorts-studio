/**
 * tests/real-photo.test.mjs — 📷 '실제 사진(실사 우선)' 경로
 *   · 커먼즈 검색 결과에서 사진만 고르고(로고·지도·SVG 제외), 세로 사진을 먼저 씁니다.
 *   · 사진 바이트는 서버에서 받아 data URL 로 돌려줍니다(캔버스 CORS 없음).
 *   · 컷마다 다른 사진이 나오도록 이미 쓴 사진(exclude)은 건너뜁니다.
 *   · 사진이 없으면 'no-photo' 로 정직하게 실패하고, API 가 AI 폴백으로 넘깁니다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueries,
  cleanKeyword,
  downloadPhoto,
  findRealPhoto,
  normalizeTitle,
  rankCandidates,
  searchCommons,
  searchWikipedia,
} from '../lib/real-photo.js';

function jpegBytes(size = 6000) {
  const buf = Buffer.alloc(size, 0x41);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)),
  };
}

function binaryResponse(bytes, mime = 'image/jpeg', status = 200) {
  const buf = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? mime : null) },
    arrayBuffer: async () => buf,
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
}

const COMMONS_PAYLOAD = {
  query: {
    pages: [
      {
        title: 'File:Lotte World Tower logo.svg',
        index: 1,
        imageinfo: [{ mime: 'image/svg+xml', width: 284, height: 37, url: 'https://upload.wikimedia.org/logo.svg' }],
      },
      {
        title: 'File:Lotte World Tower map.jpg',
        index: 2,
        imageinfo: [{ mime: 'image/jpeg', width: 1400, height: 900, url: 'https://upload.wikimedia.org/map.jpg' }],
      },
      {
        title: 'File:Lotte World Tower landscape.jpg',
        index: 3,
        imageinfo: [
          {
            mime: 'image/jpeg',
            width: 4000,
            height: 2200,
            thumbwidth: 1200,
            thumbheight: 660,
            thumburl: 'https://upload.wikimedia.org/landscape.jpg',
            url: 'https://upload.wikimedia.org/landscape.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lotte_World_Tower_landscape.jpg',
            extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: 'Someone' } },
          },
        ],
      },
      {
        title: 'File:Lotte World Tower 20170505 173622.jpg',
        index: 4,
        imageinfo: [
          {
            mime: 'image/jpeg',
            width: 2448,
            height: 3264,
            thumbwidth: 1200,
            thumbheight: 1600,
            thumburl: 'https://upload.wikimedia.org/tower-portrait.jpg',
            url: 'https://upload.wikimedia.org/tower-portrait.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lotte_World_Tower_20170505_173622.jpg',
            extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, Artist: { value: 'Photo Person' } },
          },
        ],
      },
    ],
  },
};

const WIKI_PAYLOAD = {
  query: {
    pages: [
      {
        title: '롯데월드타워',
        index: 1,
        thumbnail: { source: 'https://upload.wikimedia.org/wiki-tower.jpg', width: 1200, height: 820 },
      },
    ],
  },
};

test('cleanKeyword / normalizeTitle / buildQueries: 검색어를 다듬고 순서를 정한다', () => {
  assert.equal(cleanKeyword('[롯데타워]의 "비밀"'), '롯데타워의 비밀');
  assert.equal(normalizeTitle('File:Lotte_World_Tower.jpg'), 'lotte world tower');
  const queries = buildQueries({ ko: '롯데타워', en: 'Lotte World Tower' });
  assert.equal(queries[0].source, 'wikimedia-commons');
  assert.equal(queries[0].query, '롯데타워');
  assert.ok(queries.some((q) => q.source === 'wikipedia-ko' && q.lang === 'ko'));
  assert.ok(queries.some((q) => q.source === 'wikipedia-en' && q.lang === 'en'));
  assert.equal(buildQueries({}).length, 0);
});

test('searchCommons: 로고·지도·SVG 를 거르고 세로 사진을 먼저 정렬한다', async () => {
  const res = await searchCommons('롯데타워', { fetchImpl: async () => jsonResponse(COMMONS_PAYLOAD) });
  assert.equal(res.ok, true);
  assert.equal(res.candidates.length, 2, '로고와 지도는 후보에서 빠집니다');
  const ranked = rankCandidates(res.candidates, { query: '롯데타워' });
  assert.match(ranked[0].title, /173622/);
  assert.equal(ranked[0].height > ranked[0].width, true);
  assert.equal(ranked[0].license, 'CC BY 4.0');
});

test('searchCommons: 결과가 없으면 no-candidates 로 실패한다', async () => {
  const res = await searchCommons('없는장소', { fetchImpl: async () => jsonResponse({ batchcomplete: '' }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-candidates');
});

test('searchWikipedia: 문서 대표 이미지를 후보로 돌려준다', async () => {
  const res = await searchWikipedia('롯데월드타워', 'ko', { fetchImpl: async () => jsonResponse(WIKI_PAYLOAD) });
  assert.equal(res.ok, true);
  assert.equal(res.candidates[0].title, '롯데월드타워');
  assert.match(res.candidates[0].thumbUrl, /wiki-tower/);
  assert.match(res.candidates[0].page, /ko\.wikipedia\.org/);
});

test('downloadPhoto: 이미지가 아니면(HTML) 실패로 돌려준다', async () => {
  const html = Buffer.from('<html>not an image</html>'.repeat(400));
  const res = await downloadPhoto('https://upload.wikimedia.org/thing.jpg', {
    fetchImpl: async () => binaryResponse(html, 'text/html'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-an-image');
});

test('findRealPhoto: 커먼즈에서 실제 롯데타워 사진을 받아 data URL 로 돌려준다', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('commons.wikimedia.org/w/api.php')) return jsonResponse(COMMONS_PAYLOAD);
    return binaryResponse(jpegBytes());
  };
  const photo = await findRealPhoto({ keywords: { ko: '롯데타워', en: 'Lotte World Tower' }, index: 0, fetchImpl });
  assert.equal(photo.ok, true);
  assert.equal(photo.provider, 'wikimedia-commons');
  assert.match(photo.dataUrl, /^data:image\/jpeg;base64,/);
  assert.match(photo.license, /CC BY/);
  assert.match(photo.title, /Lotte World Tower/);
  assert.ok(photo.attempts.length >= 1);
});

test('findRealPhoto: 이미 쓴 사진은 건너뛰고 다른 사진을 고른다', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/w/api.php')) return jsonResponse(COMMONS_PAYLOAD);
    return binaryResponse(jpegBytes());
  };
  const photo = await findRealPhoto({
    keywords: { ko: '롯데타워' },
    index: 0,
    exclude: ['File:Lotte World Tower 20170505 173622.jpg'],
    fetchImpl,
  });
  assert.equal(photo.ok, true);
  assert.doesNotMatch(photo.title, /173622/);
});

test('findRealPhoto: 커먼즈에 없으면 위키백과 사진으로 내려간다', async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes('commons.wikimedia.org')) return jsonResponse({ batchcomplete: '' });
    if (target.includes('ko.wikipedia.org')) return jsonResponse(WIKI_PAYLOAD);
    return binaryResponse(jpegBytes());
  };
  const photo = await findRealPhoto({ keywords: { ko: '롯데월드타워' }, fetchImpl });
  assert.equal(photo.ok, true);
  assert.equal(photo.provider, 'wikipedia-ko');
  assert.match(photo.dataUrl, /^data:image\/jpeg;base64,/);
});

test('findRealPhoto: 검색어가 없거나 사진이 없으면 no-photo', async () => {
  const none = await findRealPhoto({ keywords: {} });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-keyword');

  const empty = await findRealPhoto({ keywords: { ko: '없는장소' }, fetchImpl: async () => jsonResponse({ batchcomplete: '' }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-photo');
  assert.ok(empty.attempts.length >= 2);
});

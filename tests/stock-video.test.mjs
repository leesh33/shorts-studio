/**
 * tests/stock-video.test.mjs — 🎬 '움직이는 영상(스톡 클립)' 경로
 *   · Pixabay(1순위) → Pexels(키가 있을 때) → 위키미디어 커먼즈 순서로 찾습니다.
 *   · 세로·HD 클립을 먼저 고르고, 같은 클립이 두 컷에 겹치지 않게 exclude 합니다.
 *   · 영상 바이트 대신 같은 출처 프록시 주소(/api/video-proxy?u=…)를 돌려줍니다.
 *   · 프록시는 허용 호스트만 열고, 클립이 없으면 no-video 로 정직하게 실패합니다.
 *   · 네트워크는 전부 스텁입니다(실제로 나가지 않음).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_VIDEO_HOSTS,
  bestMatch,
  findStockVideo,
  isAllowedVideoUrl,
  matchClip,
  pickPexelsFile,
  pickPixabayFile,
  probeVideo,
  proxiedVideoUrl,
  queryTerms,
  searchCommonsVideos,
  searchPixabayVideos,
  videoCredit,
  videoFromCommonsPage,
  videoFromPexels,
  videoFromPixabay,
  videoSearchPlan,
  videoTermSets,
} from '../lib/stock-video.js';
import findVideoHandler from '../api/find-video.js';
import healthHandler from '../api/health.js';

const PIXABAY_HIT = {
  id: 125,
  pageURL: 'https://pixabay.com/videos/id-125/',
  type: 'film',
  tags: 'seoul, city, street',
  duration: 12,
  videos: {
    large: { url: 'https://cdn.pixabay.com/video/2015/08/08/125_large.mp4', width: 3840, height: 2160, size: 66_152_355 },
    medium: { url: 'https://cdn.pixabay.com/video/2015/08/08/125_medium.mp4', width: 1920, height: 1080, size: 35_620_830, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125_medium.jpg' },
    small: { url: 'https://cdn.pixabay.com/video/2015/08/08/125_small.mp4', width: 1280, height: 720, size: 10_307_360, thumbnail: 'https://cdn.pixabay.com/video/2015/08/08/125_small.jpg' },
    tiny: { url: 'https://cdn.pixabay.com/video/2015/08/08/125_tiny.mp4', width: 960, height: 540, size: 4_267_990 },
  },
  user: 'Coverr-Free-Footage',
};

const PIXABAY_PORTRAIT = {
  ...PIXABAY_HIT,
  id: 900,
  tags: 'seoul, city, night, vertical',
  videos: {
    large: { url: 'https://cdn.pixabay.com/video/2023/01/01/900_large.mp4', width: 2160, height: 3840, size: 60_000_000 },
    medium: { url: 'https://cdn.pixabay.com/video/2023/01/01/900_medium.mp4', width: 1080, height: 1920, size: 20_000_000, thumbnail: 'https://cdn.pixabay.com/video/2023/01/01/900_medium.jpg' },
    small: { url: 'https://cdn.pixabay.com/video/2023/01/01/900_small.mp4', width: 720, height: 1280, size: 9_000_000 },
    tiny: { url: 'https://cdn.pixabay.com/video/2023/01/01/900_tiny.mp4', width: 540, height: 960, size: 3_000_000 },
  },
};

/** 주제와 무관한 클립 — '롯데월드타워의 비밀' 에 실제로 붙었던 종류(횡단보도·요트·항구) */
const PIXABAY_CROSSWALK = {
  ...PIXABAY_HIT,
  id: 2001,
  tags: 'road, traffic, crosswalk, cars',
  videos: {
    medium: { url: 'https://cdn.pixabay.com/video/2024/02/02/2001_medium.mp4', width: 1080, height: 1920, size: 18_000_000 },
  },
};

const PIXABAY_YACHT = {
  ...PIXABAY_HIT,
  id: 2002,
  tags: 'harbor, yacht, sea, sailboat',
  videos: {
    medium: { url: 'https://cdn.pixabay.com/video/2024/02/02/2002_medium.mp4', width: 1080, height: 1920, size: 18_000_000 },
  },
};

/** 진짜 롯데타워 클립(있을 때) — 태그에 고유명사가 있습니다. */
const PIXABAY_LOTTE = {
  ...PIXABAY_HIT,
  id: 2003,
  tags: 'lotte world tower, seoul, skyscraper, night',
  videos: {
    medium: { url: 'https://cdn.pixabay.com/video/2024/02/02/2003_medium.mp4', width: 1080, height: 1920, size: 18_000_000 },
  },
};

const PIXABAY_DOG = {
  ...PIXABAY_HIT,
  id: 2004,
  tags: 'dog, puppy, pet, cute',
  videos: {
    medium: { url: 'https://cdn.pixabay.com/video/2024/02/02/2004_medium.mp4', width: 1080, height: 1920, size: 18_000_000 },
  },
};

const COMMONS_PAGE = {
  title: 'File:Seoul, central street.webm',
  index: 1,
  videoinfo: [
    {
      size: 19_234_828,
      width: 1280,
      height: 720,
      duration: 11.407,
      mime: 'video/webm',
      url: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Seoul%2C_central_street.webm',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Seoul,_central_street.webm',
      derivatives: [
        { src: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/e/ef/x.240p.vp9.webm', type: 'video/webm; codecs="vp9, opus"', width: 426, height: 240 },
        { src: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/e/ef/x.480p.vp9.webm', type: 'video/webm; codecs="vp9, opus"', width: 854, height: 480 },
      ],
      extmetadata: {
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X">Виктор Пинчук</a>' },
      },
    },
  ],
  imageinfo: [
    {
      size: 19_234_828,
      width: 1280,
      height: 720,
      duration: 11.407,
      thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ef/Seoul.webm/720px--Seoul.webm.jpg',
      url: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Seoul%2C_central_street.webm',
    },
  ],
};

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)),
  };
}

/** 앞 바이트가 webm(EBML) 시그니처인 응답 */
function videoResponse(size = 4096, type = 'video/webm') {
  const buf = Buffer.alloc(size, 0x41);
  buf[0] = 0x1a;
  buf[1] = 0x45;
  buf[2] = 0xdf;
  buf[3] = 0xa3;
  return {
    ok: true,
    status: 206,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => buf,
    text: async () => buf.toString('utf8'),
    json: async () => ({}),
  };
}

function pixabayStub(hits, seen = []) {
  return async (url) => {
    seen.push(String(url));
    return jsonResponse({ total: hits.length, totalHits: hits.length, hits });
  };
}

test('검색 순서: Pixabay 키 → Pexels 키 → 위키미디어 커먼즈', () => {
  assert.deepEqual(
    videoSearchPlan({ hasKey: true, hasPexelsKey: true, keywords: { ko: '서울', en: 'Seoul', fallback: '서울' } }).map((p) => p.provider),
    ['pixabay', 'pexels', 'wikimedia-commons', 'wikimedia-commons'],
  );
  assert.deepEqual(
    videoSearchPlan({ hasKey: false, hasPexelsKey: false, keywords: { ko: '서울', en: 'Seoul' } }).map((p) => p.provider),
    ['wikimedia-commons', 'wikimedia-commons'],
  );
  // 같은 검색어는 한 번만 묻습니다.
  const plan = videoSearchPlan({ hasKey: false, keywords: { ko: 'Seoul', en: 'Seoul', fallback: 'Seoul' } });
  assert.equal(plan.length, 1);
});

test('검색 순서: Pixabay·Pexels 는 영어 검색어로만 묻는다(한국어 태그 색인 없음)', () => {
  const plan = videoSearchPlan({ hasKey: true, hasPexelsKey: true, keywords: { ko: '롯데월드타워', en: '', videoEn: 'skyscraper night' } });
  const pixabay = plan.find((p) => p.provider === 'pixabay');
  const pexels = plan.find((p) => p.provider === 'pexels');
  assert.equal(pixabay.query, 'skyscraper night');
  assert.equal(pexels.query, 'skyscraper night');
  // 한국어 검색어밖에 없으면 Pixabay 를 부르지 않습니다(비슷한 분위기 클립이 오기 때문).
  const koOnly = videoSearchPlan({ hasKey: true, hasPexelsKey: true, keywords: { ko: '롯데월드타워' } });
  assert.deepEqual(koOnly.map((p) => p.provider), ['wikimedia-commons']);
});

test('queryTerms: 고유명사 랜드마크는 고유명사 토큰을, 일반 장면은 피사체 토큰을 요구한다', () => {
  const tower = queryTerms({ query: 'Lotte World Tower', kind: 'specific_landmark' });
  assert.deepEqual(tower.required, ['lotte', 'world', 'tower']);
  assert.deepEqual(tower.distinctive, ['lotte']); // tower·world 는 흔한 말

  const generic = queryTerms({ query: 'skyscraper night', kind: 'generic_scene' });
  assert.deepEqual(generic.required, ['skyscraper']); // night 는 촬영 수식어
  assert.deepEqual(generic.distinctive, []); // skyscraper 는 흔한 장소 명사(고유명사 판정용)

  const dog = queryTerms({ query: 'dog owners', kind: 'generic_scene' });
  assert.deepEqual(dog.required, ['dog', 'owner']);
});

test('matchClip: 무관한 태그는 0 — 횡단보도·요트·사진작가', () => {
  const terms = queryTerms({ query: 'Lotte World Tower', kind: 'specific_landmark' });
  assert.equal(matchClip({ tags: ['road', 'traffic', 'crosswalk', 'cars'], title: 'road, traffic, crosswalk' }, terms).level, 0);
  assert.equal(matchClip({ tags: ['harbor', 'yacht', 'sea'], title: 'harbor, yacht' }, terms).level, 0);
  assert.equal(matchClip({ tags: ['photographer', 'camera', 'people'], title: 'photographer' }, terms).level, 0);
  // 진짜 롯데타워 클립은 통과합니다.
  assert.equal(matchClip({ tags: ['lotte world tower', 'seoul', 'skyscraper'], title: 'lotte world tower' }, terms).level, 2);

  const deck = queryTerms({ query: 'observation deck', kind: 'generic_scene' });
  assert.equal(matchClip({ tags: ['city', 'night', 'lights'], title: 'city night' }, deck).level, 0);
  assert.equal(matchClip({ tags: ['observation deck', 'skyline'], title: 'observation deck' }, deck).level, 2);
});

test('matchClip: 요청한 소재는 막지 않는다(강아지·요트)', () => {
  const dog = queryTerms({ query: 'dog', kind: 'generic_scene' });
  assert.equal(matchClip({ tags: ['dog', 'puppy', 'pet'], title: 'dog, puppy' }, dog).level, 2);
  assert.equal(matchClip({ tags: ['cat', 'kitten'], title: 'cat' }, dog).level, 0);

  // 요트가 주제면 요트 클립을 씁니다.
  const yacht = queryTerms({ query: 'yacht harbor', kind: 'generic_scene' });
  assert.ok(matchClip({ tags: ['yacht', 'harbor', 'sea'], title: 'yacht, harbor' }, yacht).level >= 1);
});

test('matchClip: 여러 단어 시각어는 첫 피사체만 맞아도 그 장면이다', () => {
  // Gemini 는 "dog looking owner" 처럼 3단어를 줍니다 — 태그에 dog 만 있어도 강아지 장면입니다.
  const terms = queryTerms({ query: 'dog looking owner', kind: 'generic_scene' });
  assert.equal(matchClip({ tags: ['dog', 'puppy', 'pet'], title: 'dog, puppy' }, terms).level, 1);
  assert.equal(matchClip({ tags: ['cat', 'kitten'], title: 'cat' }, terms).level, 0);
  // 첫 단어가 배경어(city)면 그것만으로는 믿지 않습니다.
  const city = queryTerms({ query: 'city night walk', kind: 'generic_scene' });
  assert.equal(matchClip({ tags: ['mountain', 'forest'], title: 'mountain' }, city).level, 0);
  assert.ok(matchClip({ tags: ['city', 'night', 'lights'], title: 'city night' }, city).level >= 1);
});

test('matchClip: 뒤쪽 범용 태그만 맞는 남의 클립(고양이·호랑이)은 버린다', () => {
  // 실측: 'dog sleeping bed' 에 고양이 클립(tags: cat, kitten, kitty, feline, dog …)이 붙었습니다.
  const terms = queryTerms({ query: 'dog sleeping bed', kind: 'generic_scene' });
  const cat = { tags: ['cat', 'kitten', 'kitty', 'feline', 'dog', 'sleeping'], title: 'cat, kitten, kitty, feline' };
  assert.equal(matchClip(cat, terms).level, 0);
  const dog = { tags: ['dog', 'sleeping', 'bed', 'pet'], title: 'dog, sleeping, bed, pet' };
  assert.ok(matchClip(dog, terms).level >= 1);
});

test('matchClip: 그림·애니메이션 클립은 실사 자리에 쓰지 않는다', () => {
  const terms = queryTerms({ query: 'dog eyes closeup', kind: 'generic_scene' });
  assert.equal(matchClip({ tags: ['dog', 'cat', 'puppy', 'cartoon'], title: 'dog, cat, puppy, cartoon' }, terms).level, 0);
  assert.ok(matchClip({ tags: ['dog', 'eyes', 'closeup'], title: 'dog, eyes, closeup' }, terms).level >= 1);
});

test('matchClip: 꾸미는 말(glass) 하나만 맞는 클립은 버린다', () => {
  const terms = queryTerms({ query: 'glass elevator', kind: 'generic_scene' });
  assert.deepEqual(terms.required, ['elevator']);
  assert.equal(matchClip({ tags: ['beer', 'glass', 'drink', 'wheat'], title: 'beer, glass, drink, wheat' }, terms).level, 0);
  assert.ok(matchClip({ tags: ['elevator', 'glass', 'building'], title: 'elevator, glass, building' }, terms).level >= 1);
});

test('matchClip: 고유명사가 카드에 보이는 태그에 없으면(뒤 태그에만 있으면) 버린다', () => {
  const terms = queryTerms({ query: 'Lotte World Tower', kind: 'specific_landmark' });
  const hidden = { tags: ['seoul', 'hangang river', 'sunrise', 'lotte world tower'], title: 'seoul, hangang river, south korea, sunrise' };
  assert.equal(matchClip(hidden, terms).level, 0);
  const shown = { tags: ['seoul', 'hangang river', 'lotte world tower', 'night'], title: 'seoul, hangang river, lotte world tower, night' };
  assert.ok(matchClip(shown, terms).level >= 1);
});

test('bestMatch: 한국어 제목과 영어 태그를 함께 본다', () => {
  const termsList = videoTermSets({ ko: '롯데월드타워', en: 'Lotte World Tower', kind: 'specific_landmark' });
  assert.equal(bestMatch({ tags: [], title: '롯데월드타워 야경' }, termsList).level, 2);
  assert.equal(bestMatch({ tags: ['lotte world tower', 'seoul'], title: '' }, termsList).level, 2);
  assert.equal(bestMatch({ tags: ['crosswalk', 'traffic'], title: '' }, termsList).level, 0);
});

test('프록시 허용 호스트 — Pixabay·Pexels·위키미디어 CDN 만', () => {
  assert.ok(isAllowedVideoUrl('https://cdn.pixabay.com/video/2015/08/08/125_medium.mp4'));
  assert.ok(isAllowedVideoUrl('https://videos.pexels.com/video-files/123/123-hd.mp4'));
  assert.ok(isAllowedVideoUrl('https://upload.wikimedia.org/wikipedia/commons/e/ef/x.webm'));
  assert.ok(isAllowedVideoUrl('https://thumb.wikimedia.org/wikipedia/commons/thumb/x.jpg'));
  assert.ok(ALLOWED_VIDEO_HOSTS.includes('cdn.pixabay.com'));
  // 열린 프록시가 되면 안 됩니다.
  assert.equal(isAllowedVideoUrl('https://evil.example.com/a.mp4'), false);
  assert.equal(isAllowedVideoUrl('http://cdn.pixabay.com/video/x.mp4'), false);
  assert.equal(isAllowedVideoUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedVideoUrl(''), false);
});

test('프록시 주소는 원본을 그대로 인코딩합니다', () => {
  const url = proxiedVideoUrl('https://cdn.pixabay.com/video/a b.mp4?x=1&y=2');
  assert.ok(url.startsWith('/api/video-proxy?u='));
  assert.equal(new URL(url, 'https://x.test').searchParams.get('u'), 'https://cdn.pixabay.com/video/a b.mp4?x=1&y=2');
});

test('Pixabay 후보 — 세로·1080 급을 고르고 포스터·라이선스를 함께 준다', () => {
  const flat = videoFromPixabay(PIXABAY_HIT);
  assert.equal(flat.provider, 'pixabay');
  // 35MB 짜리 1080p 보다는 720p(small)를 고릅니다 — 모바일 로딩이 가볍습니다.
  assert.match(flat.sourceUrl, /_small\.mp4$/);
  assert.equal(flat.posterUrl, 'https://cdn.pixabay.com/video/2015/08/08/125_small.jpg');
  assert.equal(flat.license, 'Pixabay Content License');
  assert.equal(flat.artist, 'Coverr-Free-Footage');
  assert.match(flat.title, /seoul/);
  assert.equal(flat.duration, 12);

  const portrait = videoFromPixabay(PIXABAY_PORTRAIT);
  assert.match(portrait.sourceUrl, /_medium\.mp4$/);
  assert.equal(portrait.width, 1080);
  assert.equal(portrait.height, 1920);

  // 파일이 하나도 없으면 후보가 아닙니다.
  assert.equal(videoFromPixabay({ id: 1, videos: {} }), null);
  // Pixabay 밖의 호스트는 받지 않습니다.
  assert.equal(videoFromPixabay({ ...PIXABAY_HIT, videos: { medium: { url: 'https://evil.example.com/a.mp4', width: 1080, height: 1920 } } }), null);
});

test('Pexels 후보 — mp4·세로 HD 를 고르고 HLS 는 건너뛴다', () => {
  const video = {
    id: 42,
    url: 'https://www.pexels.com/video/city-walk-42/',
    image: 'https://images.pexels.com/videos/42/free-video-42.jpg',
    duration: 9,
    user: { name: 'Someone', url: 'https://www.pexels.com/@someone' },
    video_files: [
      { id: 1, quality: 'hls', file_type: 'video/mp4', link: 'https://videos.pexels.com/hls/42.m3u8', width: 1080, height: 1920 },
      { id: 2, quality: 'sd', file_type: 'video/mp4', link: 'https://videos.pexels.com/video-files/42/42-sd.mp4', width: 360, height: 640 },
      { id: 3, quality: 'hd', file_type: 'video/mp4', link: 'https://videos.pexels.com/video-files/42/42-hd.mp4', width: 1080, height: 1920 },
    ],
  };
  const file = pickPexelsFile(video);
  assert.match(file.link, /-hd\.mp4$/);
  const candidate = videoFromPexels(video);
  assert.equal(candidate.provider, 'pexels');
  assert.equal(candidate.license, 'Pexels License');
  assert.equal(candidate.posterUrl, 'https://images.pexels.com/videos/42/free-video-42.jpg');
});

test('커먼즈 후보 — 720p 이하 webm 트랜스코드와 포스터(thumb)를 쓴다', () => {
  const candidate = videoFromCommonsPage(COMMONS_PAGE);
  assert.equal(candidate.provider, 'wikimedia-commons');
  assert.match(candidate.sourceUrl, /480p\.vp9\.webm$/);
  assert.equal(candidate.width, 854);
  assert.equal(candidate.height, 480);
  assert.equal(candidate.posterUrl, 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ef/Seoul.webm/720px--Seoul.webm.jpg');
  assert.equal(candidate.license, 'CC BY-SA 4.0');
  assert.match(candidate.artist, /Пинчук/);
  assert.equal(candidate.duration, 11.407);

  // ogv 원본이라도 webm 트랜스코드가 있으면 그걸 씁니다.
  const ogv = videoFromCommonsPage({ ...COMMONS_PAGE, videoinfo: [{ ...COMMONS_PAGE.videoinfo[0], mime: 'application/ogg' }] });
  assert.match(ogv.sourceUrl, /480p\.vp9\.webm$/);
  // 트랜스코드도 없고 원본이 mp4 면(브라우저 호환은 되지만 정책상 webm 만) 후보가 아닙니다.
  assert.equal(videoFromCommonsPage({ title: 'File:x.mp4', videoinfo: [{ mime: 'video/mp4', url: 'https://upload.wikimedia.org/x.mp4', size: 1000 }] }), null);
});

test('Pixabay 검색 — key·q·lang 을 보내고 결과를 후보로 바꾼다', async () => {
  const seen = [];
  const res = await searchPixabayVideos('서울 거리', { apiKey: 'test-key', fetchImpl: pixabayStub([PIXABAY_HIT], seen) });
  assert.equal(res.ok, true);
  assert.equal(res.candidates.length, 1);
  const url = new URL(seen[0]);
  assert.equal(url.origin + url.pathname, 'https://pixabay.com/api/videos/');
  assert.equal(url.searchParams.get('key'), 'test-key');
  assert.equal(url.searchParams.get('q'), '서울 거리');
  assert.equal(url.searchParams.get('lang'), 'ko');
  assert.equal(url.searchParams.get('video_type'), 'film');

  const english = [];
  await searchPixabayVideos('Seoul street', { apiKey: 'test-key', fetchImpl: pixabayStub([], english) });
  assert.equal(new URL(english[0]).searchParams.get('lang'), 'en');

  const noKey = await searchPixabayVideos('서울', { apiKey: '' });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.reason, 'no-key');
});

test('findStockVideo — Pixabay 클립을 프록시 주소로 돌려준다', async () => {
  const found = await findStockVideo({
    keywords: { ko: '서울', en: 'Seoul' },
    index: 0,
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      if (String(url).startsWith('https://pixabay.com/api/videos/')) return jsonResponse({ total: 2, totalHits: 2, hits: [PIXABAY_HIT, PIXABAY_PORTRAIT] });
      return videoResponse();
    },
  });
  assert.equal(found.ok, true);
  assert.equal(found.provider, 'pixabay');
  assert.match(found.videoUrl, /^\/api\/video-proxy\?u=/);
  assert.match(decodeURIComponent(found.videoUrl), /_medium\.mp4$/);
  assert.ok(found.attempts.some((a) => a.provider === 'pixabay' && a.ok));
  // 세로 클립이 먼저 — 점수에 세로 보너스가 있습니다.
  assert.equal(found.height >= found.width, true);
});

test('findStockVideo — Pixabay 0건이면 커먼즈 영상으로 넘어간다', async () => {
  const found = await findStockVideo({
    keywords: { ko: '서울', en: 'Seoul' },
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://pixabay.com/api/videos/')) return jsonResponse({ total: 0, totalHits: 0, hits: [] });
      if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse({ query: { pages: [COMMONS_PAGE] } });
      return videoResponse();
    },
  });
  assert.equal(found.ok, true);
  assert.equal(found.provider, 'wikimedia-commons');
  assert.match(found.providerLabel, /위키미디어/);
  assert.ok(found.attempts.some((a) => a.provider === 'pixabay' && a.reason === 'no-candidates'));
});

test('findStockVideo — 키가 하나도 없으면 커먼즈에서 찾는다', async () => {
  const seen = [];
  const found = await findStockVideo({
    keywords: { ko: '서울', en: 'Seoul' },
    fetchImpl: async (url) => {
      seen.push(String(url));
      if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse({ query: { pages: [COMMONS_PAGE] } });
      return videoResponse();
    },
  });
  assert.equal(found.ok, true);
  assert.equal(found.provider, 'wikimedia-commons');
  assert.equal(seen.some((u) => u.includes('pixabay') || u.includes('pexels')), false);
  assert.equal(found.credit, 'Seoul, central street · CC BY-SA 4.0 · Виктор Пинчук');
});

test('findStockVideo — 무관한 Pixabay 클립(횡단보도·요트)은 쓰지 않고 no-relevant-video', async () => {
  // 사용자 신고 그대로: '롯데월드타워' 로 물었는데 횡단보도·요트 클립이 붙었습니다.
  const found = await findStockVideo({
    keywords: { ko: '롯데월드타워', en: 'Lotte World Tower', videoEn: 'Lotte World Tower', kind: 'specific_landmark' },
    index: 0,
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://pixabay.com/api/videos/')) {
        return jsonResponse({ total: 2, totalHits: 2, hits: [PIXABAY_CROSSWALK, PIXABAY_YACHT] });
      }
      if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse({ query: { pages: [] } });
      return videoResponse();
    },
  });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'no-relevant-video');
  // 왜 버렸는지 검색 기록에 남습니다 — 화면은 이걸 보고 실제 사진으로 내려갑니다.
  assert.ok(found.attempts.some((a) => a.reason === 'no-relevant-clip' && a.provider === 'pixabay'));
});

test('findStockVideo — 무관한 클립 사이에 진짜 클립이 있으면 그것만 고른다', async () => {
  const found = await findStockVideo({
    keywords: { ko: '롯데월드타워', en: 'Lotte World Tower', videoEn: 'Lotte World Tower', kind: 'specific_landmark' },
    index: 0,
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://pixabay.com/api/videos/')) {
        return jsonResponse({ total: 3, totalHits: 3, hits: [PIXABAY_CROSSWALK, PIXABAY_YACHT, PIXABAY_LOTTE] });
      }
      return videoResponse();
    },
  });
  assert.equal(found.ok, true);
  assert.equal(found.videoId, 'pixabay:2003');
  assert.equal(found.relevance, 2);
  assert.match(found.query, /Lotte World Tower/);
});

test('findStockVideo — 강아지 주제는 진짜 강아지 클립을 고른다', async () => {
  const found = await findStockVideo({
    keywords: { ko: '강아지', en: 'dog', videoEn: 'dog love', kind: 'generic_scene' },
    index: 0,
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://pixabay.com/api/videos/')) {
        return jsonResponse({ total: 2, totalHits: 2, hits: [PIXABAY_CROSSWALK, PIXABAY_DOG] });
      }
      return videoResponse();
    },
  });
  assert.equal(found.ok, true);
  assert.equal(found.videoId, 'pixabay:2004');
  assert.match(String(found.title), /dog/);
});

test('findStockVideo — 고유명사가 안 맞는 클립만 있으면 no-relevant-video', async () => {
  // Pixabay 가 'city, skyline, night' 클립만 준 경우 — '롯데월드타워' 컷에는 쓰지 않습니다.
  const saja = { ...PIXABAY_HIT, id: 2005, tags: 'city, skyline, night' };
  const found = await findStockVideo({
    keywords: { ko: '롯데월드타워', en: 'Lotte World Tower', videoEn: 'Lotte World Tower', kind: 'specific_landmark' },
    index: 3,
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://pixabay.com/api/videos/')) return jsonResponse({ total: 1, totalHits: 1, hits: [saja] });
      if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse({ query: { pages: [] } });
      return videoResponse();
    },
  });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'no-relevant-video');
});

test('findStockVideo — 일반 장면(generic_scene)은 시각어가 맞으면 쓴다', async () => {
  const skyline = { ...PIXABAY_HIT, id: 2006, tags: 'skyscraper, city, night, lights' };
  const found = await findStockVideo({
    keywords: { ko: '서울 스카이라인', en: 'Seoul skyline', videoEn: 'skyscraper night', kind: 'generic_scene' },
    index: 0,
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://pixabay.com/api/videos/')) return jsonResponse({ total: 1, totalHits: 1, hits: [skyline] });
      return videoResponse();
    },
  });
  assert.equal(found.ok, true);
  assert.equal(found.videoId, 'pixabay:2006');
});

test('findStockVideo — 클립이 없으면 no-video 로 정직하게 실패', async () => {
  const found = await findStockVideo({
    keywords: { ko: '없는장소', en: 'Nowhere' },
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse({ query: { pages: [] } });
      return videoResponse();
    },
  });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'no-video');
  assert.ok(found.attempts.length >= 1);

  const noKeyword = await findStockVideo({ keywords: {} });
  assert.equal(noKeyword.ok, false);
  assert.equal(noKeyword.reason, 'no-keyword');
});

test('findStockVideo — exclude 로 같은 클립을 다시 쓰지 않는다', async () => {
  const commons = {
    query: {
      pages: [
        COMMONS_PAGE,
        {
          ...COMMONS_PAGE,
          title: 'File:Seoul night walk.webm',
          index: 2,
          videoinfo: [{ ...COMMONS_PAGE.videoinfo[0], url: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/night.webm' }],
        },
      ],
    },
  };
  const stub = async (url) => {
    if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse(commons);
    return videoResponse();
  };
  const first = await findStockVideo({ keywords: { ko: '서울', en: 'Seoul' }, index: 0, fetchImpl: stub });
  assert.equal(first.ok, true);
  const second = await findStockVideo({ keywords: { ko: '서울', en: 'Seoul' }, index: 0, exclude: [first.videoId], fetchImpl: stub });
  assert.equal(second.ok, true);
  assert.notEqual(second.videoId, first.videoId);
});

test('probeVideo — 영상이 아닌 응답은 실패로 돌려준다', async () => {
  const notVideo = await probeVideo('https://cdn.pixabay.com/video/x.mp4', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.alloc(2000, 0x41),
    }),
  });
  assert.equal(notVideo.ok, false);
  assert.equal(notVideo.reason, 'not-a-video');

  const ok = await probeVideo('https://cdn.pixabay.com/video/x.mp4', { fetchImpl: async () => videoResponse() });
  assert.equal(ok.ok, true);

  const blocked = await probeVideo('https://evil.example.com/x.mp4', { fetchImpl: async () => videoResponse() });
  assert.equal(blocked.reason, 'bad-url');
});

test('videoCredit — 제목·라이선스·작가를 한 줄로', () => {
  assert.equal(
    videoCredit({ title: 'seoul, city', license: 'Pixabay Content License', artist: 'Coverr' }),
    'seoul, city · Pixabay Content License · Coverr',
  );
  assert.equal(videoCredit(null), '');
});

/* ───────────────────── POST /api/find-video ───────────────────── */

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      res.headers[String(k).toLowerCase()] = v;
    },
    end(chunk) {
      res.body = String(chunk == null ? '' : chunk);
    },
  };
  return res;
}

function mockReq({ method = 'POST', body = {}, url = '/' } = {}) {
  return { method, body, url, headers: {} };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] == null) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('GET /api/find-video — 키 유무만 알려 주고 키 값은 담지 않는다', async () => {
  await withEnv({ PIXABAY_API_KEY: null, PEXELS_API_KEY: null }, async () => {
    const res = mockRes();
    await findVideoHandler(mockReq({ method: 'GET' }), res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.hasPixabayKey, false);
    assert.deepEqual(body.providers, ['wikimedia-commons']);
    assert.equal(res.body.includes('PIXABAY_API_KEY='), false);
  });

  await withEnv({ PIXABAY_API_KEY: 'secret-pixabay-9f3a' }, async () => {
    const res = mockRes();
    await findVideoHandler(mockReq({ method: 'GET' }), res);
    const body = JSON.parse(res.body);
    assert.equal(body.hasPixabayKey, true);
    assert.equal(body.providers[0], 'pixabay');
    // 키 값 자체는 응답에 없어야 합니다.
    assert.equal(res.body.includes('secret-pixabay-9f3a'), false);
  });
});

test('POST /api/find-video — Pixabay 키가 있으면 클립 프록시 주소를 돌려준다', async () => {
  await withEnv({ PIXABAY_API_KEY: 'test-pixabay-key', PEXELS_API_KEY: null }, async () => {
    await withFetch(
      async (url) => {
        if (String(url).startsWith('https://pixabay.com/api/videos/')) {
          assert.equal(new URL(String(url)).searchParams.get('key'), 'test-pixabay-key');
          return jsonResponse({ total: 1, totalHits: 1, hits: [PIXABAY_PORTRAIT] });
        }
        return videoResponse();
      },
      async () => {
        const res = mockRes();
        await findVideoHandler(
          mockReq({ method: 'POST', body: { photoKo: '서울', photoEn: 'Seoul', cutIndex: 0, exclusion: [] } }),
          res,
        );
        const body = JSON.parse(res.body);
        assert.equal(res.statusCode, 200);
        assert.equal(body.ok, true);
        assert.equal(body.kind, 'video');
        assert.equal(body.provider, 'pixabay');
        assert.match(body.videoUrl, /^\/api\/video-proxy\?u=/);
        assert.equal(res.body.includes('test-pixabay-key'), false);
      },
    );
  });
});

test('POST /api/find-video — 클립이 없으면 404 no-video (화면이 사진·AI 로 폴백)', async () => {
  await withEnv({ PIXABAY_API_KEY: null, PEXELS_API_KEY: null }, async () => {
    await withFetch(
      async (url) => {
        if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse({ query: { pages: [] } });
        return videoResponse();
      },
      async () => {
        const res = mockRes();
        await findVideoHandler(mockReq({ method: 'POST', body: { photoKo: '없는장소', cutIndex: 1 } }), res);
        const body = JSON.parse(res.body);
        assert.equal(res.statusCode, 404);
        assert.equal(body.ok, false);
        assert.equal(body.error, 'no-video');
      },
    );
  });
});

test('POST /api/find-video — 무관한 클립만 있으면 404 no-relevant-video (강제로 넣지 않음)', async () => {
  await withEnv({ PIXABAY_API_KEY: 'test-pixabay-key', PEXELS_API_KEY: null }, async () => {
    await withFetch(
      async (url) => {
        if (String(url).startsWith('https://pixabay.com/api/videos/')) {
          // 영어 검색어로 묻는지 함께 검증합니다(한국어로 물으면 무관한 클립이 옵니다).
          assert.equal(new URL(String(url)).searchParams.get('q'), 'Lotte World Tower');
          assert.equal(new URL(String(url)).searchParams.get('lang'), 'en');
          return jsonResponse({ total: 2, totalHits: 2, hits: [PIXABAY_CROSSWALK, PIXABAY_YACHT] });
        }
        if (String(url).startsWith('https://commons.wikimedia.org/')) return jsonResponse({ query: { pages: [] } });
        return videoResponse();
      },
      async () => {
        const res = mockRes();
        await findVideoHandler(
          mockReq({
            method: 'POST',
            body: { photoKo: '롯데월드타워', photoEn: 'Lotte World Tower', videoEn: 'Lotte World Tower', videoKind: 'specific_landmark', cutIndex: 1 },
          }),
          res,
        );
        const body = JSON.parse(res.body);
        assert.equal(res.statusCode, 404);
        assert.equal(body.ok, false);
        assert.equal(body.error, 'no-relevant-video');
        assert.match(body.message, /실제 사진/);
        assert.equal(body.videoUrl, undefined);
      },
    );
  });
});

test('POST /api/find-video — videoEn·videoKind 로 검색어와 랜드마크 여부를 넘길 수 있다', async () => {
  await withEnv({ PIXABAY_API_KEY: 'test-pixabay-key', PEXELS_API_KEY: null }, async () => {
    await withFetch(
      async (url) => {
        if (String(url).startsWith('https://pixabay.com/api/videos/')) {
          assert.equal(new URL(String(url)).searchParams.get('q'), 'skyscraper night');
          return jsonResponse({ total: 1, totalHits: 1, hits: [{ ...PIXABAY_HIT, id: 3001, tags: 'skyscraper, city, night' }] });
        }
        return videoResponse();
      },
      async () => {
        const res = mockRes();
        await findVideoHandler(
          mockReq({ method: 'POST', body: { photoKo: '서울 야경', photoEn: 'Seoul night skyline', videoEn: 'skyscraper night', videoKind: 'generic_scene', cutIndex: 0 } }),
          res,
        );
        const body = JSON.parse(res.body);
        assert.equal(res.statusCode, 200);
        assert.equal(body.kind, 'video');
        assert.equal(body.query, 'skyscraper night');
        assert.equal(body.videoKind, 'generic_scene');
        assert.ok(body.relevance >= 1);
      },
    );
  });
});

test('GET /api/health — Pixabay·Pexels 키 유무를 불리언으로만 알려 준다', async () => {
  await withEnv({ PIXABAY_API_KEY: 'secret-pixabay-9f3a', PEXELS_API_KEY: null }, async () => {
    const res = mockRes();
    healthHandler(mockReq({ method: 'GET' }), res);
    const body = JSON.parse(res.body);
    assert.equal(body.hasPixabayKey, true);
    assert.equal(body.hasPexelsKey, false);
    assert.equal(res.body.includes('secret-pixabay-9f3a'), false);
  });
});

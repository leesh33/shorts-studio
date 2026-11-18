/**
 * lib/engine.js — 쇼츠 클론 스튜디오의 심장
 * ─────────────────────────────────────────────────────────────
 * ① parseYouTubeUrl()      : 붙여넣은 URL → videoId (shorts / watch / youtu.be / embed)
 * ② analyzeReference()     : 레퍼런스 메타데이터·대사 → '레퍼런스 블루프린트'
 * ③ generatePackage()      : 블루프린트 + 주제 한 줄 → 새 쇼츠 패키지(컷 6~8개)
 *
 * 원칙
 *   · 이 파일은 **순수 함수**만 둡니다. 네트워크 호출은 api/ 쪽에서만.
 *   · 브라우저와 서버(Vercel 함수)가 같은 모듈을 그대로 import 합니다.
 *   · 레퍼런스에서 확인하지 못한 값은 지어내지 않고 '추정'으로 표시합니다.
 *     (blueprint.evidence 에 무엇을 근거로 읽었는지 남깁니다)
 *   · 확인되지 않은 사실(숫자·금액·일정)은 문장에 넣지 않고,
 *     컷마다 `factHint`(무엇을 채워야 하는지)로 남깁니다.
 */

export const APP_NAME = '쇼츠 클론 스튜디오';

export const TONES = [
  { id: 'auto', label: '자동 감지', hint: '레퍼런스 제목·설명으로 판단' },
  { id: 'info', label: '정보·팩트폭격', hint: '짧은 단정문 + 숫자' },
  { id: 'story', label: '썰·스토리', hint: '시간순 사건 전개' },
  { id: 'review', label: '리뷰·추천', hint: '첫인상 → 비교 → 꿀팁' },
];

export const LENGTHS = [
  { sec: 30, label: '30초', cuts: 6 },
  { sec: 36, label: '36초', cuts: 7 },
  { sec: 45, label: '45초', cuts: 8 },
];

export const PRESETS = [
  { id: 'geumdan', label: '지역 정보', url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: '검단신도시 2028년 교통 호재' },
  { id: 'gukbap', label: '맛집 리뷰', url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: '우리 동네 숨은 국밥집' },
  { id: 'apptech', label: '앱테크 루틴', url: 'https://www.youtube.com/shorts/2QZPPEle9IY', topic: '30대 직장인 앱테크 루틴' },
];

/* ────────────────────────────── ① URL 파싱 ────────────────────────────── */

export function parseYouTubeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, videoId: '', kind: '', canonical: '', error: 'empty' };
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
    return { ok: true, videoId: raw, kind: 'id', canonical: `https://www.youtube.com/shorts/${raw}` };
  }
  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return { ok: false, videoId: '', kind: '', canonical: '', error: 'invalid-url' };
  }
  const host = url.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  const isYouTube = host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
  if (!isYouTube) return { ok: false, videoId: '', kind: '', canonical: '', error: 'not-youtube' };

  const parts = url.pathname.split('/').filter(Boolean);
  let videoId = '';
  let kind = '';
  if (host === 'youtu.be') {
    videoId = parts[0] || '';
    kind = 'youtu.be';
  } else if (['shorts', 'live', 'embed'].includes(parts[0])) {
    videoId = parts[1] || '';
    kind = parts[0];
  } else if (parts[0] === 'watch') {
    videoId = url.searchParams.get('v') || '';
    kind = 'watch';
  }
  if (!videoId && url.searchParams.get('v')) {
    videoId = url.searchParams.get('v');
    kind = 'watch';
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return { ok: false, videoId: '', kind: '', canonical: '', error: 'no-video-id' };
  }
  return {
    ok: true,
    videoId,
    kind: kind || 'watch',
    canonical: kind === 'shorts' ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/* ─────────────────────────── ② 레퍼런스 분석 ─────────────────────────── */

const HOOK_RULES = [
  { id: 'question', label: '질문형 훅', test: (t) => /[?？]/.test(t), why: '제목이 물음표로 끝나 답을 궁금하게 만듭니다.' },
  { id: 'warning', label: '경고·손실 회피 훅', test: (t) => /모르면|필수|절대|주의|후회|손해|위험/.test(t), why: '"모르면 손해" 계열로 손실 회피를 자극합니다.' },
  { id: 'number', label: '숫자·스펙 훅', test: (t) => /\d/.test(t), why: '구체적 숫자를 앞세워 정보 밀도를 먼저 보여줍니다.' },
  { id: 'why', label: '이유·원인 훅', test: (t) => /이유|왜|때문|원인/.test(t), why: '원인을 먼저 던져 끝까지 보게 만듭니다.' },
  { id: 'urgency', label: '지금·긴급 훅', test: (t) => /지금|오늘|이번|당장|마감/.test(t), why: '시점을 앞세워 지금 봐야 하는 이유를 만듭니다.' },
  { id: 'rank', label: '순위·리스트 훅', test: (t) => /순위|TOP|top|베스트|best|1위|3가지|5가지/.test(t), why: '목록·순위 약속으로 완주 동기를 만듭니다.' },
];

const STRATEGIES = {
  info: {
    label: '정보·팩트폭격',
    keywords: ['호재', '개발', '교통', '전망', '정책', '발표', '규제', '이슈', '뉴스', '청약', '재개발', '재건축', '신도시', '아파트', '집값', '노선', '개통', '준공', '일정', '지원금', '장려금', '세금', '대출'],
    palette: [
      ['#0B1B2B', '#1D4E6F'],
      ['#0F2233', '#2A6F8E'],
      ['#101B1F', '#3E6B5A'],
      ['#141420', '#3C4A7A'],
      ['#1B1410', '#7A4A2C'],
      ['#0E1116', '#2F3A4A'],
      ['#0B1B2B', '#1D4E6F'],
      ['#101B1F', '#3E6B5A'],
    ],
    accent: '#FFD24A',
    beats: {
      hook: [
        '{K}, {N} 판이 바뀝니다. 30초 안에 정리합니다.',
        '{K}, 아직도 모르면 손해입니다. 하나씩 짚어봅니다.',
        '{R} 사람만 아는 이야기. 지금부터 핵심만 갑니다.',
        '{K} — 결론부터 말합니다. 30초만 주세요.',
      ],
      setup: [
        '지금 {R}에서 제일 많이 나오는 말, {A}. 다들 이 얘기만 합니다.',
        '{A} 하나로 {R} 판이 흔들립니다. 이유는 단순합니다.',
        '{K}, 지나가듯 보면 놓치는 게 있습니다. 지금 짚어봅니다.',
      ],
      p1: ['첫째, 일정입니다. {N} 타임라인부터 보세요.', '첫째, 시점입니다. 언제 되는지가 제일 중요합니다.', '첫째, 숫자 하나만 기억하세요. {N}입니다.'],
      p2: ['둘째, 위치입니다. 어디에 붙는지가 갈림길입니다.', '둘째, 실제로 움직이는 건 이쪽입니다. 지도부터 보세요.', '둘째, 대상입니다. 누가 해당되는지 확인하세요.'],
      p3: ['셋째, 조건입니다. 이게 빠지면 말이 달라집니다.', '셋째, 숫자를 보세요. 금액과 비율이 핵심입니다.', '셋째, 비교입니다. 옆 동네와 같이 봐야 합니다.'],
      p4: ['넷째, 타이밍입니다. 지금 움직이는 사람과 기다리는 사람이 갈립니다.', '넷째, 순서입니다. 급하게 들어가면 손해입니다.', '넷째, 확인할 게 하나 남았습니다. 서류와 자격입니다.'],
      twist: ['다만, {A}만 보고 들어가면 위험합니다. 반대편도 보세요.', '여기서 한 가지. 기대만큼 리스크도 있습니다.', '주의, 이 부분은 사람마다 다릅니다.'],
      cta: ['자세한 건 프로필 링크에 정리했습니다.', '더 궁금하면 댓글에 주제 남겨주세요.', '저장해두면 나중에 도움 됩니다.'],
    },
    facts: {
      hook: '훅에 쓸 숫자 하나(연도·기간)를 정하세요.',
      setup: '이 주제가 "지금" 화제인 근거 한 줄(최근 발표·기사 날짜).',
      p1: '확인할 팩트: 일정·연도·단계 (출처 있는 숫자 하나).',
      p2: '확인할 팩트: 대상·위치·규모 (역명, 노선명, 면적 등).',
      p3: '확인할 팩트: 조건·금액·비율 (숫자 하나면 충분).',
      p4: '확인할 팩트: 지금 움직이면 유리한지 판단 기준 하나.',
      twist: '확인할 팩트: 반대 논거·리스크 한 가지.',
      cta: '다음 행동(링크·댓글·저장)을 한 가지로만.',
    },
  },
  review: {
    label: '리뷰·추천',
    keywords: ['맛집', '국밥', '카페', '식당', '횟집', '고기', '빵', '디저트', '야식', '후기', '추천', '가성비', '제품', '언박싱', '사용기', '먹방'],
    palette: [
      ['#1A0F0A', '#8A3B12'],
      ['#200F0C', '#B4552A'],
      ['#12100C', '#6E5A2A'],
      ['#1A0C12', '#7A2E44'],
      ['#0E1410', '#3C6B4A'],
      ['#17171C', '#4A4458'],
      ['#1A0F0A', '#8A3B12'],
      ['#200F0C', '#B4552A'],
    ],
    accent: '#FFB03A',
    beats: {
      hook: [
        '이 집, 알려지기 전에 가세요. 줄 서기 전이 답입니다.',
        '{R}에서 제일 바쁜 곳, 여기입니다. 결론부터 말합니다.',
        '{K}, 솔직하게 말해봅니다. 광고 아닙니다.',
      ],
      setup: ['{K}, 이름만 들어도 줄 섭니다. 이유가 있습니다.', '결론부터 말하면, 다시 갑니다. 다만 조건이 있습니다.', '여기, 웨이팅이 이유가 있습니다. 미리 알고 가세요.'],
      p1: ['첫인상, 다른 집과 다릅니다. 사진보다 실물이 낫습니다.', '첫 모금에서 갈립니다. 여기서 다들 조용해집니다.', '첫 접시부터 다릅니다. 양이 아니라 온도입니다.'],
      p2: ['가격 보면 더 놀랍니다. 이 정도면 가성비입니다.', '메뉴판이 단순합니다. 대표 메뉴 하나만 보세요.', '양이 이 정도입니다. 둘이 먹어도 남습니다.'],
      p3: ['웨이팅은 이렇게 피하세요. 오픈 직후가 답입니다.', '주차는 이쪽이 편합니다. 미리 확인하세요.', '이 시간대가 제일 한산합니다. 기억해두세요.'],
      p4: ['메뉴는 이렇게 고르세요. 처음엔 대표 메뉴만.', '같이 가면 이 조합이 좋습니다. 둘이서 딱입니다.', '포장도 됩니다. 다만 시간이 걸립니다.'],
      twist: ['다만, 이건 미리 알고 가세요. 호불호가 갈립니다.', '기대를 너무 키우면 실망합니다. 솔직히 말했습니다.', '아쉬운 점도 있습니다. 그래도 다시 갑니다.'],
      cta: ['위치랑 영업시간, 댓글에 남겼습니다.', '저장해두고 다음 주말에 가보세요.', '더 궁금하면 댓글 주세요.'],
    },
    facts: {
      hook: '가게 이름·동네를 첫 3초에 넣으세요.',
      setup: '한 줄 결론(재방문 의사·별점 느낌).',
      p1: '확인할 팩트: 대표 메뉴 하나 + 맛 특징 한 단어.',
      p2: '확인할 팩트: 가격(실제 메뉴판 기준).',
      p3: '확인할 팩트: 영업시간·브레이크타임·주차.',
      p4: '확인할 팩트: 추천 메뉴 조합·포장 여부.',
      twist: '확인할 팩트: 아쉬운 점 한 가지(솔직하게).',
      cta: '위치·영업시간은 댓글 고정.',
    },
  },
  howto: {
    label: '방법·루틴',
    keywords: ['루틴', '방법', '꿀팁', '노하우', '앱테크', '절약', '세팅', '하는법', '습관', '공부', '운동', '다이어트', '재테크', '정리'],
    palette: [
      ['#0C1410', '#1F6B4A'],
      ['#0A1418', '#1D6B7A'],
      ['#101018', '#3A3F7A'],
      ['#161009', '#7A5A20'],
      ['#101418', '#2C4A5A'],
      ['#140F18', '#4A2E6B'],
      ['#0C1410', '#1F6B4A'],
      ['#0A1418', '#1D6B7A'],
    ],
    accent: '#5CE1A0',
    beats: {
      hook: [
        '{K}, 아직도 이렇게 하면 손해입니다. 3가지만 바꾸세요.',
        '이 루틴, 30일이면 달라집니다. 오늘부터 시작합니다.',
        '{K} — 하루 10분이면 됩니다. 방법은 단순합니다.',
      ],
      setup: ['{K}, 순서만 바꿔도 결과가 다릅니다. 대부분 첫 단계에서 틀립니다.', '돈 안 들고 시간만 쓰면 됩니다. 대신 순서가 중요합니다.', '지금 방식으로는 두 배 걸립니다. 이유는 아래에 있습니다.'],
      p1: ['첫째, 순서를 바꾸세요. 기록이 먼저입니다.', '첫 단계는 측정입니다. 하루치를 먼저 재보세요.', '첫째, 딱 하나만 정하세요. 욕심내면 무너집니다.'],
      p2: ['둘째, 자동으로 돌려놓으세요. 손이 안 가야 오래갑니다.', '둘째, 하루 10분만. 더 하면 다음 날 못 합니다.', '둘째는 반복 장치입니다. 알림 하나면 충분합니다.'],
      p3: ['셋째, 확인은 주 1회만. 매일 보면 지칩니다.', '셋째, 이건 빼세요. 안 해도 되는 일이 많습니다.', '셋째는 점검입니다. 숫자로만 확인하세요.'],
      p4: ['넷째, 기록하세요. 한 줄이면 충분합니다.', '넷째, 일주일에 한 번만 돌아보세요. 그게 전부입니다.', '넷째, 같이 할 사람을 찾으세요. 혼자면 오래 못 갑니다.'],
      twist: ['이거 모르면 효과가 반으로 줄어듭니다. 첫 주는 참으세요.', '다만, 첫 주는 눈에 안 띕니다. 그래도 해야 합니다.', '사람마다 맞는 속도가 다릅니다. 비교하지 마세요.'],
      cta: ['오늘부터 바로 해보세요.', '저장해두고 하나씩 지워보세요.', '어디서 막히는지 댓글로 알려주세요.'],
    },
    facts: {
      hook: '얻는 것(시간·금액)을 숫자 하나로.',
      setup: '지금 방식의 문제 한 줄.',
      p1: '확인할 팩트: 첫 단계에 필요한 도구·앱 이름.',
      p2: '확인할 팩트: 소요 시간·주기(실측값).',
      p3: '확인할 팩트: 빼야 할 것 하나.',
      p4: '확인할 팩트: 기록·점검 방법.',
      twist: '확인할 팩트: 흔한 실패 이유.',
      cta: '다음 행동 한 가지.',
    },
  },
  story: {
    label: '썰·스토리',
    keywords: ['썰', '실화', '사연', '경험', '이야기', '사건', '당했', '겪었', '후기담', '논란'],
    palette: [
      ['#120E14', '#4A2244'],
      ['#0E1218', '#2A3E5A'],
      ['#15100C', '#6B3A1F'],
      ['#101410', '#2F5A3A'],
      ['#141018', '#3E2A5A'],
      ['#121016', '#40384A'],
      ['#120E14', '#4A2244'],
      ['#15100C', '#6B3A1F'],
    ],
    accent: '#FF7A8A',
    beats: {
      hook: ['그날, {R}에서 일이 터졌습니다. 지금도 그 장면이 생각납니다.', '처음엔 그냥 {K}인 줄 알았습니다. 아무도 예상 못 했습니다.', '{K} — 이건 실화입니다. 끝까지 들어보세요.'],
      setup: ['그때는 몰랐습니다. 평범한 하루였습니다.', '아무도 예상 못 했습니다. 다들 웃고 있었습니다.', '처음엔 그냥 지나칠 뻔했습니다.'],
      p1: ['그런데 다음 날, 연락이 왔습니다. 첫 신호는 사소했습니다.', '한 시간 뒤, 상황이 바뀌었습니다.', '그 말을 듣고 손이 멈췄습니다.'],
      p2: ['여기서부터 이상했습니다. 설명이 안 됐습니다.', '그제야 눈에 들어왔습니다. 이미 늦었습니다.', '돌이킬 수 없는 지점이었습니다.'],
      p3: ['결국 이렇게 됐습니다. 돌아보면 답은 단순했습니다.', '정리하고 나니 허무했습니다. 원인은 하나였습니다.', '끝은 조용했습니다. 아무 일도 없던 것처럼.'],
      p4: ['그리고 한 사람이 더 있었습니다. 그 사람은 달랐습니다.', '그때 옆에서 본 게 있습니다. 아직도 기억납니다.', '결정적인 건 타이밍이었습니다. 하루 차이였습니다.'],
      twist: ['다만, 이건 제 경우입니다. 그때 알았더라면 달랐을 겁니다.', '지금도 그 장면이 생각납니다. 같은 일이 반복됩니다.', '그때 배운 건 하나입니다. 확인하고 움직이세요.'],
      cta: ['여러분은 어떻게 하셨을까요? 댓글로 알려주세요.', '비슷한 경험 있으면 댓글로.', '다음 편에서 이어집니다. 구독해두세요.'],
    },
    facts: {
      hook: '장소·시간을 첫 문장에.',
      setup: '사건 전 상황 한 줄.',
      p1: '확인할 팩트: 결정적 장면 하나(구체적 행동).',
      p2: '확인할 팩트: 반전의 계기.',
      p3: '확인할 팩트: 결과(사실 그대로).',
      p4: '확인할 팩트: 결정적 하루의 디테일.',
      twist: '확인할 팩트: 그때 느낀 점 한 줄.',
      cta: '질문 하나로 끝내기.',
    },
  },
  general: {
    label: '정보·팩트폭격',
    keywords: [],
    palette: [
      ['#101014', '#2A3340'],
      ['#141018', '#3A2E4A'],
      ['#0F1416', '#2C4A4A'],
      ['#16120E', '#4A3A20'],
      ['#101418', '#2C3E5A'],
      ['#141414', '#3A3A3A'],
      ['#101014', '#2A3340'],
      ['#0F1416', '#2C4A4A'],
    ],
    accent: '#FFD24A',
    beats: {
      hook: ['{K}, 이거 모르면 시간 낭비입니다. 30초로 정리합니다.', '{K} — 핵심만 뽑았습니다. 결론부터 갑니다.', '{K}, 다들 헷갈려 합니다. 한 번에 정리합니다.'],
      setup: ['먼저 결론부터. 핵심은 세 가지입니다.', '많이 헷갈리는 부분입니다. 순서대로 갑니다.', '기준만 알면 판단이 빨라집니다.'],
      p1: ['첫째, 이겁니다. 제일 중요한 기준입니다.', '첫 번째 포인트. 여기서 대부분 갈립니다.', '먼저 이걸 보세요. 나머지는 그다음입니다.'],
      p2: ['둘째, 여기서 갈립니다. 조건을 보세요.', '두 번째 포인트. 숫자로 비교하면 명확합니다.', '두 번째는 조건입니다. 해당되는지 확인하세요.'],
      p3: ['셋째, 이건 다릅니다. 같이 보면 안 됩니다.', '세 번째는 주의점입니다. 이건 빼세요.', '셋째, 예외를 확인하세요.'],
      p4: ['넷째, 예외를 확인하세요. 여기서 실수가 나옵니다.', '넷째, 순서대로 하면 됩니다. 외울 필요 없습니다.', '넷째, 한 가지만 더. 이건 꼭 기억하세요.'],
      twist: ['다만, 이건 상황에 따라 다릅니다.', '여기서 주의할 점. 사람마다 답이 다릅니다.', '반대 경우도 있습니다. 무조건은 아닙니다.'],
      cta: ['자세한 건 댓글에 정리했습니다.', '저장해두면 한 번은 쓰입니다.', '궁금한 건 댓글로 남겨주세요.'],
    },
    facts: {
      hook: '주제를 한 단어로 좁히세요.',
      setup: '결론 한 줄.',
      p1: '확인할 팩트: 핵심 개념 하나.',
      p2: '확인할 팩트: 비교 기준 하나.',
      p3: '확인할 팩트: 주의점 하나.',
      p4: '확인할 팩트: 예외 조건 하나.',
      twist: '확인할 팩트: 예외 상황.',
      cta: '다음 행동 한 가지.',
    },
  },
};

export const STRATEGY_INFO = Object.fromEntries(
  Object.entries(STRATEGIES).map(([id, s]) => [id, { id, label: s.label, accent: s.accent }]),
);

export function detectStrategy(topic, tone, referenceTitle = '') {
  if (tone === 'review' || tone === 'story' || tone === 'info') return tone;
  const hay = `${topic} ${referenceTitle}`;
  const scored = Object.entries(STRATEGIES)
    .filter(([id]) => id !== 'general')
    .map(([id, s]) => ({ id, score: s.keywords.reduce((n, k) => (hay.includes(k) ? n + 1 : n), 0) }))
    .sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0].id : 'general';
}

/* ── 문장·리듬 계산 ── */

export function splitSentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?。！？…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.replace(/[^\p{L}\p{N}]/gu, '').length > 1);
}

export function countEojeol(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

const NON_CONTENT = /^(구독|좋아요|공유|알림|설명|더보기|연락|문의|광고|제휴|인스타|블로그|카톡|채널|#)/;

export function pickScriptLines(description, max = 8) {
  return splitSentences(description)
    .filter((s) => !NON_CONTENT.test(s))
    .filter((s) => countChars(s) >= 6 && countChars(s) <= 90)
    .slice(0, max);
}

export function analyzeReference(input = {}) {
  const url = String(input.url || '');
  const parsed = parseYouTubeUrl(url);
  const title = String(input.title || '').trim();
  const description = String(input.description || '').trim();
  const referenceText = String(input.referenceText || '').trim();
  const durationSec = Number(input.durationSec) || 0;
  const tags = Array.isArray(input.tags) ? input.tags.slice(0, 12) : [];
  const fetchedBy = input.fetchedBy || (title ? 'metadata' : 'none');

  const evidence = [];
  const probe = referenceText ? `${title} ${referenceText.slice(0, 120)}` : title;
  const hookHit = probe ? HOOK_RULES.find((r) => r.test(probe)) : null;
  const hook = hookHit
    ? { type: hookHit.id, label: hookHit.label, sample: title.slice(0, 80), why: hookHit.why }
    : { type: 'curiosity', label: '호기심 갭 훅', sample: title.slice(0, 80), why: '제목에 뚜렷한 장치가 없어 결론을 미루는 방식으로 읽었습니다.' };
  evidence.push(title ? `제목에서 읽은 훅: ${hook.label}` : '제목을 가져오지 못해 기본 훅(호기심 갭)으로 두었습니다.');

  let durationKnown = durationSec > 0;
  let dur = durationKnown ? durationSec : 0;
  if (!durationKnown && referenceText) {
    dur = Math.max(12, Math.round(countChars(referenceText) / 6.8));
    evidence.push(`길이를 못 받아 대사 ${countChars(referenceText)}자 ÷ 6.8자/초 = 약 ${dur}초로 추정했습니다.`);
  }

  let rhythm;
  if (referenceText) {
    const sentences = splitSentences(referenceText);
    const eojeol = countEojeol(referenceText);
    const chars = countChars(referenceText);
    const wpm = dur > 0 ? Math.round((eojeol / dur) * 60) : 0;
    const avgSentenceChars = sentences.length ? Math.round(chars / sentences.length) : 0;
    rhythm = {
      measured: true,
      sentences: sentences.length,
      avgSentenceChars,
      wpm,
      charsPerSec: dur > 0 ? Number((chars / dur).toFixed(1)) : 0,
      style: wpm >= 300 ? '아주 빠름 (숏츠 상위 템포)' : wpm >= 240 ? '빠름' : '보통',
      firstSentence: sentences[0] || '',
    };
    evidence.push(`대사 ${sentences.length}문장 · 평균 ${avgSentenceChars}자 · 분당 ${wpm}어절 → '${rhythm.style}'으로 읽었습니다.`);
  } else {
    rhythm = { measured: false, sentences: 0, avgSentenceChars: 15, wpm: 280, charsPerSec: 7.2, style: '빠름 (숏츠 표준 템포 가정)', firstSentence: '' };
    evidence.push('대사(자막)를 못 가져와 숏츠 표준 템포(분당 280어절 · 문장 15자)를 기준값으로 썼습니다.');
  }

  let cutCount = 7;
  if (dur > 0) cutCount = Math.min(8, Math.max(5, Math.round(dur / 5.0)));
  evidence.push(dur > 0 ? `길이 ${dur}초 ÷ 컷당 약 5초 → 컷 ${cutCount}개로 추정했습니다.` : '길이를 몰라 컷 7개(36초)를 기본값으로 두었습니다.');

  const strategy = detectStrategy(String(input.topic || ''), 'auto', title);
  const palette = STRATEGIES[strategy].palette;

  const subtitle = {
    style: rhythm.avgSentenceChars <= 12 ? '1줄 굵은 자막 (짧은 문장)' : '2줄 굵은 자막',
    maxCharsPerLine: rhythm.avgSentenceChars <= 12 ? 14 : 18,
    position: '하단 1/3 · 세이프존 안쪽',
    emphasis: '숫자·고유명사만 강조색',
  };

  const pacing = {
    tempo: rhythm.wpm >= 300 ? 1.25 : rhythm.wpm >= 240 ? 1.21 : 1.18,
    deadAir: '없음 (컷 사이 무음 금지)',
    brollPerCut: cutCount >= 7 ? 2 : 1,
    cutSecAvg: dur > 0 ? Number((dur / cutCount).toFixed(1)) : 5,
  };

  const hashtags = [...tags, ...[...`${title} ${description}`.matchAll(/#([^\s#]{2,20})/g)].map((m) => m[1])]
    .filter((t, i, arr) => t && arr.indexOf(t) === i)
    .slice(0, 8);

  return {
    source: {
      url: parsed.canonical || url,
      videoId: parsed.videoId,
      kind: parsed.kind,
      title,
      channel: String(input.channel || ''),
      thumbnail: String(input.thumbnail || ''),
      durationSec: dur,
      durationKnown,
      description: description.slice(0, 600),
      hashtags,
      fetchedBy,
    },
    hook,
    rhythm,
    cuts: { count: cutCount, avgSec: pacing.cutSecAvg },
    subtitle,
    pacing,
    visual: {
      palette,
      mood: strategy === 'review' ? '따뜻한 실내 조명 · 클로즈업' : '차분한 저채도 · 사이드 라이트',
      shotStyle: '35mm 느낌 · 얕은 심도 · 실사 사진 톤',
    },
    strategy,
    evidence,
  };
}

/* ─────────────────────────── ③ 새 쇼츠 만들기 ─────────────────────────── */

const PARTICLES = /(은|는|이|가|을|를|의|에|와|과|도|만|로|으로|에서|에게|부터|까지|처럼|보다)$/;
const PLACE_TAIL = /(동|구|시|군|읍|면|역|로|길|신도시|아파트|단지|타워|몰|마을)$/;

export function tokenizeTopic(topic) {
  return String(topic || '')
    .replace(/[\[\]{}"“”'’]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[,.!?]+$/, ''));
}

export function stripParticle(word) {
  const w = String(word || '');
  if (w.length <= 2) return w;
  return w.replace(PARTICLES, '');
}

export function findRegion(words) {
  const hit = words.find((w) => PLACE_TAIL.test(stripParticle(w)));
  return hit ? stripParticle(hit) : '';
}

export function findNumber(topic) {
  const m = String(topic || '').match(/(\d{2,4}\s?년|\d+\s?(?:개월|분|초|원|개|명|곳|평|%|대|배|시간))/);
  return m ? m[0].replace(/\s+/g, '') : '';
}

export function keyPhrase(topic) {
  const words = tokenizeTopic(topic).map(stripParticle).filter((w) => w.length >= 2);
  if (!words.length) return String(topic || '').trim().slice(0, 20);
  const sorted = [...words].sort((a, b) => b.length - a.length).slice(0, 2);
  return words.filter((w) => sorted.includes(w)).join(' ').slice(0, 24);
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** {N} 이 필요한 템플릿은 숫자가 없으면 건너뛰고 고릅니다. */
function pickTemplate(list, seed, offset, hasNumber) {
  const usable = (list || []).filter((t) => hasNumber || !t.includes('{N}'));
  const pool = usable.length ? usable : list || [];
  if (!pool.length) return '';
  return pool[(seed + offset) % pool.length];
}

function fillTemplate(tpl, ctx) {
  return String(tpl || '')
    .replace(/\{T\}/g, ctx.T)
    .replace(/\{K\}/g, ctx.K)
    .replace(/\{R\}/g, ctx.R)
    .replace(/\{N\}/g, ctx.N)
    .replace(/\{A\}/g, ctx.A)
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.]\s*/, '')
    .trim();
}

export function markEmphasis(text, extraCandidates = []) {
  const src = String(text || '');
  if (!src) return '';
  const numberRe = /(\d{2,4}\s?년|\d+\s?(?:개월|분|초|원|개|명|곳|평|%|대|배|시간))/;
  const numMatch = src.match(numberRe);
  if (numMatch) return src.replace(numMatch[0], `[${numMatch[0]}]`);
  const candidates = [...extraCandidates].filter((c) => c && c.length >= 2).sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    if (src.includes(c)) return src.replace(c, `[${c}]`);
  }
  return src;
}

/** 강조 후보가 문장에 없으면 가장 긴 내용어를 강조합니다. (자막마다 강조 1개 보장) */
export function ensureEmphasis(text, extraCandidates = []) {
  const marked = markEmphasis(text, extraCandidates);
  if (marked !== String(text || '')) return marked;
  const words = String(text || '')
    .replace(/[,.!?…"'()]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[,.!?…"'()]/g, ''))
    .filter((w) => w.length >= 2)
    .filter((w) => !/(서|면|지|고|며|은|는|이|가|을|를|과|와|로|만|라|기|해|요|다|까|죠|네|랑|도|에|께|부터|까지|보다|처럼|만큼|조차|마저|대로|뿐)$/.test(w))
    .filter((w) => !/(니다|습니다|하세요|세요)$/.test(w));
  if (!words.length) return marked;
  const target = words.sort((a, b) => b.length - a.length)[0];
  return marked.replace(target, `[${target}]`);
}

export function stripMarkup(text) {
  return String(text || '').replace(/\[([^\]]*)\]/g, '$1');
}

export function emphasisWords(text) {
  return [...String(text || '').matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
}

const CAMERAS = [
  '천천히 푸시인 (1.0 → 1.08배)',
  '살짝 패닝 좌→우',
  '퀵 줌아웃으로 시작',
  '핸드헬드 미세 흔들림',
  '탑다운에서 천천히 내려오기',
  '클로즈업 고정 + 미세 줌',
  '와이드에서 피사체로 슬라이드',
  '디테일 클로즈업 + 느린 회전',
];

const SHOT_DIRECTIONS = {
  info: {
    hook: '주제가 보이는 대표 장면(간판·현장·화면) 와이드',
    setup: '지도·문서·표를 손으로 가리키는 클로즈업',
    p1: '현장 전경 · 사람들 통행',
    p2: '디테일 클로즈업(표지판·숫자·구조물)',
    p3: '비교 컷(전/후, A/B 나란히)',
    p4: '지도·타임라인 위 손가락',
    twist: '한 발 물러난 와이드 · 해질녘',
    cta: '인물 미디엄샷 · 카메라 정면',
  },
  review: {
    hook: '가게 외관 또는 대표 메뉴 클로즈업',
    setup: '주방 · 사장님 손 클로즈업',
    p1: '음식 담기는 순간 · 김 올라오는 클로즈업',
    p2: '메뉴판 · 가격표 클로즈업',
    p3: '매장 안 손님 시점',
    p4: '여러 접시 나란히 · 테이블 와이드',
    twist: '한 접시 남은 테이블 · 톤 다운',
    cta: '가게 앞 간판 · 인물 아웃포커스',
  },
  howto: {
    hook: '휴대폰 화면 또는 책상 위 도구 클로즈업',
    setup: '손이 도구를 만지는 클로즈업',
    p1: '1단계 실제 수행 장면(손 중심)',
    p2: '2단계 반복 장면 · 타임랩스 느낌',
    p3: '결과 화면/수치 클로즈업',
    p4: '노트에 한 줄 적는 손',
    twist: '멈춘 손 · 생각하는 인물 실루엣',
    cta: '정리된 화면 · 체크 표시',
  },
  story: {
    hook: '장소 전경 · 비 오는/해질녘 분위기',
    setup: '인물 뒷모습 · 걸어가는 장면',
    p1: '결정적 순간의 손·표정 클로즈업',
    p2: '휴대폰 알림 화면 클로즈업',
    p3: '텅 빈 공간 · 정적',
    p4: '인물 옆모습 · 창가',
    twist: '창밖 · 흐릿한 인물',
    cta: '인물 정면 미디엄샷',
  },
  general: {
    hook: '주제 대표 장면 와이드',
    setup: '디테일 클로즈업',
    p1: '첫 번째 포인트 장면',
    p2: '두 번째 포인트 장면',
    p3: '세 번째 포인트 장면',
    p4: '네 번째 포인트 장면',
    twist: '톤이 바뀌는 장면',
    cta: '인물 또는 로고 미디엄샷',
  },
};

const BEAT_LABELS = { hook: '훅 (3초)', setup: '맥락', p1: '포인트 1', p2: '포인트 2', p3: '포인트 3', p4: '포인트 4', twist: '반전·주의', cta: '마무리 CTA' };

export function splitFacts(text, count) {
  const lines = splitSentences(text);
  if (!lines.length || count <= 0) return [];
  const out = [];
  const per = Math.max(1, Math.floor(lines.length / count));
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const take = i === count - 1 ? lines.length - cursor : per;
    out.push(lines.slice(cursor, cursor + take).join(' '));
    cursor += take;
  }
  return out;
}

export function punchify(text, maxChars = 30) {
  const clean = String(text || '').replace(/\s+/g, ' ').replace(/[“”"']/g, '').trim();
  if (countChars(clean) <= maxChars) return clean;
  const words = clean.split(' ');
  let out = '';
  for (const w of words) {
    if (countChars(`${out} ${w}`) > maxChars) break;
    out = out ? `${out} ${w}` : w;
  }
  return `${(out || clean.slice(0, maxChars)).replace(/[,·]$/, '')}…`;
}

const CHARS_PER_SEC = 6.2;

function durationFor(narration, min = 2.6, max = 7.0) {
  return Math.min(max, Math.max(min, countChars(narration) / CHARS_PER_SEC));
}

export function generatePackage(input = {}) {
  const topic = String(input.topic || '').trim();
  const tone = TONES.some((t) => t.id === input.tone) ? input.tone : 'auto';
  const blueprint = input.blueprint || analyzeReference({ url: input.url || '' });
  const facts = String(input.facts || '').trim();
  const strategyId = input.strategy || detectStrategy(topic, tone, blueprint?.source?.title || '');
  const strategy = STRATEGIES[strategyId] || STRATEGIES.general;
  const seed = hashSeed(`${topic}|${tone}|${strategyId}|${blueprint?.source?.videoId || ''}`);

  const targetLen = LENGTHS.some((l) => l.sec === Number(input.length))
    ? Number(input.length)
    : Math.min(45, Math.max(30, blueprint?.source?.durationSec || 36));

  const baseCuts = targetLen >= 44 ? 8 : targetLen <= 30 ? 6 : 7;
  const cutCount = Math.min(8, Math.max(6, Number(input.cutCount) || baseCuts));

  const beatOrder =
    cutCount >= 8
      ? ['hook', 'setup', 'p1', 'p2', 'p3', 'p4', 'twist', 'cta']
      : cutCount === 7
        ? ['hook', 'setup', 'p1', 'p2', 'p3', 'twist', 'cta']
        : ['hook', 'setup', 'p1', 'p2', 'p3', 'cta'];
  const words = tokenizeTopic(topic);
  const num = findNumber(topic);
  const ctx = {
    T: topic.slice(0, 26),
    K: keyPhrase(topic),
    R: findRegion(words) || '여기',
    N: num || '지금',
    A: (words.find((w) => strategy.keywords.includes(stripParticle(w))) || keyPhrase(topic)).replace(PARTICLES, ''),
  };
  const hasNumber = Boolean(num);

  const factChunks = facts ? splitFacts(facts, beatOrder.length) : [];
  const narrationByBeat = {};
  beatOrder.forEach((beat, i) => {
    if (facts) {
      if (beat === 'hook' || beat === 'cta') {
        narrationByBeat[beat] = fillTemplate(pickTemplate(strategy.beats[beat], seed, beat === 'hook' ? 0 : 3, hasNumber), ctx);
        return;
      }
      const idx = Math.min(factChunks.length - 1, Math.max(0, i - 1));
      const chunk = factChunks[idx] || '';
      narrationByBeat[beat] = chunk ? punchify(chunk, 40) : fillTemplate(pickTemplate(strategy.beats[beat], seed, i * 5, hasNumber), ctx);
      return;
    }
    narrationByBeat[beat] = fillTemplate(pickTemplate(strategy.beats[beat], seed, i * 7, hasNumber), ctx);
  });

  // 시간 배분: 훅 고정 → 나머지는 문장 길이 비례, 총 길이는 목표에 맞춰 스케일
  const hookSec = cutCount >= 7 ? 2.8 : 3.0;
  const natural = beatOrder.map((beat, i) => (i === 0 ? hookSec : durationFor(narrationByBeat[beat])));
  const naturalTotal = natural.reduce((a, b) => a + b, 0);
  const scale = Math.min(1.42, Math.max(0.82, targetLen / naturalTotal));

  let cursor = 0;
  const cuts = beatOrder.map((beat, i) => {
    const dur = i === 0 ? hookSec : Number((natural[i] * scale).toFixed(2));
    const start = Number(cursor.toFixed(2));
    const end = Number((cursor + dur).toFixed(2));
    cursor = end;
    const narration = narrationByBeat[beat];
    const emphasisCandidates = [ctx.K, ctx.R, ctx.A, ...strategy.keywords.filter((k) => narration.includes(k))];
    const subtitle = ensureEmphasis(narration, emphasisCandidates);
    const palette = strategy.palette[i % strategy.palette.length];
    return {
      id: `cut-${i + 1}`,
      index: i,
      beat,
      label: BEAT_LABELS[beat],
      start,
      end,
      duration: Number((end - start).toFixed(2)),
      narration,
      subtitle,
      bigWord: emphasisWords(subtitle)[0] || ctx.K,
      visualKo: `${SHOT_DIRECTIONS[strategyId]?.[beat] || SHOT_DIRECTIONS.general[beat]} — ${ctx.K} 맥락으로 촬영`,
      visualPrompt: buildVisualPrompt({ beat, ctx, strategyId, palette }),
      camera: CAMERAS[(seed + i) % CAMERAS.length],
      mood: { from: palette[0], to: palette[1], name: moodName(strategyId, beat) },
      factHint: strategy.facts[beat],
      sound: i === 0 ? '훅과 동시에 첫 컷 전환 · 임팩트 SFX 1회' : '내레이션 끊김 없이 다음 컷으로 (무음 금지)',
      imageUrl: '',
    };
  });

  const totalSec = Number((cuts[cuts.length - 1]?.end || 0).toFixed(2));
  const titles = buildTitles({ topic, ctx, strategyId, blueprint, seed });

  return {
    meta: {
      topic,
      tone,
      toneLabel: TONES.find((t) => t.id === tone)?.label || '자동',
      strategy: strategyId,
      strategyLabel: strategy.label,
      length: targetLen,
      totalSec,
      cutCount,
      seed,
      generatedAt: new Date().toISOString(),
      factSource: facts ? '붙여넣은 참고 자료' : '기본 뼈대(팩트는 비어 있음)',
      usedFacts: facts ? factChunks.filter(Boolean).length : 0,
    },
    reference: blueprint,
    titles,
    cuts,
    tts: {
      rate: Number(Math.min(1.3, Math.max(1.16, blueprint?.pacing?.tempo || 1.21)).toFixed(2)),
      pitch: 0.98,
      voice: 'ko-KR',
      chunks: cuts.flatMap((c) => chunkText(stripMarkup(c.subtitle), 28).map((text) => ({ cutId: c.id, start: c.start, end: c.end, text }))),
    },
    hashtags: buildHashtags({ topic, strategyId, blueprint }),
    copy: {
      script: buildScriptText({ topic, cuts, titles, blueprint }),
      prompts: cuts.map((c) => `#${c.index + 1} ${c.label} (${c.start}s–${c.end}s)\n${c.visualKo}\nEN: ${c.visualPrompt}`).join('\n\n'),
      subtitles: buildSrt(cuts),
    },
    next: {
      imageApi: '컷별 visualPrompt를 이미지 생성 API(예: Gemini 이미지 · 미드저니)에 넣으면 실사 톤 장면을 만들 수 있습니다.',
      videoRender: '렌더는 ffmpeg에 이 JSON을 넘기는 단계로 붙일 수 있습니다(이 프로토타입에는 렌더 서버가 없습니다).',
      voice: '지금은 브라우저 음성(Web Speech) 미리듣기만 합니다. 실제 TTS는 별도 엔진이 필요합니다.',
    },
  };
}

function moodName(strategyId, beat) {
  const base = { info: '차분한 다큐 톤', review: '따뜻한 실내 톤', howto: '깔끔한 데스크 톤', story: '필름 같은 저채도', general: '뉴트럴 톤' }[strategyId] || '뉴트럴 톤';
  if (beat === 'twist') return `${base} · 톤 다운`;
  if (beat === 'cta') return `${base} · 밝게 마무리`;
  if (beat === 'hook') return `${base} · 대비 강하게`;
  return base;
}

function buildVisualPrompt({ beat, ctx, strategyId, palette }) {
  const scene = SHOT_DIRECTIONS[strategyId]?.[beat] || SHOT_DIRECTIONS.general[beat];
  const light = {
    info: 'late afternoon sunlight from the side, cool shadows',
    review: 'warm tungsten interior light, soft window light',
    howto: 'clean soft top light, minimal desk setup',
    story: 'overcast dusk light, muted colors, slight film grain',
    general: 'natural daylight, soft contrast',
  }[strategyId] || 'natural daylight';
  const grade = {
    info: 'teal and amber color grade, realistic skin tones',
    review: 'warm amber grade, appetizing highlights',
    howto: 'neutral clean grade, crisp whites',
    story: 'desaturated cinematic grade',
    general: 'natural grade',
  }[strategyId] || 'natural grade';
  return [
    `Photoreal editorial photograph, vertical 9:16, Korean setting`,
    `subject: ${ctx.K} (${ctx.T})`,
    `scene: ${scene}`,
    'real location details, documentary realism, no cartoon, no illustration, no 3D render',
    light,
    'shot on 35mm, f/2.0, shallow depth of field, subtle grain',
    grade,
    `palette: ${palette[0]} to ${palette[1]}`,
    'no text, no watermark, no logo, no distorted hands',
  ].join(', ');
}

function buildTitles({ topic, ctx, strategyId, blueprint, seed }) {
  const hookType = blueprint?.hook?.type || 'curiosity';
  const tail = { info: ['30초 정리', '핵심 3가지', '지금 봐야 합니다'], review: ['솔직 후기', '내돈내산', '3분 정리'], howto: ['오늘부터', '3단계', '10분 루틴'], story: ['실화', '그날 일어난 일', '결말 포함'], general: ['30초 정리', '핵심만', '한 번에 정리'] }[strategyId] || ['30초 정리'];
  const t1 = `${ctx.K} — ${tail[(seed + 0) % tail.length]}`;
  const t2 =
    ctx.R === '여기'
      ? `${ctx.K}, ${hookType === 'number' ? '숫자로 보면 이렇습니다' : '다들 이 얘기만 합니다'}`
      : `${ctx.R} ${['사람만 아는 이야기', '여기서 갈립니다', '지금 상황 정리'][(seed + 2) % 3]}`;
  const t3 = topic.length <= 40 ? `${topic} | ${tail[(seed + 1) % tail.length]}` : `${ctx.K} | ${tail[(seed + 1) % tail.length]}`;
  const unique = [...new Set([t1, t2, t3])].slice(0, 3);
  const whys = ['키워드 + 결론 약속 — 숏츠 검색·추천에 유리', '지역·대상 타깃을 좁혀 클릭률을 올립니다', '주제 원문 유지 — 검색 유입용'];
  return unique.map((text, i) => ({ text: text.slice(0, 60), why: whys[i] || whys[2] }));
}

function buildHashtags({ topic, strategyId, blueprint }) {
  const base = { info: ['부동산', '지역정보', '교통호재'], review: ['맛집', '숨은맛집', '내돈내산'], howto: ['앱테크', '루틴', '꿀팁'], story: ['썰', '실화', '사연'], general: ['정보', '정리', '숏츠'] }[strategyId] || ['정보', '정리'];
  const fromTopic = tokenizeTopic(topic).map(stripParticle).filter((w) => w.length >= 2);
  const fromRef = Array.isArray(blueprint?.source?.hashtags) ? blueprint.source.hashtags : [];
  return [...new Set([...fromTopic, ...base, ...fromRef])].slice(0, 10);
}

export function chunkText(text, max = 28) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  let buf = '';
  for (const w of words) {
    if (countChars(`${buf} ${w}`) > max && buf) {
      out.push(buf);
      buf = w;
    } else {
      buf = buf ? `${buf} ${w}` : w;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function buildScriptText({ topic, cuts, titles, blueprint }) {
  const head = [
    `# ${titles?.[0]?.text || topic}`,
    `레퍼런스: ${blueprint?.source?.title || '(제목 없음)'} · ${blueprint?.source?.url || ''}`,
    `총 ${cuts[cuts.length - 1]?.end || 0}초 · 컷 ${cuts.length}개 · 템포 ${blueprint?.pacing?.tempo || 1.21}x`,
    '',
  ];
  const body = cuts.map(
    (c) => `[${c.index + 1}] ${c.start}s–${c.end}s · ${c.label}\n내레이션: ${c.narration}\n자막: ${c.subtitle}\n연출: ${c.visualKo}\n카메라: ${c.camera}\n`,
  );
  return [...head, ...body].join('\n');
}

export function buildSrt(cuts) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ts = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = (s % 60).toFixed(3).padStart(6, '0');
    return `${pad(h)}:${pad(m)}:${rest.replace('.', ',')}`;
  };
  return cuts.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${stripMarkup(c.subtitle)}\n`).join('\n');
}

# TakeOne(테이크원) — AI 쇼츠 스튜디오

바이럴 쇼츠의 **성공 공식(Viral DNA)** 을 읽어서, 내 주제로 새 숏폼 **대본 + 컷별 AI 장면 + 9:16 영상 파일**까지 만드는 웹 앱.

- 라이브: https://shorts-studio-navy.vercel.app
- 스택: 정적 HTML/Tailwind(빌드된 CSS 커밋) + Vercel Serverless Functions 6개
  (`/api/analyze-and-generate` · `/api/generate-image` · `/api/find-video` · `/api/video-proxy` · `/api/tts` · `/api/health`)
- 화면: **TakeOne** 디자인(#090D19 · violet→blue 그라데이션) 유지

## 화면 흐름

1. **Create Your Remix** — `01. Reference Video`(유튜브 숏츠 URL) + `02. Your New Topic`(한 줄)
   + `03. Visual Style` — **실제 자료 찾기**(🎬 움직이는 영상 · 📷 실제 사진)와
     **AI로 새로 그리기**(🎨 3D 입체 렌더링(기본) · 🎥 실사 시네마틱) 두 묶음, 묶음마다 **2열 컴팩트 타일**입니다.
     버튼 안에는 이름 한 줄만 있고(서브텍스트·아래 설명문 없음), 제목 옆 **ⓘ** 를 누르면 네 스타일의 출처·대체 순서·추천 주제를
     설명하는 안내 카드가 열리고, 다시 누르거나 바깥을 누르면 닫힙니다(모바일·데스크톱 동일).
   + `04. Video Length`(**15초(5컷) / 30초(8컷, 기본) / 45초(11컷) / 60초(15컷)**).
2. **AI ANALYSIS ENGINE** — 실제 요청이 도는 동안 3단계 진행률.
3. **Viral DNA Analysis** — 레퍼런스에서 읽은 `HOOK STRATEGY` / `AVG. CAPTION` / `RECOMMENDED PACE` + 근거(evidence).
   결과 제목 옆 **모드 배지**가 `GEMINI · 모델명` 또는 `LOCAL TEMPLATE` 로 지금 무엇이 만들었는지 정직하게 보여 줍니다.
4. **Your Remix Script** — 고른 길이만큼의 씬 카드(5~15컷: 훅→맥락→포인트→반전→CTA). 강조 키워드는 보라색.
   카드마다 장면 썸네일 옆에 **📷 실사 / 🎨 AI** 배지와 사진 출처가 붙고, `🔄 이 컷 장면 다시`로 한 컷만
   다시 만들거나 **📷 실사 ↔ 🎨 AI** 로 바꿀 수 있습니다.
   - **✏ 인라인 편집** — 카드마다 **🎙 내레이션**(음성으로 읽는 대사)과 **💬 자막**(화면에 뜨는 글자)을
     다크 테마 입력창에서 바로 고칩니다. 고친 값은 같은 컷 상태에 바로 들어가서
     **9:16 라이브 미리보기 자막**, **TTS 음성(/api/tts — 문장이 캐시 키라 옛 음성은 자동 폐기)**,
     **.srt / 캔버스 자막**, **영상 파일**이 모두 같은 문장을 씁니다.
     내레이션만 고치면 자막도 따라오고(자막을 따로 고친 컷은 그대로 둡니다), 카드에 `수정됨` 배지가 붙습니다.
5. **✨ 이 대본으로 AI 음성 및 자막 렌더링 시작하기 →** — 9:16 라이브 플레이어 + **AI SCENE & VIDEO** 도구:
   - **🎨 컷별 AI 이미지 생성 / 📷 컷별 실제 사진 채우기** — 고른 스타일에 따라 AI 이미지 또는 실제 사진을 컷마다 채웁니다(진행률·실패 사유 표시).
   - **🎬 영상 파일 다운로드** — 캔버스(1080×1920, 아이폰은 720×1280)에 켄번즈 장면 + 굵은 자막 + 진행바를 그리고
     **중후한 남성 내레이션 오디오 트랙**을 `AudioContext`+`MediaStreamAudioDestinationNode` 로 같은 스트림에 섮어
     `MediaRecorder` 로 실제 영상 파일을 만듭니다. 크롬은 **WebM(VP9+Opus)**, 아이폰 사파리는 **MP4(H.264+AAC)**.
     녹화가 끝나면 컨테이너·코덱·오디오 트랙 유무를 실제 바이트로 확인해 파일 이름과 안내를 맞춥니다.
   - **내레이션 음성 pill** — `중후한 남성 · 기본`(ko-KR-InJoonNeural, pitch -10%) / `차분한 다큐 톤`(ko-KR-HyunsuMultilingualNeural, rate -14%) /
     `브라우저 음성`(서버 TTS 실패 시 조용한 폴백). 음성은 컷 길이에 맞춰 재생되고, 내레이션이 길면
     컷 타임라인을 음성 길이에 맞춰 늘려(최대 14초/컷) 말이 잘리지 않습니다.
   - 한국어 Web Speech 음성(1.0~1.4배속·음소거), 컷별 진행 세그먼트·스크러빙, CUE SHEET,
     스크립트 복사 / `.srt` / 장면 프롬프트 / JSON 내보내기.

## 실제 동작 범위 (정직하게)

| 항목 | 지금 실제로 되는 것 |
| --- | --- |
| 레퍼런스 읽기 | 유튜브 영상 페이지에서 제목·길이·설명글·태그를 가져옵니다(oEmbed → Data API 폴백). 자동 자막(timedtext)은 시도하되, 유튜브가 서명/POT 제한으로 빈 응답을 주면 **시도 기록만 남기고** 표준 템포로 계속합니다. |
| DNA 분석 | **`GEMINI_API_KEY` 가 있으면** Gemini 가 레퍼런스 영상을 `fileData.fileUri` 로 직접 보고 훅 공식·템포·자막 스타일·말투를 읽습니다(영상 입력이 막히면 메타데이터·자막 텍스트로 재시도). 키가 없으면 로컬 계산(훅 유형·문장 길이·분당 어절·컷 수)으로 대체합니다. |
| 길이 | **15초(5컷) · 30초(8컷) · 45초(11컷) · 60초(15컷)** 중 고릅니다. 컷 수와 목표 초가 대본·타임코드·TTS·`.srt`·영상 녹화 길이에 그대로 쓰이고, Gemini 에는 "정확히 N컷 · 한 컷 약 X자"로 지시합니다. 내레이션이 길면 컷을 음성 길이에 맞춰 늘리므로(최대 14초/컷) 실제 영상은 목표보다 조금 길어질 수 있습니다. |
| 대본 | Gemini 가 **고른 컷 수(5~15컷)** 의 한국어 대본 + 영어 9:16 장면 프롬프트를 씁니다. 응답이 형식에 못 미치면(요청 컷의 70% 미만·JSON 깨짐·시간 초과) **로컬 엔진 대본으로 조용히 폴백**하고 `mode: "template"` 으로 표시합니다. 확인되지 않은 숫자·일정은 지어내지 말라는 규칙을 프롬프트에 넣고, 컷마다 `확인:` 줄을 남깁니다. |
| 실제 사진 | **📷 실제 사진(실사 우선)** 스타일은 AI 로 그리지 않고 **위키미디어 커먼즈 → 위키백과(ko/en) 문서 사진**을 먼저 찾습니다(`lib/real-photo.js`, 키·결제 없음). 컷마다 검색어(`photoKo`/`photoEn` — Gemini 가 대본과 함께 만들고, 템플릿 모드는 주제에서 뽑음)로 실제 사진을 찾고, 이미 쓴 사진은 빼서 컷마다 다른 사진을 씁니다. 사진 바이트는 서버가 받아 `data:` URL 로 넘기므로 캔버스·MP4 에 CORS 없이 들어갑니다. 사진에는 라이선스(CC BY-SA 등)·저작자·원본 문서 URL 이 함께 오고, 카드와 `📄 스크립트 복사`의 "사진 출처"에 그대로 남습니다. 사진이 없는 컷만 무료 AI 로 폴백하고 `kind: "ai"` 로 표시합니다(가짜 성공 없음). |
| 이미지 | **빌링 없이 무료로 동작합니다.** ① `GEMINI_API_KEY` 가 있으면 Gemini 이미지 모델을 먼저 시도하고(나중에 빌링을 켜면 자동으로 Gemini 결과가 쓰임), ② 429(무료 등급 이미지 한도 0)·404·장애면 **무료 제공자로 자동 폴백**합니다 — Pollinations(`image.pollinations.ai`, 실측 5초·`image/jpeg`·576×1024) → HF FLUX.1-schnell Space(실측 9초·`image/webp`·720×1280). ③ 바이트는 **서버에서** 받아 `data:` URL 로 돌려주므로 브라우저 캔버스가 오염되지 않고 🎬 영상 다운로드에 CORS 오류가 없습니다. ④ 익명 Pollinations 는 **IP당 45초에 1장**이라, 화면은 막힌 컷만 서버가 알려준 초만큼 쉬었다가 최대 4차까지 다시 보냅니다. 그래도 안 되면 컷별로 정직한 오류(`429 free-busy` + `retryAfterMs`)를 보여 줍니다 — 가짜 성공 없음. 무료 이미지에는 제공자 워터마크가 하단 1~2%에 작게 붙고, 플레이어·영상에서는 안전 영역(하단 5%)을 잘라 프레임 밖으로 보냅니다. 함수 응답 한도(4.5MB)를 넘는 이미지는 413 으로 알립니다. |
| 영상 | 브라우저 안에서 실시간 렌더(약 대본 길이만큼 걸립니다). **중후한 남성 내레이션 오디오 트랙이 함께 들어갑니다**(음성 준비된 컷만; 나머지 컷은 무음). MediaRecorder WebM 은 길이 메타데이터(duration)를 파일에 쓰지 않아 일부 편집기에서 재생 시간이 ∞ 로 보일 수 있습니다(브라우저 재생·업로드는 정상). |
| 음성 | **`/api/tts`** — Microsoft Edge 읽어주기 음성을 서버에서 MP3 로 만듭니다(API 키·결제 없음). `ko-KR-InJoonNeural`(pitch -10%, rate -8%) 이 기본 '중후한 남성'. 실패하면 화면이 브라우저 음성으로 조용히 폴백하고, 그 사실을 숨기지 않습니다. 무료 서비스라 예고 없이 막힐 수 있어 음성 실패 시에도 대본·자막·영상은 그대로 쓸 수 있습니다. |
| 움직이는 영상 | **🎬 움직이는 영상(스톡 클립)** 스타일은 그림 대신 **실제로 움직이는 스톡 영상 클립**을 찾습니다(`lib/stock-video.js`). ① `PIXABAY_API_KEY` 가 있으면 Pixabay Videos(세로·HD mp4), ② `PEXELS_API_KEY` 가 있으면 Pexels Videos, ③ 키가 없거나 0건이면 **위키미디어 커먼즈 영상**(`filetype:video`, 720p 이하 webm 트랜스코드)을 씁니다. **주제와 맞는 클립만 씁니다** — Pixabay·Pexels 는 영어 태그로 색인되므로 영어 검색어(`videoEn`/`photoEn`)로 묻고, 돌려받은 클립의 `tags`·제목을 실제로 읽어 컷의 핵심 피사체와 겹치지 않으면(관련도 0) 버립니다. 그래서 '롯데월드타워' 컷에 횡단보도·항구 요트 클립이 붙지 않습니다. 특정 랜드마크는 고유명사 토큰이 태그에 있어야만 통과하고, **맞는 클립이 없으면 무관한 클립을 넣지 않고 `no-relevant-video`** 로 돌려줘 그 컷을 **실제 사진(켄번즈) → 무료 AI 이미지** 순서로 채웁니다. 영상 바이트는 `/api/video-proxy`(같은 출처·Range 지원·호스트 허용 목록)로 흘려보내 `<video>` 재생과 캔버스 `drawImage` 가 CORS 없이 동작하고, 9:16 미리보기·MP4/WebM 내보내기에 실제 움직이는 프레임이 들어갑니다. 카드에는 `🎬 영상` 배지와 출처가 붙고, **🔎 검색어 입력창**에서 컷의 검색어를 직접 고쳐 `🔍 찾기`(또는 Enter)로 다시 찾거나, `🔄 다른 클립`으로 같은 검색어의 다음 클립을 고를 수 있습니다. |
| 비주얼 스타일 | **📷 실제 사진(실사 우선)** · **3D 입체 렌더링**(기본) · 실사 시네마틱. 영어 장면 프롬프트에 다이오라마/등각 투시/GI 조명 또는 필름 스틸 언어를 입혀 무료 이미지 모델의 결과 톤을 바꿉니다(`lib/visual-style.js`). 반대 스타일 단어는 걷어내고, 같은 스타일을 두 번 입히지 않습니다. |

## API

```
POST /api/analyze-and-generate
{ "url": "https://youtube.com/shorts/ID", "topic": "롯데타워의 비밀",
  "tone": "auto", "length": 45, "cutCount": 11, "facts": "선택", "referenceText": "선택",
  "style": "real" | "3d" | "cinematic" }
→ { ok: true, mode: "gemini" | "template", visualStyle, length: { sec, cuts, label, preset }, lengthOptions,
    gemini: { ok, model?, ms?, attempts?, reason? },
    analysis: { source, attempts, blueprint }, package: { meta, titles, cuts, tts, copy, ... } }

POST /api/generate-image
{ "prompt": "English 9:16 prompt", "aspectRatio": "9:16", "cutId": "cut-3", "style": "real",
  "photoKo": "롯데타워", "photoEn": "Lotte World Tower", "cutIndex": 2, "exclude": ["File:…jpg"],
  "realPhoto": "first" | "only" | "skip" }
→ { ok: true, kind: "photo" | "ai", image: "data:image/jpeg;base64,…", mimeType, model, provider,
    visualStyle, seed?, free?, ms, cutId, credit?, photo?: { title, page, license, artist, credit } }
  · provider: "wikimedia-commons" | "wikipedia-ko" | "wikipedia-en" | "gemini" | "pollinations-free" | "hf-flux-free"
  · realPhoto:"only" 는 사진이 없으면 AI 로 넘어가지 않고 404 { error: "no-real-photo" }
  · 무료 경로가 모두 막힘 → 429 { error: "free-busy", retryAfterMs }, 실패 → 502, 너무 큼 → 413

POST /api/tts
{ "text": "읽을 문장(400자 이내)", "voice": "deep" | "docu", "speed": 1 }
→ 200 audio/mpeg (실제 MP3 바이트)
  · 헤더: X-TTS-Voice(ko-KR-InJoonNeural) · X-TTS-Ms · X-TTS-Cached
  · 빈 문장/너무 김 → 400, 음성 서비스 실패 → 502 { ok:false, error:"timeout"|"upstream"|"empty-audio" }

GET  /api/tts              → { ok, engine, voices, limits }
GET  /api/generate-image → { ok, hasGeminiKey, models, imagens, freeProviders, visualStyles }   (키 값은 없음)
POST /api/find-video
{ "photoKo": "롯데월드타워", "photoEn": "Lotte World Tower", "cutIndex": 2, "exclude": ["pixabay:125"] }
→ { ok: true, kind: "video", videoUrl: "/api/video-proxy?u=…", posterUrl?, provider, providerLabel,
    videoId, title, page, license, artist, duration, width, height, credit, attempts, ms }
  · provider: "pixabay" | "pexels" | "wikimedia-commons"
  · 클립이 없으면 404 { ok:false, error:"no-video" } — 화면이 실제 사진 → AI 로 폴백
GET  /api/video-proxy?u=<https 원본> → 200/206 영상 바이트 (Range·Content-Range 그대로, 허용 호스트만)
GET  /api/find-video     → { ok, hasPixabayKey, hasPexelsKey, providers, mediaHosts }   (키 값은 없음)
GET  /api/health         → { ok, app, hasYoutubeKey, hasGeminiKey, hasPixabayKey, hasPexelsKey, geminiModel, imageModel, node }
```

환경변수(모두 선택, **키는 서버 전용 — 절대 `EXPO_PUBLIC_`·클라이언트 번들에 넣지 마세요**):

| 이름 | 쓰임 |
| --- | --- |
| `GEMINI_API_KEY` | Gemini 대본·이미지. **이미지에는 없어도 됩니다** — 없으면 무료 제공자로 컷별 장면을 만듭니다. |
| `GEMINI_MODEL` | 대본 모델 고정(기본: `gemini-2.5-flash-lite` → `gemini-2.5-flash` → `gemini-3.5-flash-lite` → `gemini-2.0-flash` 순 시도) |
| `GEMINI_IMAGE_MODEL` | 이미지 모델 고정(기본: `gemini-2.5-flash-image` 계열 → `imagen-3.0-generate-002`) |
| `YOUTUBE_API_KEY` | 있으면 Data API 로 메타데이터를 한 번 더 보강 |
| `PIXABAY_API_KEY` | 🎬 움직이는 영상 1순위(Pixabay Videos). 무료 키 발급: https://pixabay.com/api/docs/ |
| `PEXELS_API_KEY` | 있으면 Pixabay 다음 2순위(Pexels Videos). Pexels 는 신규 키 발급을 잠시 멈춰 두었습니다. |

키는 `x-goog-api-key` 헤더로만 나가고 응답·로그에 담지 않습니다. 응답에는 모델명·상태 코드·짧은 사유만 남습니다.

## 개발

```bash
npm install          # tailwindcss (CSS 빌드용 devDependency)
npm run build:css    # src/tailwind.css → styles.css (빌드 결과를 커밋해 두어 Vercel 빌드 불필요)
node tools/serve.mjs # http://localhost:4310 (정적 + /api 로컬 실행)
npm test             # 엔진·Gemini 정규화·무료 이미지 사다리·API 핸들러 테스트
```

## 구조

```
index.html                     TakeOne 화면 (Tailwind 클래스)
styles.css                     빌드된 Tailwind CSS (커밋됨)
app.js                         폼·진행률·DNA·씬 렌더·9:16 플레이어·AI 이미지·영상 내보내기
lib/engine.js                  URL 파싱 · 레퍼런스 분석 · 로컬 대본 생성 (순수 함수)
lib/cut-edit.js                내레이션·자막 인라인 편집 규칙(음성 문장·TTS 캐시 키·편집 동기화)
lib/gemini.js                  Gemini 프롬프트·응답 파싱·대본 정규화 (순수 함수)
lib/gemini-api.js              Gemini REST 호출(모델·입력모드 사다리, 이미지 생성)
lib/free-image.js              무료 이미지 사다리(Pollinations · HF FLUX) + 이미지 판별
lib/tts.js                     중후한 남성 TTS(Edge 읽어주기) · 문장 정리 · 캐시
lib/real-photo.js              실제 사진 검색(위키미디어 커먼즈 · 위키백과) + data URL 프록시
lib/stock-video.js             스톡 영상 검색(Pixabay · Pexels · 커먼즈) + 프록시 주소·허용 호스트
lib/visual-style.js            실제 사진 / 3D 다이오라마 / 실사 시네마틱 프롬프트 언어
api/analyze-and-generate.js    메타데이터 수집 + (Gemini) 분석·대본 + 폴백 + 스타일 적용
api/generate-image.js          컷별 9:16 장면 — 실제 사진 우선, 없으면 AI
api/find-video.js              컷별 움직이는 스톡 클립 — Pixabay → Pexels → 커먼즈
api/video-proxy.js             스톡 영상 같은 출처 프록시(Range·호스트 허용 목록)
api/tts.js                     컷 내레이션 MP3
api/health.js                  배포 확인 (키 유무만)
tests/engine.test.mjs          로컬 엔진 테스트
tests/cut-edit.test.mjs        내레이션·자막 편집 규칙 테스트
tests/gemini.test.mjs          프롬프트·파싱·정규화 테스트
tests/api.test.mjs             API 핸들러 테스트(네트워크 스텁, 키 비노출 확인)
tests/tts.test.mjs             TTS 문장 정리·캐시·실패 처리
tests/visual-style.test.mjs    실제 사진/3D/실사 스타일 프롬프트·API 반영
tests/style-help.test.mjs      ⓘ 안내 툴팁 문구·토글 배선·빌드된 CSS 확인
tests/real-photo.test.mjs      커먼즈·위키백과 검색·필터·프록시 테스트
tests/stock-video.test.mjs     Pixabay·Pexels·커먼즈 영상 검색·선택·프록시 허용 목록 테스트
tools/serve.mjs                로컬 미리보기 서버
```

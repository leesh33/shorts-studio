# VIRAL REMIX — AI SHORTS STUDIO

바이럴 쇼츠의 **성공 공식(Viral DNA)** 을 읽어서, 내 주제로 새 숏폼 **대본 + 컷별 AI 장면 + 9:16 영상 파일**까지 만드는 웹 앱.

- 라이브: https://shorts-studio-navy.vercel.app
- 스택: 정적 HTML/Tailwind(빌드된 CSS 커밋) + Vercel Serverless Functions 3개
  (`/api/analyze-and-generate` · `/api/generate-image` · `/api/health`)
- 화면: **VIRAL REMIX** 디자인(#090D19 · violet→blue 그라데이션) 유지

## 화면 흐름

1. **Create Your Remix** — `01. Reference Video`(유튜브 숏츠 URL) + `02. Your New Topic`(한 줄).
2. **AI ANALYSIS ENGINE** — 실제 요청이 도는 동안 3단계 진행률.
3. **Viral DNA Analysis** — 레퍼런스에서 읽은 `HOOK STRATEGY` / `AVG. CAPTION` / `RECOMMENDED PACE` + 근거(evidence).
   결과 제목 옆 **모드 배지**가 `GEMINI · 모델명` 또는 `LOCAL TEMPLATE` 로 지금 무엇이 만들었는지 정직하게 보여 줍니다.
4. **Your Remix Script** — 6~8개 씬 카드(대본·연출·카메라·확인할 것). 강조 키워드는 보라색.
5. **✨ 이 대본으로 AI 음성 및 자막 렌더링 시작하기 →** — 9:16 라이브 플레이어 + **AI SCENE & VIDEO** 도구:
   - **🎨 컷별 AI 이미지 생성** — 컷마다 Gemini 이미지 모델로 9:16 실사 장면을 만들어 플레이어에 입힙니다(진행률·실패 사유 표시).
   - **🎬 영상 파일 다운로드** — 캔버스(1080×1920, 아이폰은 720×1280)에 켄번즈 장면 + 굵은 자막 + 진행바를 그려
     `MediaRecorder` 로 실제 영상 파일을 만듭니다. 크롬은 **WebM(VP9)**, 아이폰 사파리는 **MP4(H.264)**.
     녹화가 끝나면 컨테이너·코덱을 실제 바이트로 확인해 파일 이름과 안내를 맞춥니다.
   - 한국어 Web Speech 음성(1.0~1.4배속·음소거), 컷별 진행 세그먼트·스크러빙, CUE SHEET,
     스크립트 복사 / `.srt` / 장면 프롬프트 / JSON 내보내기.

## 실제 동작 범위 (정직하게)

| 항목 | 지금 실제로 되는 것 |
| --- | --- |
| 레퍼런스 읽기 | 유튜브 영상 페이지에서 제목·길이·설명글·태그를 가져옵니다(oEmbed → Data API 폴백). 자동 자막(timedtext)은 시도하되, 유튜브가 서명/POT 제한으로 빈 응답을 주면 **시도 기록만 남기고** 표준 템포로 계속합니다. |
| DNA 분석 | **`GEMINI_API_KEY` 가 있으면** Gemini 가 레퍼런스 영상을 `fileData.fileUri` 로 직접 보고 훅 공식·템포·자막 스타일·말투를 읽습니다(영상 입력이 막히면 메타데이터·자막 텍스트로 재시도). 키가 없으면 로컬 계산(훅 유형·문장 길이·분당 어절·컷 수)으로 대체합니다. |
| 대본 | Gemini 가 6~8컷 한국어 대본 + 영어 9:16 장면 프롬프트를 씁니다. 응답이 형식에 못 미치면(컷 6개 미만·JSON 깨짐·시간 초과) **로컬 엔진 대본으로 조용히 폴백**하고 `mode: "template"` 으로 표시합니다. 확인되지 않은 숫자·일정은 지어내지 말라는 규칙을 프롬프트에 넣고, 컷마다 `확인:` 줄을 남깁니다. |
| 이미지 | **빌링 없이 무료로 동작합니다.** ① `GEMINI_API_KEY` 가 있으면 Gemini 이미지 모델을 먼저 시도하고(나중에 빌링을 켜면 자동으로 Gemini 결과가 쓰임), ② 429(무료 등급 이미지 한도 0)·404·장애면 **무료 제공자로 자동 폴백**합니다 — Pollinations(`image.pollinations.ai`, 실측 5초·`image/jpeg`·576×1024) → HF FLUX.1-schnell Space(실측 9초·`image/webp`·720×1280). ③ 바이트는 **서버에서** 받아 `data:` URL 로 돌려주므로 브라우저 캔버스가 오염되지 않고 🎬 영상 다운로드에 CORS 오류가 없습니다. ④ 익명 Pollinations 는 **IP당 45초에 1장**이라, 화면은 막힌 컷만 서버가 알려준 초만큼 쉬었다가 최대 4차까지 다시 보냅니다. 그래도 안 되면 컷별로 정직한 오류(`429 free-busy` + `retryAfterMs`)를 보여 줍니다 — 가짜 성공 없음. 무료 이미지에는 제공자 워터마크가 하단 1~2%에 작게 붙고, 플레이어·영상에서는 안전 영역(하단 5%)을 잘라 프레임 밖으로 보냅니다. 함수 응답 한도(4.5MB)를 넘는 이미지는 413 으로 알립니다. |
| 영상 | 브라우저 안에서 실시간 렌더(약 대본 길이만큼 걸립니다). **음성 트랙은 들어가지 않습니다** — Web Speech 출력은 캔버스로 녹화할 수 없습니다. MediaRecorder WebM 은 길이 메타데이터(duration)를 파일에 쓰지 않아 일부 편집기에서 재생 시간이 ∞ 로 보일 수 있습니다(브라우저 재생·업로드는 정상). |
| 음성 | 브라우저 음성 미리듣기만. 실제 TTS 엔진은 이 범위 밖입니다. |

## API

```
POST /api/analyze-and-generate
{ "url": "https://youtube.com/shorts/ID", "topic": "검단신도시 2028년 교통 호재",
  "tone": "auto", "length": 36, "facts": "선택", "referenceText": "선택" }
→ { ok: true, mode: "gemini" | "template", gemini: { ok, model?, ms?, attempts?, reason? },
    analysis: { source, attempts, blueprint }, package: { meta, titles, cuts, tts, copy, ... } }

POST /api/generate-image
{ "prompt": "English 9:16 photoreal prompt", "aspectRatio": "9:16", "cutId": "cut-3" }
→ { ok: true, image: "data:image/jpeg;base64,…", mimeType, model, provider, seed, free, ms, cutId }
  · provider: "gemini" | "pollinations-free" | "hf-flux-free"
  · 무료 경로가 모두 막힘 → 429 { error: "free-busy", retryAfterMs }, 실패 → 502, 너무 큼 → 413

GET  /api/generate-image → { ok, hasGeminiKey, models, imagens, freeProviders }   (키 값은 없음)
GET  /api/health         → { ok, app, hasYoutubeKey, hasGeminiKey, geminiModel, imageModel, node }
```

환경변수(모두 선택, **키는 서버 전용 — 절대 `EXPO_PUBLIC_`·클라이언트 번들에 넣지 마세요**):

| 이름 | 쓰임 |
| --- | --- |
| `GEMINI_API_KEY` | Gemini 대본·이미지. **이미지에는 없어도 됩니다** — 없으면 무료 제공자로 컷별 장면을 만듭니다. |
| `GEMINI_MODEL` | 대본 모델 고정(기본: `gemini-2.5-flash-lite` → `gemini-2.5-flash` → `gemini-3.5-flash-lite` → `gemini-2.0-flash` 순 시도) |
| `GEMINI_IMAGE_MODEL` | 이미지 모델 고정(기본: `gemini-2.5-flash-image` 계열 → `imagen-3.0-generate-002`) |
| `YOUTUBE_API_KEY` | 있으면 Data API 로 메타데이터를 한 번 더 보강 |

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
index.html                     VIRAL REMIX 화면 (Tailwind 클래스)
styles.css                     빌드된 Tailwind CSS (커밋됨)
app.js                         폼·진행률·DNA·씬 렌더·9:16 플레이어·AI 이미지·영상 내보내기
lib/engine.js                  URL 파싱 · 레퍼런스 분석 · 로컬 대본 생성 (순수 함수)
lib/gemini.js                  Gemini 프롬프트·응답 파싱·대본 정규화 (순수 함수)
lib/gemini-api.js              Gemini REST 호출(모델·입력모드 사다리, 이미지 생성)
api/analyze-and-generate.js    메타데이터 수집 + (Gemini) 분석·대본 + 폴백
api/generate-image.js          컷별 9:16 이미지 생성
api/health.js                  배포 확인 (키 유무만)
tests/engine.test.mjs          로컬 엔진 테스트
tests/gemini.test.mjs          프롬프트·파싱·정규화 테스트
tests/api.test.mjs             API 핸들러 테스트(네트워크 스텁, 키 비노출 확인)
tools/serve.mjs                로컬 미리보기 서버
```

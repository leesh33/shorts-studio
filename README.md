# VIRAL REMIX — AI SHORTS STUDIO

바이럴 쇼츠의 **성공 공식(Viral DNA)** 을 읽어서, 내 주제로 새 숏폼 **대본 + 연출 프롬프트 + 9:16 미리보기**를 만드는 웹 앱.

- 라이브: https://shorts-studio-navy.vercel.app
- 스택: 정적 HTML/Tailwind(빌드된 CSS 커밋) + Vercel Serverless Function 1개 (`/api/analyze-and-generate`)
- 화면: ChatGPT가 짜 준 **VIRAL REMIX** 디자인(#090D19 · violet→blue 그라데이션) 그대로, 더미만 실제 동작으로 교체

## 화면 흐름

1. **Create Your Remix** — `01. Reference Video`(유튜브 숏츠 URL) + `02. Your New Topic`(한 줄).
2. **AI ANALYSIS ENGINE** — 실제 요청이 도는 동안 3단계 진행률(레퍼런스 자막 추출 → DNA 분석 → 대본 재조립). 응답이 오기 전에는 100%로 넘어가지 않습니다.
3. **Viral DNA Analysis** — 레퍼런스에서 읽은 `HOOK STRATEGY` / `AVG. CAPTION` / `RECOMMENDED PACE` + 근거(evidence).
4. **Your Remix Script** — 6~8개 씬 카드(`Scene N`, 구간 타임코드, 🎙 SCRIPT/DIALOGUE, 🎬 VISUAL DIRECTION). 강조 키워드는 보라색.
5. **✨ 이 대본으로 AI 음성 및 자막 렌더링 시작하기 →** — 누르면 **9:16 라이브 플레이어**가 열립니다:
   - 켄번즈 줌/팬 무드 카드, 굵은 숏츠 자막(키워드 강조), **한국어 Web Speech 음성**(기본 1.21배속, 1.0~1.4 조절·음소거)
   - 컷별 진행 세그먼트·스크러빙, CUE SHEET(컷 점프), 내보내기(스크립트 복사 / `.srt` / 장면 프롬프트 / JSON)

## 실제 동작 범위 (정직하게)

| 항목 | 지금 실제로 되는 것 |
| --- | --- |
| 레퍼런스 읽기 | 유튜브 영상 페이지에서 제목·길이·설명글·태그를 가져옵니다(oEmbed → Data API 폴백). 자동 자막(timedtext)은 시도하되, 유튜브가 서명/POT 제한으로 빈 응답을 주면 **시도 기록만 남기고** 표준 템포로 계속합니다. |
| DNA 분석 | 훅 유형(질문/경고/숫자/이유/긴급/순위), 문장 길이·분당 어절, 컷 수, 자막 스타일, 템포를 실제 값에서 계산합니다. |
| 대본 | 확인되지 않은 숫자·일정은 **지어내지 않고** 씬마다 `확인할 팩트`로 남깁니다. 참고 자료를 붙여넣으면(개발 모드 API `facts`) 씬 본문으로 배분합니다. |
| 음성 | 브라우저 음성 미리듣기만. 실제 TTS 엔진·MP4 렌더는 이 프로토타입 범위 밖입니다. |
| 이미지 | 컷별 **실사 톤 영문 프롬프트**를 만들어 줍니다(장면·조명·색보정·렌즈·금지어). 이미지 생성 API에 그대로 붙이면 됩니다. |

## API

```
POST /api/analyze-and-generate
{ "url": "https://youtube.com/shorts/ID", "topic": "검단신도시 2028년 교통 호재",
  "tone": "auto", "length": 36, "facts": "선택", "referenceText": "선택" }
→ { ok: true, analysis: { source, attempts, blueprint }, package: { meta, titles, cuts, tts, copy, ... } }

GET /api/health → { ok, app, hasYoutubeKey, node }
```

환경변수(선택): `YOUTUBE_API_KEY` — 있으면 Data API 로 메타데이터를 한 번 더 보강합니다. 없어도 동작합니다.

## 개발

```bash
npm install          # tailwindcss (CSS 빌드용 devDependency)
npm run build:css    # src/tailwind.css → styles.css (빌드 결과를 커밋해 두어 Vercel 빌드 불필요)
node tools/serve.mjs # http://localhost:4310 (정적 + /api 로컬 실행)
node --test tests/   # 엔진 테스트 12개
```

## 구조

```
index.html                     VIRAL REMIX 화면 (Tailwind 클래스)
styles.css                     빌드된 Tailwind CSS (커밋됨)
app.js                         폼·진행률·DNA·씬 렌더·9:16 플레이어·내보내기
lib/engine.js                  URL 파싱 · 레퍼런스 분석 · 대본 생성 (순수 함수, 브라우저/서버 공용)
api/analyze-and-generate.js    메타데이터 수집 + 분석 + 생성
api/health.js                  배포 확인
tests/engine.test.mjs          엔진 테스트
tools/serve.mjs                로컬 미리보기 서버
```

/**
 * api/health.js — 배포 확인용 (키 값은 절대 노출하지 않습니다)
 * GET /api/health → { ok, app, hasYoutubeKey, hasGeminiKey, geminiModel, imageModel, node }
 *
 * hasGeminiKey 는 **불리언**입니다 — 키가 들어 있는지/없는지만 알려 줍니다.
 * 대본용·이미지용 모델 이름은 공개해도 안전한 값(설정 이름)만 보여 줍니다.
 */
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      ok: true,
      app: 'shorts-studio',
      hasYoutubeKey: Boolean(process.env.YOUTUBE_API_KEY || process.env.EXPO_PUBLIC_YOUTUBE_API_KEY),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_KEY),
      geminiModel: String(process.env.GEMINI_MODEL || '').trim() || 'auto',
      imageModel: String(process.env.GEMINI_IMAGE_MODEL || '').trim() || 'auto',
      node: process.version,
    }),
  );
}

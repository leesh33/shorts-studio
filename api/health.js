/**
 * api/health.js — 배포 확인용 (키 값은 절대 노출하지 않습니다)
 * GET /api/health → { ok, app, hasYoutubeKey, node }
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
      node: process.version,
    }),
  );
}

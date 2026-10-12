# Vision proxy

A small Node server between the app and Claude. It keeps your Anthropic API key off the phone, checks a per-install bearer token, rate-limits, and validates the model's JSON before returning it.

```
POST /v1/analyze-map
Authorization: Bearer <app token>
{ "imageBase64": "<jpeg/png/webp, no data: prefix>", "mediaType": "image/jpeg", "hint": "onX screenshot" }

→ 200 { "result": VisionResult, "issues": string[], "model": "claude-opus-5-5" }
```

`VisionResult` and the prompt live in `packages/engine/src/vision/`, shared with the app's validator.

## Run

```bash
npm install
cp .env.example .env     # ANTHROPIC_API_KEY, APP_TOKENS (comma-separated), PORT, RATE_LIMIT_PER_HOUR
node --env-file=.env src/server.ts
curl localhost:8787/healthz
```

Node 22.18+ runs the TypeScript directly. With `NODE_ENV=production` the server refuses to start without `APP_TOKENS`.

## Model call

- Model `claude-opus-5-5` (override with `VISION_MODEL`).
- Structured output via `output_config.format` (JSON Schema), so the response is schema-valid JSON.
- `effort: "high"`: tracing ridges and cover edges benefits from more reasoning than the Opus 5.5 default (`medium`).
- Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). If a safety classifier declines, the API retries on Anthropic's recommended fallback model in the same call. A final `stop_reason: "refusal"` returns 422 to the app, which tells the hunter to add features by hand.
- The app downsizes photos to ≤ 1568 px on the long edge before sending.

## Privacy

Images are processed in memory and never written to disk or logged. Nothing else about the hunter is sent: no location, no property name.

## Deploy

Any Node 22 host works (Fly.io, Render, Cloud Run, a VPS). Put it behind HTTPS. One small instance is plenty: the rate limiter is in-memory, so use a shared store if you scale out.

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
npm run dev              # node --watch --env-file-if-exists=.env src/server.ts
npm start                # node --env-file-if-exists=.env src/server.ts
curl localhost:8787/healthz
```

Node 22.18+ runs the TypeScript directly. Both scripts load `.env` when it exists (`--env-file-if-exists`), so a hosted deploy that injects real environment variables works unchanged. Without `APP_TOKENS` (in `.env` or the environment) the server refuses to start; for local development only, put `ALLOW_NO_AUTH=1` in `.env` (see below).

`@anthropic-ai/sdk` is pinned to a caret range (`^0.110.0`; for a 0.x package that allows patch updates only). There is no lock file in the repo yet, so run `npm install` once, check that `npm run typecheck` and a live call work, and commit the resulting `package-lock.json`.

## Auth fails closed

The server refuses to start without `APP_TOKENS`, whatever `NODE_ENV` is (Fly.io, Cloud Run and a bare VPS usually leave it unset), so a forgotten variable can never expose your Anthropic key.

For local development only, `ALLOW_NO_AUTH=1` skips auth. In that mode the server listens on `127.0.0.1` only, prints `NO AUTH` at startup, and still refuses to start if `NODE_ENV=production`. Never set it on a deployed host.

## Timeouts and cancellation

One analysis is a single non-streaming Claude call at `effort: "high"` with up to 16,000 output tokens, so a cluttered screenshot can take a few minutes. The timeouts are chained so nobody gives up on work another side is still paying for:

| Where | Limit | Setting |
| --- | --- | --- |
| App (`packages/engine/src/vision/client.ts`) | 300 s total, upload included | `timeoutMs` option, default `DEFAULT_VISION_TIMEOUT_MS` |
| Proxy, per Claude call | 240 s default, clamped to 30-270 s | `VISION_TIMEOUT_MS` |

- The proxy passes an `AbortSignal` to the SDK. It aborts when the client disconnects (the app timed out, the phone lost signal, the hunter backed out) and when the proxy's own deadline passes, so an abandoned request stops being billed. At the deadline the app gets `504`.
- The SDK makes at most one retry (`maxRetries: 1`) for quick `429`/`5xx` failures; the deadline covers the call including that retry.
- Keep your host's request timeout at 300 s or more (Cloud Run's default is 300 s; raise it if you raise `VISION_TIMEOUT_MS`). If you raise `VISION_TIMEOUT_MS`, keep it under the app's 300 s wait.
- A request the client abandons still uses one of its `RATE_LIMIT_PER_HOUR` slots.

## Model call

- Model `claude-opus-5-5` (override with `VISION_MODEL`).
- Structured output via `output_config.format` (JSON Schema), so the response is schema-valid JSON.
- `effort: "high"`: tracing ridges and cover edges benefits from more reasoning than the Opus 5.5 default (`medium`).
- Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). If a safety classifier declines, the API retries on Anthropic's recommended fallback model in the same call. A final `stop_reason: "refusal"` returns 422 to the app, which tells the hunter to add features by hand.
- The app downsizes photos to at most 2576 px on the long edge and about 3.75 MP before sending (`fitVisionImage` in the engine). That is Claude's high-resolution vision limit for Opus 4.7 and later, including `claude-opus-5-5`, with coordinates mapping 1:1 to pixels, so thin trails, fences and contour lines survive. Models with a lower limit (1568 px on Opus 4.6 and earlier, if you override `VISION_MODEL`) downscale internally, so the larger upload is harmless there.
- Requests over 5,000,000 base64 characters get `413`. The API's per-image cap is 5 MB; whether it counts decoded bytes or the base64 text is unconfirmed, so the cap is set to the stricter reading (the engine's `MAX_VISION_BASE64_CHARS` is the same number). A 2576 px JPEG is normally well under it. The app re-encodes once at lower JPEG quality before giving up.

## Privacy

Images are processed in memory and never written to disk or logged. The proxy never receives the hunter's location, property name or any coordinates: only the photo, its media type and an optional short hint you typed.

That statement is about the proxy. The app itself, separately and not through this server, queries public services with coordinates when a photo is geo-referenced: the National Weather Service (the property location rounded to 3 decimals, about 100 m), USGS 3DEP for elevation (sampled at points on and around the property), and MRLC (NLCD) and the GMU CropScape server (USDA CDL) for land cover and crop checks (those points are snapped to the datasets' 30 m grid before they are sent). The app's Settings (Display & privacy) describes the same lookups.

## Deploy

Any Node 22 host works (Fly.io, Render, Cloud Run, a VPS). Put it behind HTTPS. One small instance is plenty: the rate limiter is in-memory, so use a shared store if you scale out.

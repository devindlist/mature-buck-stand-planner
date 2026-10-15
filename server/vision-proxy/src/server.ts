import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { VISION_JSON_SCHEMA, parseVisionResult } from '../../../packages/engine/src/vision/schema.ts';
import { VISION_SYSTEM_PROMPT, VISION_USER_PROMPT } from '../../../packages/engine/src/vision/prompt.ts';
import {
  bearerToken,
  parseTimeoutMs,
  parseTokens,
  RateLimiter,
  resolveAuthPolicy,
  validateAnalyzeRequest,
  watchRequest,
  type AnalyzeRequest,
  type RequestWatch,
} from './validate.ts';

/**
 * Mature Buck Stand Planner: vision proxy.
 *
 *   POST /v1/analyze-map   { imageBase64, mediaType, hint? }  →  { result, issues, model }
 *   GET  /healthz
 *
 * The Anthropic API key lives only here. The app authenticates with a per-install
 * bearer token (APP_TOKENS); without tokens the server refuses to start unless
 * ALLOW_NO_AUTH=1 (local development, bound to 127.0.0.1). Images are processed in
 * memory and never logged or stored.
 *
 * Timeouts: each Claude call is cancelled when the client disconnects or after
 * VISION_TIMEOUT_MS (default 240 s, max 270 s). The app waits 300 s, so it never gives
 * up on a call the proxy is still paying for.
 */
const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.VISION_MODEL ?? 'claude-opus-5-5';
const TOKENS = parseTokens(process.env.APP_TOKENS);
const MODEL_TIMEOUT_MS = parseTimeoutMs(process.env.VISION_TIMEOUT_MS);
const limiter = new RateLimiter(Number(process.env.RATE_LIMIT_PER_HOUR ?? 30));
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Fail closed: no tokens means no start, unless the developer explicitly opts out of auth.
const auth = resolveAuthPolicy(TOKENS, process.env);
if (!auth.ok) {
  console.error(auth.error);
  process.exit(1);
}
const NO_AUTH = auth.open;

const client = new Anthropic();

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return; // the client already left
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function tokenAllowed(token: string | null): boolean {
  if (!TOKENS.length) return NO_AUTH; // only reachable with ALLOW_NO_AUTH=1, which binds to loopback
  if (!token) return false;
  const t = Buffer.from(token);
  return TOKENS.some((ok) => {
    const o = Buffer.from(ok);
    return o.length === t.length && timingSafeEqual(o, t);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function analyze(r: AnalyzeRequest, signal: AbortSignal) {
  const response = await client.beta.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      // Server-side fallback: if a safety classifier declines, the API retries on
      // Anthropic's recommended fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      // `fallbacks: "default"` is newer than the typings of some SDK releases (they only know the array
      // form), but the SDK sends the body as given. The cast keeps the typecheck independent of which
      // release npm resolves; the proxy's behavior does not change.
      fallbacks: 'default' as unknown as never,
      system: VISION_SYSTEM_PROMPT,
      // Spatial tracing benefits from more thinking than the Opus 5.5 default (medium).
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: VISION_JSON_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: r.mediaType, data: r.imageBase64 } },
            { type: 'text', text: r.hint ? `${VISION_USER_PROMPT}\nHunter's note about this image: ${r.hint}` : VISION_USER_PROMPT },
          ],
        },
      ],
    },
    {
      // Aborts on client disconnect or at MODEL_TIMEOUT_MS, so an abandoned or slow call stops
      // being billed. The signal bounds the whole call, retries included. The SDK's own per-attempt
      // timeout is only a backstop a few seconds later (it replaces the 10 minute default), and one
      // retry covers a quick 429/5xx without ever outlasting the deadline.
      signal,
      timeout: MODEL_TIMEOUT_MS + 5_000,
      maxRetries: 1,
    },
  );

  if (response.stop_reason === 'refusal') {
    return { status: 422, body: { error: 'The model declined to analyze this image. Try a different screenshot or add features by hand.' } };
  }
  if (response.stop_reason === 'max_tokens') {
    return { status: 502, body: { error: 'Analysis was cut off. Try a less cluttered screenshot.' } };
  }
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 502, body: { error: 'Model returned malformed JSON.' } };
  }
  const { result, issues } = parseVisionResult(raw);
  return { status: 200, body: { result, issues, model: response.model } };
}

const server = createServer(async (req, res) => {
  let watch: RequestWatch | undefined;
  try {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, model: MODEL });
    if (req.method !== 'POST' || req.url !== '/v1/analyze-map') return send(res, 404, { error: 'Not found' });

    const token = bearerToken(req.headers.authorization);
    if (!tokenAllowed(token)) return send(res, 401, { error: 'Unauthorized' });
    if (!limiter.allow(token ?? req.socket.remoteAddress ?? 'anon')) return send(res, 429, { error: 'Too many analyses this hour. Try again later.' });

    const v = validateAnalyzeRequest(await readJson(req));
    if (!v.ok) return send(res, v.status, { error: v.error });

    // From here the upstream call lives and dies with this HTTP request.
    watch = watchRequest(res, MODEL_TIMEOUT_MS);
    if (watch.signal.aborted) return; // the client left while the upload was being read
    const out = await analyze(v.value, watch.signal);
    return send(res, out.status, out.body);
  } catch (e) {
    const why = watch?.reason();
    if (why === 'client') {
      console.log('Client disconnected; analysis cancelled.');
      return;
    }
    if (why === 'deadline') return send(res, 504, { error: 'Map analysis took too long and was cancelled. Try a less cluttered screenshot.' });
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'Vision service is busy. Try again in a minute.' });
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic authentication failed. Check ANTHROPIC_API_KEY.');
      return send(res, 500, { error: 'Proxy misconfigured.' });
    }
    if (e instanceof Anthropic.BadRequestError) return send(res, 400, { error: 'The image could not be processed.' });
    // Timeout first: it is a subclass of APIConnectionError.
    if (e instanceof Anthropic.APIConnectionTimeoutError) return send(res, 504, { error: 'Vision service timed out. Try again.' });
    if (e instanceof Anthropic.APIConnectionError) return send(res, 503, { error: 'Vision service unreachable. Try again.' });
    if (e instanceof Anthropic.APIError) return send(res, 502, { error: `Vision service error (${e.status ?? 'unknown'}).` });
    const status = (e as { status?: number }).status;
    if (status) return send(res, status, { error: (e as Error).message });
    console.error('Unhandled error', (e as Error).message);
    return send(res, 500, { error: 'Internal error' });
  } finally {
    watch?.dispose();
  }
});

const onListening = (): void => {
  console.log(`vision proxy listening on ${NO_AUTH ? '127.0.0.1' : ''}:${PORT} (model ${MODEL}, timeout ${Math.round(MODEL_TIMEOUT_MS / 1000)} s${NO_AUTH ? ', NO AUTH: ALLOW_NO_AUTH=1, local only' : ''})`);
};
// Without auth the proxy must never be reachable from another machine.
if (NO_AUTH) server.listen(PORT, '127.0.0.1', onListening);
else server.listen(PORT, onListening);

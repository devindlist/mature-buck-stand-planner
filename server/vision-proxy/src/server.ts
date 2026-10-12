import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { VISION_JSON_SCHEMA, parseVisionResult } from '../../../packages/engine/src/vision/schema.ts';
import { VISION_SYSTEM_PROMPT, VISION_USER_PROMPT } from '../../../packages/engine/src/vision/prompt.ts';
import { bearerToken, RateLimiter, validateAnalyzeRequest, type AnalyzeRequest } from './validate.ts';

/**
 * Mature Buck Stand Planner: vision proxy.
 *
 *   POST /v1/analyze-map   { imageBase64, mediaType, hint? }  →  { result, issues, model }
 *   GET  /healthz
 *
 * The Anthropic API key lives only here. The app authenticates with a per-install
 * bearer token (APP_TOKENS). Images are processed in memory and never logged or stored.
 */
const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.VISION_MODEL ?? 'claude-opus-5-5';
const TOKENS = (process.env.APP_TOKENS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const limiter = new RateLimiter(Number(process.env.RATE_LIMIT_PER_HOUR ?? 30));
const MAX_BODY_BYTES = 8 * 1024 * 1024;

if (!TOKENS.length && process.env.NODE_ENV === 'production') {
  console.error('Refusing to start: set APP_TOKENS in production.');
  process.exit(1);
}

const client = new Anthropic();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function tokenAllowed(token: string | null): boolean {
  if (!TOKENS.length) return true; // local development only
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

async function analyze(r: AnalyzeRequest) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Server-side fallback: if a safety classifier declines, the API retries on
    // Anthropic's recommended fallback model inside the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
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
  });

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
  try {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, model: MODEL });
    if (req.method !== 'POST' || req.url !== '/v1/analyze-map') return send(res, 404, { error: 'Not found' });

    const token = bearerToken(req.headers.authorization);
    if (!tokenAllowed(token)) return send(res, 401, { error: 'Unauthorized' });
    if (!limiter.allow(token ?? req.socket.remoteAddress ?? 'anon')) return send(res, 429, { error: 'Too many analyses this hour. Try again later.' });

    const v = validateAnalyzeRequest(await readJson(req));
    if (!v.ok) return send(res, v.status, { error: v.error });

    const out = await analyze(v.value);
    return send(res, out.status, out.body);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'Vision service is busy. Try again in a minute.' });
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic authentication failed. Check ANTHROPIC_API_KEY.');
      return send(res, 500, { error: 'Proxy misconfigured.' });
    }
    if (e instanceof Anthropic.BadRequestError) return send(res, 400, { error: 'The image could not be processed.' });
    if (e instanceof Anthropic.APIConnectionError) return send(res, 503, { error: 'Vision service unreachable. Try again.' });
    if (e instanceof Anthropic.APIError) return send(res, 502, { error: `Vision service error (${e.status ?? 'unknown'}).` });
    const status = (e as { status?: number }).status;
    if (status) return send(res, status, { error: (e as Error).message });
    console.error('Unhandled error', (e as Error).message);
    return send(res, 500, { error: 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`vision proxy listening on :${PORT} (model ${MODEL}${TOKENS.length ? '' : ', NO AUTH: dev mode'})`);
});

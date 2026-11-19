export class PublicError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const origins = new Set([
  'https://orozcorealty.webflow.io', 'https://theorozcorealty.netlify.app',
  'https://theorozcorealty.com', 'https://www.theorozcorealty.com'
]);
export function allowedOrigin(origin) {
  if (!origin) return true; // Non-browser clients still receive validation and platform rate limits.
  if (origins.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.origin === origin && (
      (process.env.CONTEXT !== 'production' && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) ||
      (u.protocol === 'https:' && /^deploy-preview-\d+--theorozcorealty\.netlify\.app$/.test(u.hostname)) ||
      (process.env.ELENA_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).includes(origin)
    );
  } catch { return false; }
}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export async function readJSON(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
    throw new PublicError(415, 'content_type', 'Send JSON.');
  const max = 60000;
  if (Number(request.headers.get('content-length')) > max) throw new PublicError(413, 'too_large', 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError(400, 'invalid_json', 'A JSON object is required.');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new PublicError(413, 'too_large', 'Request is too large.'); }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(body)) throw Error();
    return body;
  } catch { throw new PublicError(400, 'invalid_json', 'A JSON object is required.'); }
}
export function endpoint(run) {
  return async request => {
    const origin = request.headers.get('origin');
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type' };
    if (origin && allowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
    if (!allowedOrigin(origin)) return reply(403, { ok: false, error: 'Origin is not allowed.', code: 'origin' });
    if (request.method === 'OPTIONS') return reply(204, null);
    if (request.method !== 'POST') { headers.Allow = 'POST, OPTIONS'; return reply(405, { ok: false, error: 'Use POST.' }); }
    try { return reply(200, await run(await readJSON(request))); }
    catch (error) {
      const known = error instanceof PublicError;
      return reply(known ? error.status : 503, { ok: false, code: known ? error.code : 'unavailable',
        error: known ? error.message : 'This service is temporarily unavailable. Please try again.' });
    }
  };
}
export async function postJSON(url, body, { fetchImpl = fetch, timeout = 9000, headers = {}, provider = false } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      if (provider) {
        const error = await response.json().catch(() => ({}));
        const code = error.error?.code;
        // Only a small operational category is retained. Never expose provider messages, keys or request data.
        const categories = {
          model_not_found: 'model_access', model_not_available: 'model_access',
          insufficient_quota: 'provider_quota', credit_balance_exhausted: 'provider_credit_balance',
          organization_spend_limit_exceeded: 'provider_organization_spend_limit',
          project_spend_limit_exceeded: 'provider_project_spend_limit',
          api_key_spend_limit_exceeded: 'provider_key_spend_limit',
          organization_usage_limit_exceeded: 'provider_organization_usage_limit',
          rate_limit_exceeded: 'provider_limit', slow_down: 'provider_slow_down'
        };
        const category = Object.hasOwn(categories, code) ? categories[code]
          : response.status === 401 ? 'provider_auth' : response.status === 429 ? 'provider_429_unknown'
          : response.status === 400 ? 'provider_request' : 'provider_unavailable';
        throw new PublicError(503, category, 'The explanation service is temporarily unavailable.');
      }
      throw new PublicError(502, 'upstream_unavailable', 'The calculation or explanation service is temporarily unavailable.');
    }
    const result = await response.json();
    if (!object(result)) throw new PublicError(502, 'invalid_upstream', 'The service returned an incomplete result.');
    return result;
  } finally { clearTimeout(timer); }
}

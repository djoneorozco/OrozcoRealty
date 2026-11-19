import { endpoint, PublicError } from './_shared/http.js';
import { normalizeRequest, buildContext, guidedReply } from './_shared/elena-context.js';
import { explain } from './_shared/openai.js';
export const config = {
  path: ['/api/ask-elena', '/.netlify/functions/ask-elena'],
  rateLimit: { windowLimit: 12, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};
export function createElena(options = {}) {
  return endpoint(async body => {
    const request = normalizeRequest(body);
    const packet = await buildContext(request, options);
    let answer;
    try { answer = await explain(request, packet, options); }
    catch (error) {
      const reason = error instanceof PublicError ? error.code : error.name === 'AbortError' ? 'provider_timeout' : 'answer_validation';
      answer = { ...guidedReply(packet), fallback_reason: reason };
      console.info(JSON.stringify({ event: 'elena_fallback', reason }));
    }
    return { ok: true, version: 'elena-v1', ...answer, calculations: packet.calculations, issues: packet.issues };
  });
}
export default createElena();

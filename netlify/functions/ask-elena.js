import { endpoint } from './_shared/http.js';
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
    catch { answer = guidedReply(packet); }
    return { ok: true, version: 'elena-v1', ...answer, calculations: packet.calculations, issues: packet.issues };
  });
}
export default createElena();

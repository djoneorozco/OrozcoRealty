// Public deterministic context endpoint; no model, profile lookup or independent math.
import { endpoint } from './_shared/http.js';
import { normalizeRequest, buildContext } from './_shared/elena-context.js';
export const config = { path: ['/api/elena-agent', '/.netlify/functions/elena-agent'], rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export default endpoint(async body => ({ ok: true, context: await buildContext(normalizeRequest(body)) }));

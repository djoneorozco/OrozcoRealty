import { endpoint } from './_shared/http.js';
import { calculateCompensation } from './_shared/thewing.js';
export const config = { path: ['/api/pay-tables', '/.netlify/functions/pay-tables'], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export default endpoint(async body => ({ ok: true, ...await calculateCompensation(body), source: 'TheWing' }));

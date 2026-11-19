import { endpoint } from './_shared/http.js';
import { calculateMortgage } from './_shared/thewing.js';
export const config = { path: ['/api/mortgage', '/api/mortgage-calculator', '/.netlify/functions/mortgage'], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
export default endpoint(async body => {
  const { result } = await calculateMortgage(body);
  return { ...result, ok: true, source: 'TheWing', adapter: 'tor-mortgage-v1' };
});

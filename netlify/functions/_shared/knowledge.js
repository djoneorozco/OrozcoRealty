import { readFileSync } from 'node:fs';
import path from 'node:path';
// Static data is bundled by Netlify. No user-controlled path or silent missing-pack fallback.
const dataRoot = path.join(process.cwd(), 'netlify/functions/data');
const read = file => JSON.parse(readFileSync(path.join(dataRoot, file), 'utf8'));
export function loadKnowledge(message) {
  const core = read('elena-core.json');
  const market = read('market/san-antonio.json');
  const sources = [
    { id: 'tor', title: 'The Orozco Realty — buyer and owner resources', url: 'https://www.theorozcorealty.com/resources',
      note: 'TOR helps visitors compare options and prepare questions for their agent and lender. No account or email is required to chat.' }
  ];
  if (/\b(va|veteran|military|militar|veterano)\b/i.test(message)) sources.push({ id: 'va', title: 'VA housing assistance', url: 'https://www.va.gov/housing-assistance/home-loans/', note: 'Use the official VA resource to verify current eligibility and benefits. This chat does not determine entitlement or loan approval.' });
  if (/mortgage|payment|closing|loan|hipoteca|pago|préstamo|prestamo/i.test(message)) sources.push({ id: 'cfpb', title: 'CFPB — buying a house', url: 'https://www.consumerfinance.gov/owning-a-home/', note: 'Compare lender Loan Estimates and review the full housing budget. Calculator figures are planning estimates from user-provided assumptions, not current rate quotes or lending decisions.' });
  if (/san antonio|jbsa|lackland|randolph|market|mercado|neighborhood|barrio/i.test(message)) sources.push({ id: 'san-antonio', title: `TOR San Antonio snapshot — ${market.last_updated_data_from_sources}`, url: 'https://github.com/djoneorozco/OrozcoRealty/blob/main/netlify/functions/data/market/san-antonio.json', note: 'Stored historical snapshot; it mixes San Antonio metro and Lackland submarket geography. Its statistics are withheld from chat until refreshed and reconciled. No live listings, prices, market trends, commute times, or neighborhood rankings are available.' });
  return {
    persona: { name: 'Elena', organization: 'The Orozco Realty', area: 'San Antonio, Texas and JBSA', coreAvailable: Boolean(core) },
    market: { city: market.name, snapshotDate: market.last_updated_data_from_sources, statisticsStatus: 'withheld_pending_refresh' },
    guidance: [
      'Help people buy, sell, rent, wait, or plan ownership based on their own priorities. Do not force lead capture.',
      'Explain principal and interest, property taxes, insurance, HOA, and mortgage insurance separately when those results are available.',
      'Never treat gross income as take-home cash. An unreviewed budget is provisional. Existing housing expenses that end after moving must not be counted twice.',
      'Do not rank or recommend neighborhoods based on protected characteristics. Ask about budget, commute preferences, property needs and user-selected amenities instead.',
      'Never claim live listings, live rates, guaranteed savings, eligibility, tax exemptions, a safe purchase limit, or lender approval without a current verified source.',
      'When a current local fact or individualized legal, tax or lending determination is missing, say what needs checking and point to the relevant source or professional.'
    ], sources
  };
}

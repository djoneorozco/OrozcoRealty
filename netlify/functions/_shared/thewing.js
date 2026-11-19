// TOR validates inputs; TheWing owns the financial formulas and rate tables.
import { PublicError, object, postJSON } from './http.js';
export const THEWING = 'https://thewing.netlify.app/api';
const bad = name => { throw new PublicError(422, 'missing_or_invalid_input', `Review ${name}; an explicit value is required.`); };
export function number(value, name, { min = 0, max = 10000000, optional = false } = {}) {
  if (value === null || value === undefined || value === '' || (typeof value === 'string' && !value.trim())) {
    if (optional) return null; return bad(name);
  }
  if (!['number', 'string'].includes(typeof value)) return bad(name);
  const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) return bad(name);
  return n;
}
function choice(value, choices, name) { if (!choices.includes(value)) return bad(name); return value; }
function boolean(value, name) { if (typeof value !== 'boolean') return bad(name); return value; }
function pick(source, keys) { return Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]])); }
export function mortgageInputs(body) {
  if (!object(body)) return bad('mortgage inputs');
  const military = body.contract === 'military-mortgage-v1';
  const out = {};
  if (military) out.contract = body.contract;
  out.loanType = choice(body.loanType, military ? ['VA', 'CONVENTIONAL', 'FHA'] : ['va', 'conventional'], 'loan type');
  const priceKey = military ? 'homePrice' : 'price';
  out[priceKey] = number(body[priceKey], 'home price', { min: 1 });
  out.downPayment = number(body.downPayment, 'down payment', { max: out[priceKey] });
  out.interestRate = number(body.interestRate, 'interest rate (percent)', { max: 30 });
  out.termYears = number(body.termYears, 'loan term', { min: 1, max: 30 });
  if (!Number.isInteger(out.termYears)) return bad('whole-year loan term');
  out.creditScore = number(body.creditScore, 'credit score', { min: 580, max: 850 });
  if (!Number.isInteger(out.creditScore)) return bad('credit score');
  for (const key of military ? ['propertyTaxAnnual', 'insuranceAnnual', 'hoaMonthly', 'otherOwnershipMonthly'] : ['propertyTaxPercent', 'insuranceMonthly', 'hoaMonthly'])
    out[key] = number(body[key], key, { max: key === 'propertyTaxPercent' ? 20 : 1000000 });
  for (const key of military ? ['pmiMonthly', 'closingCosts', 'prepaidsEscrow', 'cashAvailable', 'moveInCosts'] : ['pmiMonthly'])
    if (body[key] !== undefined && body[key] !== null) out[key] = number(body[key], key);
  if (military && ['VA', 'FHA'].includes(out.loanType)) out.feePayment = choice(body.feePayment, ['finance', 'cash'], 'upfront fee payment');
  if (military && out.loanType === 'VA') out.vaFeeStatus = choice(body.vaFeeStatus, ['first', 'subsequent', 'exempt'], 'VA fee status');
  if (!military && out.loanType === 'va') {
    out.priorUse = choice(body.priorUse, ['first_use', 'subsequent_use'], 'VA prior use');
    out.fundingFeeExempt = boolean(body.fundingFeeExempt, 'VA fee exemption');
    out.financeFundingFee = boolean(body.financeFundingFee, 'VA fee financing');
  }
  return out;
}
function finiteFields(objectValue, fields) {
  if (!object(objectValue) || fields.some(k => typeof objectValue[k] !== 'number' || !Number.isFinite(objectValue[k])))
    throw new PublicError(502, 'invalid_upstream', 'The calculation service returned an incomplete result.');
}
export async function calculateMortgage(body, options) {
  const inputs = mortgageInputs(body);
  const result = await postJSON(`${THEWING}/mortgage`, inputs, options);
  if (result.ok === false) throw new PublicError(502, 'invalid_upstream', 'The mortgage calculation is unavailable.');
  const military = inputs.contract === 'military-mortgage-v1';
  finiteFields(result.monthly, military ? ['principalInterest', 'propertyTax', 'insurance', 'hoa', 'mortgageInsurance', 'otherOwnership', 'totalHousing'] : ['pi', 'tax', 'insurance', 'hoa', 'pmi', 'allIn']);
  if (military && result.contract !== inputs.contract) throw new PublicError(502, 'invalid_upstream', 'Unexpected mortgage contract.');
  const m = result.monthly;
  if (Object.values(m).some(v => typeof v === 'number' && v < 0)) throw new PublicError(502, 'invalid_upstream', 'Negative mortgage components are invalid.');
  const expected = military ? m.principalInterest + m.propertyTax + m.insurance + m.hoa + m.mortgageInsurance + m.otherOwnership : m.pi + m.tax + m.insurance + m.hoa + m.pmi;
  const total = military ? m.totalHousing : m.allIn;
  if (total < 0 || Math.abs(total - expected) > 0.1) throw new PublicError(502, 'invalid_upstream', 'The mortgage totals could not be reconciled.');
  return { inputs, result };
}
export function budgetInputs(body) {
  if (!object(body) || !Array.isArray(body.items) || body.items.length > 120) return bad('budget items');
  const out = {};
  for (const key of ['grossMonthly', 'netMonthly', 'emergencyFund']) out[key] = number(body[key], key, { optional: true, max: 1000000 });
  for (const key of ['savingsMonthly', 'bufferMonthly', 'extraBufferMonthly']) out[key] = number(body[key], key, { max: 1000000 });
  out.reviewed = boolean(body.reviewed, 'budget reviewed');
  const ids = new Set();
  out.items = body.items.map(row => {
    if (!object(row) || typeof row.id !== 'string' || !row.id || row.id.length > 100 || ids.has(row.id)) return bad('budget item');
    ids.add(row.id);
    const item = { id: row.id, category: choice(row.category, ['monthly-expenses', 'debt', 'lifestyle', 'other'], 'budget category'),
      value: number(row.value, 'monthly amount', { max: 1000000 }), minimumPayment: number(row.minimumPayment ?? row.value, 'minimum payment', { max: 1000000 }) };
    for (const k of ['essential', 'housing', 'continues']) item[k] = boolean(row[k], k);
    return item;
  });
  // Home-price estimates require separately checked mortgage assumptions. Never forward default-filled scenario data.
  return out;
}
export async function calculateBudget(body, options) {
  const inputs = budgetInputs(body);
  const result = await postJSON(`${THEWING}/finance-budget`, inputs, options);
  if (result.ok !== true || result.version !== 'finance-budget-v1' || result.reviewed !== inputs.reviewed)
    throw new PublicError(502, 'invalid_upstream', 'The budget calculation is unavailable.');
  finiteFields(result.metrics, ['totalExpenses', 'totalDebt', 'totalSavings']);
  if (result.metrics.grossMonthly !== inputs.grossMonthly || result.metrics.monthlyIncome !== inputs.netMonthly)
    throw new PublicError(502, 'invalid_upstream', 'Budget income does not match the submitted inputs.');
  if (inputs.netMonthly !== null) {
    finiteFields(result.metrics, ['cashFlow']);
    const expectedCash = inputs.netMonthly - result.metrics.totalExpenses - result.metrics.totalDebt - result.metrics.totalSavings;
    if (Math.abs(expectedCash - result.metrics.cashFlow) > 0.1) throw new PublicError(502, 'invalid_upstream', 'Budget cash flow could not be reconciled.');
  }
  if (!inputs.reviewed || inputs.netMonthly === null || !(inputs.grossMonthly > 0)) {
    if (result.affordability?.monthlyRange !== null) throw new PublicError(502, 'invalid_upstream', 'An incomplete budget cannot establish a housing range.');
  } else finiteFields(result.affordability?.monthlyRange, ['comfortable', 'upper']);
  return { inputs, result };
}
export async function calculateCompensation(body, options) {
  if (!object(body)) return bad('compensation inputs');
  const rank = String(body.rank || '').toUpperCase();
  if (!/^(E-[1-9]|O-(?:[1-9]|10)|W-[1-5]|O-[1-3]E)$/.test(rank)) return bad('pay grade');
  const inputs = { rank, yearsOfService: number(body.yearsOfService ?? body.yos, 'years of service', { max: 50 }),
    dependents: choice(body.dependents, ['with', 'without'], 'dependent status') };
  if (typeof body.base !== 'string' || !body.base.trim() || body.base.length > 120) return bad('duty station');
  inputs.base = body.base.trim();
  const data = await postJSON(`${THEWING}/opensource-brain`, { tool: 'PCS_SNAPSHOT', input: inputs }, options);
  const compensation = data.payload?.compensation;
  if (!data.ok || !compensation?.ok || typeof compensation.sourceVersion !== 'string')
    throw new PublicError(502, 'invalid_upstream', 'The compensation calculation is unavailable.');
  finiteFields(compensation.monthly, ['basicPay', 'bah', 'bas', 'grossMonthlyComp']);
  const m = compensation.monthly;
  if (m.basicPay <= 0 || m.bah < 0 || m.bas < 0 || Math.abs(m.basicPay + m.bah + m.bas - m.grossMonthlyComp) > 0.1)
    throw new PublicError(502, 'invalid_upstream', 'Compensation totals could not be reconciled.');
  return { inputs, result: pick(compensation, ['monthly', 'sourceVersion']) };
}

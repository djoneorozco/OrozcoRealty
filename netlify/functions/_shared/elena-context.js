import { object, PublicError } from './http.js';
import { calculateMortgage, calculateBudget, calculateCompensation } from './thewing.js';
import { loadKnowledge } from './knowledge.js';
export function normalizeRequest(body) {
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 3000)
    throw new PublicError(400, 'message', 'Enter a question of up to 3000 characters.');
  const context = object(body.context) ? body.context : {};
  const history = context.thread ?? body.history ?? [];
  if (!Array.isArray(history) || history.length > 12) throw new PublicError(400, 'history', 'Use no more than 12 recent conversation messages.');
  const thread = history.map(turn => {
    if (!object(turn) || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string' || !turn.content.trim() || turn.content.length > 4000)
      throw new PublicError(400, 'history', 'Invalid conversation history.');
    return { role: turn.role, content: turn.content };
  });
  if (thread.reduce((n, t) => n + t.content.length, 0) > 18000) throw new PublicError(400, 'history', 'Conversation history is too long.');
  const explicitLanguage = body.language === 'es' ? 'es' : body.language === 'en' ? 'en' : null;
  const spanish = text => /\b(hola|quiero|puedo|casa|comprar|vender|español|hipoteca|préstamo|ingresos|presupuesto|gracias)\b|[¿¡]/i.test(text);
  const asksEnglish = /(?:in English|en ingl[eé]s)/i.test(body.message);
  const priorSpanish = thread.filter(t => t.role === 'user').slice(-1).some(t => spanish(t.content));
  const language = explicitLanguage || (asksEnglish ? 'en' : spanish(body.message) || priorSpanish ? 'es' : 'en');
  return { message: body.message.trim(), thread, language,
    stage: ['discovery', 'buying', 'ownership'].includes(context.stage) ? context.stage : null,
    calculators: object(context.calculators) ? context.calculators : {} };
}
const labels = {
  housing: ['Estimated monthly housing', 'Vivienda mensual estimada'], pi: ['Principal and interest', 'Capital e intereses'],
  taxes: ['Monthly property tax assumption', 'Impuesto predial mensual estimado'], insurance: ['Monthly insurance assumption', 'Seguro mensual estimado'],
  hoa: ['Monthly HOA', 'Cuota mensual de asociación'], mortgageInsurance: ['Monthly mortgage insurance', 'Seguro hipotecario mensual'],
  otherOwnership: ['Other monthly ownership costs', 'Otros gastos mensuales de vivienda'],
  cashFlow: ['Current monthly cash flow', 'Flujo de efectivo mensual actual'], gross: ['Gross monthly income', 'Ingreso bruto mensual'],
  net: ['Take-home monthly income', 'Ingreso neto mensual'], comfortable: ['Planning housing budget — comfortable', 'Presupuesto de vivienda orientativo — cómodo'],
  upper: ['Planning housing budget — upper bound', 'Presupuesto de vivienda orientativo — límite superior'],
  basicPay: ['Monthly basic pay', 'Sueldo base mensual'], bah: ['Monthly BAH', 'BAH mensual'], bas: ['Monthly BAS', 'BAS mensual'],
  militaryGross: ['Gross monthly military compensation', 'Compensación militar bruta mensual']
};
export async function buildContext(request, options) {
  const knowledge = loadKnowledge(request.message);
  const facts = {}; const calculations = {}; const issues = [];
  const add = (id, value, source, provisional = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    facts[id] = { id, value, label: labels[id][request.language === 'es' ? 1 : 0], unit: 'USD/month', source, provisional };
  };
  await Promise.all(['mortgage', 'finance', 'compensation'].map(async tool => {
    const snapshot = request.calculators[tool];
    if (snapshot == null) return;
    try {
      if (!object(snapshot) || !object(snapshot.inputs)) throw new PublicError(422, 'inputs', 'Calculator inputs are incomplete.');
      // Deliberately ignore snapshot.result and every client-supplied profile/identity/debug field.
      const { inputs, result } = await ({ mortgage: calculateMortgage, finance: calculateBudget, compensation: calculateCompensation })[tool](snapshot.inputs, options);
      calculations[tool] = { status: 'checked', source: 'TheWing', contract: inputs.contract || result.version || result.engineVersion || result.sourceVersion || 'mortgage-v2' };
      if (tool === 'mortgage') {
        const m = result.monthly, modern = inputs.contract === 'military-mortgage-v1';
        add('housing', modern ? m.totalHousing : m.allIn, tool);
        add('pi', modern ? m.principalInterest : m.pi, tool); add('taxes', modern ? m.propertyTax : m.tax, tool);
        add('insurance', m.insurance, tool); add('hoa', m.hoa, tool); add('mortgageInsurance', modern ? m.mortgageInsurance : m.pmi, tool);
        if (modern) add('otherOwnership', m.otherOwnership, tool);
      } else if (tool === 'finance') {
        const draft = !inputs.reviewed;
        add('gross', inputs.grossMonthly, tool, draft); add('net', inputs.netMonthly, tool, draft); add('cashFlow', result.metrics.cashFlow, tool, draft);
        add('comfortable', result.affordability?.monthlyRange?.comfortable, tool); add('upper', result.affordability?.monthlyRange?.upper, tool);
        if (draft || inputs.netMonthly === null || !(inputs.grossMonthly > 0)) issues.push({ tool, code: 'incomplete_budget', message: request.language === 'es' ? 'Revise el presupuesto y complete ingresos brutos y netos antes de estimar capacidad de compra.' : 'Review the budget and complete gross and take-home income before estimating affordability.' });
      } else {
        for (const k of ['basicPay', 'bah', 'bas']) add(k, result.monthly[k], tool);
        add('militaryGross', result.monthly.grossMonthlyComp, tool);
      }
    } catch (error) {
      calculations[tool] = { status: 'unavailable' };
      issues.push({ tool, code: error instanceof PublicError ? error.code : 'unavailable', message: request.language === 'es'
        ? 'No pude verificar este cálculo. Revise y complete los datos en la calculadora antes de usar un resultado.'
        : 'I could not verify this calculation. Review and complete the calculator inputs before relying on a result.' });
    }
  }));
  return { version: 'elena-context-v1', stage: request.stage, language: request.language, knowledge, facts, calculations, issues };
}
export function factLines(facts, ids, language) {
  const format = new Intl.NumberFormat(language === 'es' ? 'es-US' : 'en-US', { style: 'currency', currency: 'USD' });
  return ids.map(id => {
    const f = facts[id]; return `${f.label}${f.provisional ? (language === 'es' ? ' (provisional)' : ' (provisional)') : ''}: ${format.format(f.value)}`;
  }).join('\n');
}
export function guidedReply(packet) {
  const es = packet.language === 'es'; const ids = Object.keys(packet.facts);
  let reply = es ? 'La explicación de IA no está disponible en este momento.' : 'The AI explanation is temporarily unavailable.';
  if (ids.length) reply += '\n\n' + (es ? 'Estos son los resultados verificados de sus datos actuales:' : 'These are the checked results from your current inputs:') + '\n' + factLines(packet.facts, ids, packet.language);
  else reply += es ? ' Puede volver a intentar su pregunta. Para revisar pagos o capacidad de compra, complete primero la calculadora de hipoteca o presupuesto.' : ' You can retry your question. To review payments or affordability, complete the mortgage or budget calculator first.';
  if (packet.issues.length) reply += '\n\n' + packet.issues.map(i => i.message).join('\n');
  if (ids.length) reply += es ? '\n\nSon estimaciones para planificación, no una aprobación de préstamo.' : '\n\nThese are planning estimates, not loan approval.';
  return { reply, facts: ids.map(id => packet.facts[id]), citations: [], explanation_mode: 'guided_fallback' };
}

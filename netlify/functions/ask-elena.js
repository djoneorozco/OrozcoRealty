// netlify/functions/ask-elena.js
// ============================================================
// OrozcoRealty • Ask-Elena — OpenAI Conversational Wrapper
// v1.2.0 (2026-04-09)
//
// PURPOSE
// - OpenAI is ALWAYS the primary conversational layer
// - Uses elena-agent.js as the deterministic housing/math engine
// - Supports normal chat, greetings, education, market questions,
//   affordability questions, mortgage questions, payment-to-price questions
// - Accepts verified profile context from the Ask-Elena widget
// - Lets Elena answer using saved user profile data when email is verified
// - Returns natural conversational replies, not raw finance packets
//
// FLOW
// 1) Receive user message
// 2) Accept verified profile context from frontend when available
// 3) Light intent routing
// 4) Call elena-agent.js when structured housing truth is useful
// 5) Feed user message + verified profile + agent packet into OpenAI
// 6) Return polished Elena response
//
// REQUIRED ENV
// - OPENAI_API_KEY
//
// OPTIONAL ENV
// - OROZCO_API_BASE or API_BASE
//
// CLIENT
// POST /.netlify/functions/ask-elena
// body: {
//   message: "What home price can I get with a $2400 monthly payment?",
//   email?: "user@email.com",
//   marketSlug?: "san-antonio",
//   verifiedProfile?: { ... },
//   profileContext?: "Name: ... | Base: ...",
//   context?: { ... },
//   debug?: true
// }
// ============================================================

/* eslint-disable no-console */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// ------------------------------------------------------------
// //#1 CORS
// ------------------------------------------------------------
const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://www.theorozcorealty.com",
  "https://orozcorealty.com",
  "https://www.orozcorealty.com",
  "https://theorozcorealty.webflow.io",
  "https://www.theorozcorealty.webflow.io",
  "https://orozcorealty.webflow.io",
  "https://www.orozcorealty.webflow.io",
  "https://theorozcorealty.netlify.app",
  "https://www.theorozcorealty.netlify.app",
  "https://orozcorealty.netlify.app",
  "https://www.orozcorealty.netlify.app",
  "http://localhost:8888",
  "http://localhost:3000"
];

function corsHeaders(origin) {
  const allowOrigin = ALLOW_ORIGINS.includes(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
    "Vary": "Origin"
  };
}

function respond(statusCode, payload, origin) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(payload || {})
  };
}

// ------------------------------------------------------------
// //#2 HELPERS
// ------------------------------------------------------------
function safeJsonParse(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function normalizeEmail(x) {
  const e = safeStr(x).toLowerCase();
  return e.includes("@") ? e : "";
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (
      v !== undefined &&
      v !== null &&
      v !== "" &&
      !(typeof v === "number" && !Number.isFinite(v))
    ) {
      return v;
    }
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasPositiveMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0
    }).format(x);
  } catch {
    return "$" + Math.round(x);
  }
}

function pct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return (x * 100).toFixed(1) + "%";
}

function pickApiBase(event) {
  const env = process.env.OROZCO_API_BASE || process.env.API_BASE;
  if (env) return env.replace(/\/$/, "");

  const host =
    event?.headers?.host ||
    event?.headers?.Host ||
    event?.headers?.["x-forwarded-host"] ||
    "";

  if (host) {
    if (/webflow\.io$/i.test(host)) return "https://theorozcorealty.netlify.app";
    if (/netlify\.app$/i.test(host)) return `https://${host}`;
    if (/orozcorealty\.com$/i.test(host) || /theorozcorealty\.com$/i.test(host)) {
      return `https://${host}`;
    }
  }

  return "https://theorozcorealty.netlify.app";
}

async function postJSON(url, payload, timeoutMs = 18000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });

    const text = await res.text();
    const data = safeJsonParse(text);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e?.message || e) } };
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------
// //#2A VERIFIED PROFILE HELPERS
// ------------------------------------------------------------
function cleanProfileValue(v) {
  if (v === undefined || v === null) return null;

  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : null;
  }

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }

  if (typeof v === "boolean") {
    return v;
  }

  if (Array.isArray(v)) {
    const arr = v
      .map((x) => cleanProfileValue(x))
      .filter((x) => x !== null && x !== undefined && x !== "");
    return arr.length ? arr : null;
  }

  if (typeof v === "object") {
    return v;
  }

  return null;
}

function sanitizeVerifiedProfile(raw) {
  if (!raw || typeof raw !== "object") return null;

  const profile = {
    email: normalizeEmail(raw.email),
    full_name: cleanProfileValue(
      raw.full_name ||
      raw.fullName ||
      raw.name ||
      [raw.first_name, raw.last_name].filter(Boolean).join(" ")
    ),
    first_name: cleanProfileValue(raw.first_name || raw.firstName),
    last_name: cleanProfileValue(raw.last_name || raw.lastName),
    phone: cleanProfileValue(raw.phone),
    mode: cleanProfileValue(raw.mode || raw.user_type),
    rank: cleanProfileValue(raw.rank),
    rank_paygrade: cleanProfileValue(raw.rank_paygrade || raw.rankPaygrade),
    va_disability: cleanProfileValue(raw.va_disability || raw.vaDisability),
    yos: cleanProfileValue(raw.yos),
    family: cleanProfileValue(raw.family),
    base: cleanProfileValue(raw.base),
    notes: cleanProfileValue(raw.notes),

    projected_home_price: cleanProfileValue(
      raw.projected_home_price ||
      raw.projectedHomePrice ||
      raw.price ||
      raw.homePrice
    ),
    monthly_expenses: cleanProfileValue(
      raw.monthly_expenses ||
      raw.monthlyExpenses ||
      raw.expenses
    ),
    downpayment: cleanProfileValue(
      raw.downpayment ||
      raw.downPayment ||
      raw.dpAmt
    ),
    savings: cleanProfileValue(raw.savings),
    credit_score: cleanProfileValue(
      raw.credit_score ||
      raw.creditScore ||
      raw.fico
    ),

    bedrooms: cleanProfileValue(raw.bedrooms),
    bathrooms: cleanProfileValue(raw.bathrooms),
    sqft: cleanProfileValue(raw.sqft),
    property_type: cleanProfileValue(raw.property_type || raw.propertyType),
    home_condition: cleanProfileValue(raw.home_condition || raw.homeCondition),
    amenities: cleanProfileValue(raw.amenities)
  };

  const out = {};
  Object.keys(profile).forEach((k) => {
    if (profile[k] !== null && profile[k] !== undefined && profile[k] !== "") {
      out[k] = profile[k];
    }
  });

  return Object.keys(out).length ? out : null;
}

function buildProfileContextSummary(profile, profileContextFromClient) {
  const parts = [];

  if (safeStr(profileContextFromClient)) {
    parts.push(safeStr(profileContextFromClient));
  }

  if (profile && typeof profile === "object") {
    if (profile.full_name) parts.push(`Name: ${profile.full_name}`);
    if (profile.email) parts.push(`Email: ${profile.email}`);
    if (profile.base) parts.push(`Base: ${profile.base}`);
    if (profile.rank_paygrade || profile.rank) {
      parts.push(`Rank: ${profile.rank_paygrade || profile.rank}`);
    }
    if (hasPositiveMoney(profile.projected_home_price)) {
      parts.push(`Target Price: ${money(profile.projected_home_price)}`);
    }
    if (hasPositiveMoney(profile.monthly_expenses)) {
      parts.push(`Monthly Expenses: ${money(profile.monthly_expenses)}`);
    }
    if (hasPositiveMoney(profile.downpayment)) {
      parts.push(`Down Payment: ${money(profile.downpayment)}`);
    }
    if (hasPositiveMoney(profile.savings)) {
      parts.push(`Savings: ${money(profile.savings)}`);
    }
    if (num(profile.credit_score)) {
      parts.push(`Credit Score: ${profile.credit_score}`);
    }
    if (num(profile.bedrooms)) {
      parts.push(`Bedrooms: ${profile.bedrooms}`);
    }
    if (num(profile.bathrooms)) {
      parts.push(`Bathrooms: ${profile.bathrooms}`);
    }
    if (num(profile.sqft)) {
      parts.push(`SqFt: ${profile.sqft}`);
    }
    if (profile.property_type) {
      parts.push(`Property Type: ${profile.property_type}`);
    }
    if (profile.home_condition) {
      parts.push(`Home Condition: ${profile.home_condition}`);
    }
    if (profile.notes) {
      parts.push(`Notes: ${profile.notes}`);
    }
  }

  const deduped = [...new Set(parts.filter(Boolean))];
  return deduped.join(" | ");
}

// ------------------------------------------------------------
// //#3 LOCAL JSON LOADERS
// ------------------------------------------------------------
const DATA_DIR = path.join(process.cwd(), "netlify", "functions", "data");

async function readJsonFile(absPath) {
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

async function loadKnowledgePack(relPath) {
  const absPath = path.join(DATA_DIR, relPath);
  return readJsonFile(absPath);
}

async function loadCorePacks() {
  const [core, financeRules, realtyKnowledge] = await Promise.all([
    loadKnowledgePack("elena-core.json"),
    loadKnowledgePack("finance-rules.json"),
    loadKnowledgePack("real-estate-knowledge-texas.json")
  ]);

  return {
    core: core || {},
    financeRules: financeRules || {},
    realtyKnowledge: realtyKnowledge || {}
  };
}

// ------------------------------------------------------------
// //#4 LIGHT MESSAGE CLASSIFICATION
// ------------------------------------------------------------
function isGreeting(message) {
  const t = safeStr(message).toLowerCase();
  return /^(hi|hello|hey|yo|good morning|good afternoon|good evening|sup|what's up)\b/.test(t);
}

function isCapabilityQuestion(message) {
  const t = safeStr(message).toLowerCase();
  return /\bwhat can you do\b|\bhow can you help\b|\bwhat do you do\b|\bhelp me\b/.test(t);
}

function likelyNeedsAgent(message) {
  const t = safeStr(message).toLowerCase();
  if (!t) return false;

  return (
    /\bafford\b|\bbuying power\b|\bpayment\b|\bmortgage\b|\bhome price\b|\baverage home price\b|\bavg home price\b|\bhome value\b|\baverage home value\b|\bmedian home price\b|\bmedian price\b|\bprice range\b|\bwhat house\b|\bhow much house\b|\bdown payment\b|\bcredit score\b|\bmonthly debt\b|\bmonthly expenses\b|\bincome\b|\bmarket\b|\binventory\b|\bdays on market\b|\bdom\b|\bseller\b|\blist\b|\binvestor\b|\brental\b|\brent\b|\bcash flow\b|\bcap rate\b|\bhoa\b|\binsurance\b|\bproperty tax\b|\btaxes\b/.test(t)
  );
}

// ------------------------------------------------------------
// //#5 AGENT CALL
// ------------------------------------------------------------
async function callElenaAgent({ API_BASE, message, email, marketSlug, body, verifiedProfile }) {
  const payload = {
    email: email || undefined,
    question: message,
    overrides: {
      marketSlug: marketSlug || body?.marketSlug || body?.overrides?.marketSlug || undefined,
      ...((body?.overrides && typeof body.overrides === "object") ? body.overrides : {})
    },
    scenario: (body?.scenario && typeof body.scenario === "object") ? body.scenario : undefined,
    verifiedProfile: verifiedProfile || undefined,
    debug: body?.debug === true
  };

  return postJSON(`${API_BASE}/.netlify/functions/elena-agent`, payload, 20000);
}

// ------------------------------------------------------------
// //#6 OPENAI RESPONSE BUILD
// ------------------------------------------------------------
function buildSystemPrompt({ core, financeRules }) {
  const name = core?.name || "Elena";
  const role =
    core?.role ||
    "OrozcoRealty real estate and financial guidance specialist for Texas markets";

  const mission =
    core?.mission ||
    "Help users make smarter Texas real estate decisions by combining market context, financial clarity, and practical next steps.";

  const guardrails = Array.isArray(core?.guardrails) ? core.guardrails : [];
  const outputLabels = core?.output_labels || {};
  const housingCapPct = num(financeRules?.housing_cap_pct) || 0.30;
  const backEndPct = num(financeRules?.back_end_dti_pct) || 0.43;

  return [
    `You are ${name}, ${role}.`,
    mission,
    "You are always conversational, natural, polished, and helpful.",
    "You are NOT a raw calculator and you must NOT answer like a JSON dump or robotic receipt.",
    "OpenAI-style conversation is ALWAYS active.",
    "When deterministic agent data is provided, trust it over your own invented math.",
    "When a verified user profile is provided, you may use that profile as true user context for personalization.",
    "Never fabricate numbers that were not provided by the agent packet or verified profile.",
    "If deterministic_packet.market.summary.metrics contains market price data, use it directly and state it confidently instead of saying you do not have the data.",
    "If the user asks a personal question like their name, budget, base, or saved profile detail, and verified profile data exists, answer from that verified profile.",
    "If the user is greeting you or asking what you can do, answer like a normal concierge and do NOT force a finance summary.",
    "If the question is broad or educational, answer naturally and use the Texas real-estate context provided.",
    "If the agent packet contains finance or market outputs, explain them in plain English.",
    "Be BLUF-first: lead with the practical answer, then explain.",
    "Keep answers concise but complete. Usually 4 to 8 sentences unless the user asks for more.",
    "Never claim legal or tax advice. Never guarantee approval or investment outcomes.",
    `Default affordability rails: housing cap about ${(housingCapPct * 100).toFixed(0)}% of income, back-end DTI about ${(backEndPct * 100).toFixed(0)}% when agent data uses those assumptions.`,
    outputLabels?.green ? `GREEN means: ${outputLabels.green}.` : "",
    outputLabels?.caution ? `CAUTION means: ${outputLabels.caution}.` : "",
    outputLabels?.no_go ? `NO-GO means: ${outputLabels.no_go}.` : "",
    outputLabels?.insufficient ? `INSUFFICIENT means: ${outputLabels.insufficient}.` : "",
    guardrails.length ? `Guardrails: ${guardrails.join(" ")}` : ""
  ].filter(Boolean).join(" ");
}

function buildUserPayload({
  message,
  email,
  marketSlug,
  agentPacket,
  packs,
  verifiedProfile,
  profileContextSummary
}) {
  return {
    user_message: message,
    email: email || null,
    selected_market: marketSlug || null,
    persona: {
      name: packs.core?.name || "Elena",
      brand: packs.core?.brand || "OrozcoRealty",
      market_scope: packs.core?.market_scope || { state: "Texas" }
    },
    behavior_rules: {
      bluf_first: true,
      conversational: true,
      deterministic_data_overrides_model_math: true,
      do_not_answer_like_json: true,
      may_use_verified_profile: true
    },
    verified_user_profile: verifiedProfile || null,
    verified_user_profile_summary: profileContextSummary || null,
    deterministic_packet: agentPacket || null,
    note_for_model:
      "If deterministic_packet is null or lacks numbers, answer conversationally. If deterministic_packet contains housing math or market context, explain it clearly and naturally. If verified_user_profile exists, you may use it to answer personal questions about the user's saved info."
  };
}

async function callOpenAI({ systemPrompt, userPayload }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: "Missing OPENAI_API_KEY"
    };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.35,
        max_tokens: 550,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload) }
        ]
      })
    });

    const data = await res.json();
    const reply = safeStr(data?.choices?.[0]?.message?.content);

    if (!res.ok || !reply) {
      return {
        ok: false,
        error: data?.error?.message || "OpenAI request failed",
        raw: data
      };
    }

    return { ok: true, reply, raw: data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ------------------------------------------------------------
// //#7 FALLBACK REPLY BUILDERS
// ------------------------------------------------------------
function buildGreetingReply(core, verifiedProfile) {
  const name = core?.name || "Elena";
  const firstName = safeStr(
    verifiedProfile?.first_name ||
    verifiedProfile?.full_name?.split?.(" ")?.[0] ||
    ""
  );

  if (firstName) {
    return `Hey ${firstName} — I’m ${name}, your OrozcoRealty concierge. I’ve got your saved profile loaded, so I can help with Texas home prices, monthly payment pressure, affordability, and market questions in a more personalized way.`;
  }

  return `Hey — I’m ${name}, your OrozcoRealty concierge. I can help with Texas home prices, monthly payment pressure, affordability, and market questions like San Antonio or McAllen. Ask me a price, payment, city, buyer, seller, or investor question and I’ll break it down.`;
}

function buildCapabilityReply(core) {
  const name = core?.name || "Elena";
  return `${name} can help with Texas home affordability, estimated monthly payments, payment-to-price questions, buyer and seller strategy, and market reads for selected cities. I can also explain ownership costs like property taxes, insurance, HOA, and what those numbers mean in plain English.`;
}

function buildVerifiedProfileFallbackAnswer(message, verifiedProfile) {
  if (!verifiedProfile) return null;

  const t = safeStr(message).toLowerCase();
  const fullName = safeStr(
    verifiedProfile.full_name ||
    [verifiedProfile.first_name, verifiedProfile.last_name].filter(Boolean).join(" ")
  );
  const firstName = safeStr(verifiedProfile.first_name || fullName.split(" ")[0] || "");
  const base = safeStr(verifiedProfile.base);
  const rank = safeStr(verifiedProfile.rank_paygrade || verifiedProfile.rank);
  const propertyType = safeStr(verifiedProfile.property_type);
  const homeCondition = safeStr(verifiedProfile.home_condition);

  if (/\bwhat is my name\b|\bwhat's my name\b|\bwho am i\b/.test(t)) {
    if (fullName) return `Your saved name is ${fullName}.`;
    if (firstName) return `Your saved first name is ${firstName}.`;
  }

  if (/\bwhat base\b|\bmy base\b|\bwhere am i stationed\b/.test(t) && base) {
    return `Your saved base is ${base}.`;
  }

  if (/\bmy rank\b|\bwhat rank\b/.test(t) && rank) {
    return `Your saved rank is ${rank}.`;
  }

  if (/\bmy budget\b|\btarget price\b|\bhome price\b/.test(t) && hasPositiveMoney(verifiedProfile.projected_home_price)) {
    return `Your saved target home price is ${money(verifiedProfile.projected_home_price)}.`;
  }

  if (/\bmonthly expenses\b|\bmy expenses\b/.test(t) && hasPositiveMoney(verifiedProfile.monthly_expenses)) {
    return `Your saved monthly expenses are ${money(verifiedProfile.monthly_expenses)}.`;
  }

  if (/\bdown payment\b|\bmy downpayment\b/.test(t) && hasPositiveMoney(verifiedProfile.downpayment)) {
    return `Your saved down payment is ${money(verifiedProfile.downpayment)}.`;
  }

  if (/\bcredit score\b|\bmy credit\b/.test(t) && num(verifiedProfile.credit_score)) {
    return `Your saved credit score is ${verifiedProfile.credit_score}.`;
  }

  if (/\bbedroom\b|\bbedrooms\b/.test(t) && num(verifiedProfile.bedrooms)) {
    return `Your saved bedroom target is ${verifiedProfile.bedrooms}.`;
  }

  if (/\bbathroom\b|\bbathrooms\b/.test(t) && num(verifiedProfile.bathrooms)) {
    return `Your saved bathroom target is ${verifiedProfile.bathrooms}.`;
  }

  if (/\bproperty type\b|\bhome type\b/.test(t) && propertyType) {
    return `Your saved property type is ${propertyType}.`;
  }

  if (/\bhome condition\b|\bcondition\b/.test(t) && homeCondition) {
    return `Your saved home condition is ${homeCondition}.`;
  }

  return null;
}

function buildEmergencyFallback({ message, agentPacket, core, verifiedProfile }) {
  const verifiedReply = buildVerifiedProfileFallbackAnswer(message, verifiedProfile);
  if (verifiedReply) return verifiedReply;

  if (isGreeting(message)) return buildGreetingReply(core, verifiedProfile);
  if (isCapabilityQuestion(message)) return buildCapabilityReply(core);

  const verdict = agentPacket?.verdict || {};
  const mortgage = agentPacket?.mortgage || {};
  const paymentToPrice = agentPacket?.payment_to_price || {};
  const nextAction = agentPacket?.next_action || {};
  const market = agentPacket?.market?.summary || null;
  const metrics = market?.metrics || {};

  const lines = [];

  if (hasPositiveMoney(metrics.average_home_value)) {
    lines.push(`The average home value in ${market?.city || "this market"} is about ${money(metrics.average_home_value)}.`);
    if (hasPositiveMoney(metrics.median_list_price)) {
      lines.push(`Median list pricing is around ${money(metrics.median_list_price)}.`);
    }
    if (hasPositiveMoney(metrics.median_sold_price)) {
      lines.push(`Recent sold pricing is around ${money(metrics.median_sold_price)}.`);
    }
    return lines.join(" ");
  }

  if (agentPacket?.coverage_lane === "payment_to_price" && paymentToPrice?.estimated_price_range) {
    lines.push("Here’s the bottom line:");
    lines.push(
      `A target payment of ${money(paymentToPrice.target_monthly_payment)} points to an estimated shopping range near ${money(paymentToPrice.estimated_price_range.conservative)} to ${money(paymentToPrice.estimated_price_range.upper)}, with a central target around ${money(paymentToPrice.estimated_price_range.target)}.`
    );
    if (nextAction?.why) lines.push(nextAction.why);
    return lines.join(" ");
  }

  if (verdict?.status && verdict.status !== "INSUFFICIENT") {
    lines.push(`Here’s the bottom line: ${verdict.status}${verdict.grade ? ` (${verdict.grade})` : ""}.`);
    if (hasPositiveMoney(mortgage?.all_in_monthly)) {
      lines.push(`Estimated monthly housing cost is about ${money(mortgage.all_in_monthly)}.`);
    }
    if (hasPositiveMoney(verdict?.residual)) {
      lines.push(`Residual income is about ${money(verdict.residual)}.`);
    }
    if (Array.isArray(verdict?.notes) && verdict.notes[0]) {
      lines.push(verdict.notes[0]);
    }
    if (market?.available && market?.city) {
      lines.push(`I also loaded market context for ${market.city}.`);
    }
    if (nextAction?.why) lines.push(nextAction.why);
    return lines.join(" ");
  }

  if (Array.isArray(verdict?.notes) && verdict.notes[0]) {
    return `I can help with that. Right now the main issue is: ${verdict.notes[0]} ${nextAction?.why || ""}`.trim();
  }

  if (verifiedProfile?.full_name) {
    return `I’ve got your saved profile loaded, ${verifiedProfile.full_name}. Ask me about affordability, monthly payment, what home price fits a target payment, or what’s happening in a Texas market like San Antonio or McAllen.`;
  }

  return `I’m here and ready. Ask me about affordability, monthly payment, what home price fits a target payment, or what’s happening in a Texas market like San Antonio or McAllen.`;
}

// ------------------------------------------------------------
// //#8 MAIN HANDLER
// ------------------------------------------------------------
exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true }, origin);
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed. Use POST." }, origin);
  }

  const body = safeJsonParse(event.body);
  const message = safeStr(body?.message || body?.question);

  const verifiedProfile = sanitizeVerifiedProfile(
    body?.verifiedProfile ||
    body?.context?.verifiedProfile ||
    body?.context?.profile ||
    null
  );

  const email = normalizeEmail(
    body?.email ||
    verifiedProfile?.email ||
    body?.context?.email ||
    body?.context?.profile?.email
  );

  const marketSlug = safeStr(
    body?.marketSlug ||
    body?.context?.marketSlug ||
    body?.overrides?.marketSlug
  );

  const profileContextSummary = buildProfileContextSummary(
    verifiedProfile,
    body?.profileContext || body?.context?.profileContext || ""
  );

  const debug = body?.debug === true;

  if (!message) {
    return respond(400, { ok: false, error: "Missing message" }, origin);
  }

  const API_BASE = pickApiBase(event);
  const packs = await loadCorePacks();

  let agentPacket = null;
  let agentMeta = { called: false, ok: false, status: null, error: null };

  if (likelyNeedsAgent(message)) {
    agentMeta.called = true;
    const agentRes = await callElenaAgent({
      API_BASE,
      message,
      email,
      marketSlug,
      body,
      verifiedProfile
    });

    agentMeta.ok = !!agentRes.ok;
    agentMeta.status = agentRes.status;
    if (agentRes.ok && agentRes.data) {
      agentPacket = agentRes.data;
    } else {
      agentMeta.error = agentRes?.data?.error || "Agent request failed";
    }
  }

  const systemPrompt = buildSystemPrompt({
    core: packs.core,
    financeRules: packs.financeRules
  });

  const userPayload = buildUserPayload({
    message,
    email,
    marketSlug,
    agentPacket,
    packs,
    verifiedProfile,
    profileContextSummary
  });

  const openaiRes = await callOpenAI({
    systemPrompt,
    userPayload
  });

  let reply = "";
  let source = "openai";

  if (openaiRes.ok && openaiRes.reply) {
    reply = openaiRes.reply;
  } else {
    source = "fallback";
    reply = buildEmergencyFallback({
      message,
      agentPacket,
      core: packs.core,
      verifiedProfile
    });
  }

  const payload = {
    ok: true,
    reply,
    source,
    ui: {
      speed: 18,
      startDelay: 120
    }
  };

  if (agentPacket?.intent) payload.intent = agentPacket.intent;
  if (agentPacket?.coverage_lane) payload.coverage_lane = agentPacket.coverage_lane;
  if (agentPacket?.market) payload.market = agentPacket.market;
  if (agentPacket?.verdict) payload.verdict = agentPacket.verdict;
  if (agentPacket?.mortgage) payload.mortgage = agentPacket.mortgage;
  if (agentPacket?.payment_to_price) payload.payment_to_price = agentPacket.payment_to_price;
  if (agentPacket?.answer_packet) payload.answer_packet = agentPacket.answer_packet;
  if (verifiedProfile) payload.profile_loaded = true;

  if (debug) {
    payload.debug = {
      API_BASE,
      message,
      email: email || null,
      marketSlug: marketSlug || null,
      profile_loaded: !!verifiedProfile,
      profile_context_summary: profileContextSummary || null,
      used_agent: agentMeta.called,
      agent_ok: agentMeta.ok,
      agent_status: agentMeta.status,
      agent_error: agentMeta.error,
      openai_ok: openaiRes.ok,
      openai_error: openaiRes.ok ? null : openaiRes.error,
      source
    };
  }

  return respond(200, payload, origin);
};

// netlify/functions/ask-elena.js
// ============================================================
// OrozcoRealty • Ask-Elena — OpenAI Conversational Wrapper
// v1.0.0 (2026-04-09)
//
// PURPOSE
// - OpenAI is ALWAYS the primary conversational layer
// - Uses elena-agent.js as the deterministic housing/math engine
// - Supports normal chat, greetings, education, market questions,
//   affordability questions, mortgage questions, payment-to-price questions
// - Returns natural conversational replies, not raw finance packets
//
// FLOW
// 1) Receive user message
// 2) Light intent routing
// 3) Call elena-agent.js when structured housing truth is useful
// 4) Feed user message + agent packet + persona rules into OpenAI
// 5) Return polished Elena response
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

function fileExists(absPath) {
  try {
    return fs.existsSync(absPath);
  } catch {
    return false;
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
    /\bafford\b|\bbuying power\b|\bpayment\b|\bmortgage\b|\bhome price\b|\bprice range\b|\bwhat house\b|\bhow much house\b|\bdown payment\b|\bcredit score\b|\bmonthly debt\b|\bmonthly expenses\b|\bincome\b|\bmarket\b|\binventory\b|\bdays on market\b|\bdom\b|\bseller\b|\blist\b|\binvestor\b|\brental\b|\brent\b|\bcash flow\b|\bcap rate\b|\bhoa\b|\binsurance\b|\bproperty tax\b|\btaxes\b/.test(t)
  );
}

// ------------------------------------------------------------
// //#5 AGENT CALL
// ------------------------------------------------------------
async function callElenaAgent({ API_BASE, message, email, marketSlug, body }) {
  const payload = {
    email: email || undefined,
    question: message,
    overrides: {
      marketSlug: marketSlug || body?.marketSlug || body?.overrides?.marketSlug || undefined,
      ...((body?.overrides && typeof body.overrides === "object") ? body.overrides : {})
    },
    scenario: (body?.scenario && typeof body.scenario === "object") ? body.scenario : undefined,
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
    "Never fabricate numbers that were not provided by the agent packet.",
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

function buildUserPayload({ message, email, marketSlug, agentPacket, packs }) {
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
      do_not_answer_like_json: true
    },
    deterministic_packet: agentPacket || null,
    note_for_model:
      "If deterministic_packet is null or lacks numbers, answer conversationally. If deterministic_packet contains housing math or market context, explain it clearly and naturally."
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
function buildGreetingReply(core) {
  const name = core?.name || "Elena";
  return `Hey — I’m ${name}, your OrozcoRealty concierge. I can help with Texas home prices, monthly payment pressure, affordability, and market questions like San Antonio or McAllen. Ask me a price, payment, city, buyer, seller, or investor question and I’ll break it down.`;
}

function buildCapabilityReply(core) {
  const name = core?.name || "Elena";
  return `${name} can help with Texas home affordability, estimated monthly payments, payment-to-price questions, buyer and seller strategy, and market reads for selected cities. I can also explain ownership costs like property taxes, insurance, HOA, and what those numbers mean in plain English.`;
}

function buildEmergencyFallback({ message, agentPacket, core }) {
  if (isGreeting(message)) return buildGreetingReply(core);
  if (isCapabilityQuestion(message)) return buildCapabilityReply(core);

  const verdict = agentPacket?.verdict || {};
  const mortgage = agentPacket?.mortgage || {};
  const paymentToPrice = agentPacket?.payment_to_price || {};
  const nextAction = agentPacket?.next_action || {};
  const market = agentPacket?.market?.summary || null;

  const lines = [];

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
  const email = normalizeEmail(body?.email || body?.context?.email || body?.context?.profile?.email);
  const marketSlug = safeStr(body?.marketSlug || body?.context?.marketSlug || body?.overrides?.marketSlug);
  const debug = body?.debug === true;

  if (!message) {
    return respond(400, { ok: false, error: "Missing message" }, origin);
  }

  const API_BASE = pickApiBase(event);
  const packs = await loadCorePacks();

  // Decide whether deterministic agent should be consulted.
  let agentPacket = null;
  let agentMeta = { called: false, ok: false, status: null, error: null };

  if (likelyNeedsAgent(message)) {
    agentMeta.called = true;
    const agentRes = await callElenaAgent({
      API_BASE,
      message,
      email,
      marketSlug,
      body
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
    packs
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
      core: packs.core
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

  if (debug) {
    payload.debug = {
      API_BASE,
      message,
      email: email || null,
      marketSlug: marketSlug || null,
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

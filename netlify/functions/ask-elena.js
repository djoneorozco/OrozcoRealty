// netlify/functions/ask-elena.js
// Full Upgrade — Intent Router + Smart Concierge Flow
// CommonJS + Node 18 native fetch

const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://new-real-estate-purchase.webflow.io",
  "https://theorozcorealty.netlify.app",
  "http://localhost:8888"
];

function corsHeaders(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Content-Type": "application/json",
  };
}

// ------------------------------------------------------------
// 1) INTENT ROUTER — Elena's brain
// ------------------------------------------------------------

function detectIntent(text) {
  const t = text.toLowerCase();

  // Financial Dashboard / Budget / Affordability
  if (
    t.includes("budget") ||
    t.includes("afford") ||
    t.includes("income") ||
    t.includes("expenses") ||
    t.includes("bah") ||
    t.includes("mortgage") ||
    t.includes("financial")
  ) {
    return {
      type: "financial_dashboard",
      reply:
        "To get started, let’s build your true financial profile.\n\nHere’s your Financial Dashboard — it calculates disposable income, affordability, and a clear monthly picture:\n\n**https://theorozcorealty.com/dashboard**\n\nOnce you complete it, I’ll walk you through your Fiduciary Analysis.",
    };
  }

  // Analysis / Memo
  if (
    t.includes("analysis") ||
    t.includes("memo") ||
    t.includes("fiduciary") ||
    t.includes("results")
  ) {
    return {
      type: "analysis",
      reply:
        "Your Fiduciary Snapshot explains your real affordability, monthly cushion, and financial risk level.\n\nIf you’ve already completed the dashboard, open your Analysis page here:\n\n**https://theorozcorealty.com/analysis**\n\nAsk me anything about your numbers — I’ll break them down clearly.",
    };
  }

  // AIOU Test
  if (
    t.includes("aiou") ||
    t.includes("psych") ||
    t.includes("personality") ||
    t.includes("code") ||
    t.includes("unlock")
  ) {
    return {
      type: "aiou",
      reply:
        "Next step is your A.I.O.U Personality Test — it reveals your buying psychology and generates your **6-digit unlock code** for RealtySaSS.\n\nBegin the test here:\n\n**https://theorozcorealty.com/aiou**\n\nIt’s quick, insightful, and essential for the House of SaSS.",
    };
  }

  // RealtySaSS Unlock
  if (
    t.includes("realtysass") ||
    t.includes("sass") ||
    t.includes("unlock") ||
    t.includes("tools")
  ) {
    return {
      type: "sass_unlock",
      reply:
        "RealtySaSS is our private suite of intelligent tools — Re-Defined, Flip.ai, calculators, deep analysis, and more.\n\nEnter your unlock code here:\n\n**https://theorozcorealty.com/realtysass**\n\nIf you don’t have a code yet, take the AIOU test and I’ll prepare it for you.",
    };
  }

  // Blog intent — VA Loan
  if (t.includes("va loan") || t.includes("va") || t.includes("certificate")) {
    return {
      type: "blog_va",
      reply:
        "Here’s the clean, simple walkthrough of the **VA Loan Process**:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/va-loan-process\n\nIf you want, I can also break down eligibility, COE, or funding fee for you.",
    };
  }

  // Blog intent — Buying Steps
  if (
    t.includes("steps") ||
    t.includes("first time") ||
    t.includes("buying") ||
    t.includes("process")
  ) {
    return {
      type: "blog_steps",
      reply:
        "Here’s your guide to the **Home Buying Steps** — simple, clear, and military-friendly:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps\n\nWant me to match these steps to your situation?",
    };
  }

  // Blog intent — Realtor?
  if (t.includes("realtor") || t.includes("agent")) {
    return {
      type: "blog_realtor",
      reply:
        "Most people don’t know this — here’s the article on whether you actually **need a realtor**:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/do-i-need-a-realtor\n\nIf you’d like, I can explain the pros and cons for military buyers.",
    };
  }

  // Blog intent — Risks
  if (t.includes("risk") || t.includes("danger") || t.includes("mistake")) {
    return {
      type: "blog_risks",
      reply:
        "Here’s a clean breakdown of the **benefits & risks** of buying a home:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps\n\nI can also walk you through the risks based on your income, rank, and timeline.",
    };
  }

  return null; // no matched intent
}

// ------------------------------------------------------------
// 2) HANDLER
// ------------------------------------------------------------

module.exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // Parse body
  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const userText = (payload.message || "").toString().trim();
  if (!userText) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing message" }),
    };
  }

  // ------------------------------------------------------------
  // 3) Intent Routing FIRST
  // ------------------------------------------------------------

  const intent = detectIntent(userText);
  if (intent) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: intent.reply,
        intent: intent.type,
      }),
    };
  }

  // ------------------------------------------------------------
  // 4) If no intent matched → use OpenAI
  // ------------------------------------------------------------

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply:
          `Elena (dev echo): “${userText}” — Add OPENAI_API_KEY to enable real answers.`,
      }),
    };
  }

  const system = [
    "You are Elena, a warm, seductive, emotionally-intelligent A.I. Concierge for OrozcoRealty.",
    "Your voice blends luxury intimacy with professional clarity.",
    "You guide users through: Financial Dashboard → Analysis → AIOU Test → RealtySaSS Unlock.",
    "You always keep answers under 8 sentences, and offer a next step or link.",
    "Tone: warm, reassuring, intelligent, strategic, slightly flirty, never explicit.",
  ].join(" ");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: userText },
  ];

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 500,
        messages,
      }),
    });

    const data = await resp.json();
    const reply =
      (data?.choices?.[0]?.message?.content || "").trim() ||
      "I’m right here. What would you like to explore next?";

    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server exception", detail: String(err) }),
    };
  }
};

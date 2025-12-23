// netlify/functions/ask-elena.js
// v2.0 — Profile-Aware Concierge + Deterministic Pay Snapshot
// CommonJS • Node 18 native fetch
//
// What’s new:
// - Reads identity from payload.context.email (or payload.email)
// - Fetches user profile from Supabase public.profiles
// - Computes Base Pay / BAH / Total via /api/pay-tables when possible
// - Uses intent router first, but now can answer “rank” / “total pay” directly
//
// ENV REQUIRED:
// - SUPABASE_URL
// - SUPABASE_SERVICE_KEY   (service role key; read access to public.profiles)
//
// ENV OPTIONAL:
// - PAY_TABLES_ORIGIN  (default: https://theorozcorealty.com)
//   Should be the domain that serves /api/pay-tables (your Netlify redirect)

const { createClient } = require("@supabase/supabase-js");

const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://new-real-estate-purchase.webflow.io",
  "https://www.new-real-estate-purchase.webflow.io",
  "https://theorozcorealty.netlify.app",
  "http://localhost:8888",
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

/* ============================================================
   //#1 — SUPABASE
============================================================ */
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/* ============================================================
   //#2 — HELPERS (safe parsing + profile normalization)
============================================================ */
function safeJsonParse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch (_) {
    return {};
  }
}

function normStr(v) {
  return String(v || "").trim();
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").toLowerCase().trim();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return null;
}

function redactProfile(p) {
  if (!p) return null;
  return {
    email: p.email || null,
    full_name: p.full_name || p.name || null,
    rank: p.rank || p.rank_paygrade || null,
    yos: p.yos || p.years_of_service || null,
    family: p.family ?? p.dependents ?? null,
    base: p.base || null,
    zip:
      p.zip ||
      p.bah_zip ||
      p.postal_code ||
      p.duty_zip ||
      null,
    va_disability: p.va_disability ?? null,
  };
}

/* ============================================================
   //#3 — PROFILE FETCH
============================================================ */
async function fetchProfileByEmail(email) {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: "Supabase not configured" };

  const e = normStr(email).toLowerCase();
  if (!e) return { ok: false, error: "Missing email" };

  // Try both possible column names (some builds use email, some user_email)
  // We’ll attempt "email" first.
  let { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", e)
    .maybeSingle();

  if (error) return { ok: false, error: String(error.message || error) };
  if (!data) {
    // Fallback: user_email (if your schema differs)
    const alt = await supabase
      .from("profiles")
      .select("*")
      .eq("user_email", e)
      .maybeSingle();

    if (alt?.error) return { ok: false, error: String(alt.error.message || alt.error) };
    data = alt?.data || null;
  }

  if (!data) return { ok: false, error: "Profile not found" };
  return { ok: true, profile: data };
}

/* ============================================================
   //#4 — PAY COMPUTE (server-side call to /api/pay-tables)
============================================================ */
async function computePaySnapshotFromProfile(profile) {
  const origin = normStr(process.env.PAY_TABLES_ORIGIN) || "https://theorozcorealty.com";

  const rank = normStr(pickFirst(profile, ["rank_paygrade", "rank"]));
  const yosRaw = pickFirst(profile, ["yos", "years_of_service"]);
  const zip = normStr(pickFirst(profile, ["bah_zip", "zip", "postal_code", "duty_zip"]));
  const fam = pickFirst(profile, ["family", "dependents"]);

  const yos = Number(yosRaw);
  const family = toBool(fam);

  // We can still be useful without ZIP (Base Pay only),
  // but the /api/pay-tables needs ZIP for BAH.
  const payload = {
    rank: rank || null,
    yos: Number.isFinite(yos) ? yos : null,
    zip: zip || null,
    family: family === null ? false : family,
  };

  // If we don't have the minimum, bail gracefully
  if (!payload.rank || !payload.yos) {
    return {
      ok: false,
      error: "Missing rank or years of service",
      used: payload,
    };
  }

  // Call your existing deterministic endpoint
  // NOTE: uses your Netlify redirect convention: /api/*
  try {
    const res = await fetch(`${origin}/api/pay-tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error || `pay-tables failed (${res.status})`,
        used: payload,
      };
    }

    return {
      ok: true,
      used: payload,
      pay: {
        rank: data.rank || payload.rank,
        rankTitle: data.rankTitle || null,
        yos: data.yos ?? payload.yos,
        zip: data.zip ?? payload.zip,
        basePay: Number(data.basePay || 0),
        bah: Number(data.bah || 0),
        total: Number(data.total || 0),
      },
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), used: payload };
  }
}

/* ============================================================
   //#5 — INTENT ROUTER (now profile-aware)
============================================================ */
function detectIntent(text) {
  const t = String(text || "").toLowerCase();

  // Rank / pay / compensation
  if (
    t.includes("my rank") ||
    t.includes("what is my rank") ||
    t.includes("rank am i")
  ) {
    return { type: "rank_lookup" };
  }

  if (
    t.includes("total pay") ||
    t.includes("monthly total") ||
    t.includes("monthly pay") ||
    t.includes("how much do i make") ||
    t.includes("my pay") ||
    t.includes("compensation") ||
    t.includes("base pay") ||
    t.includes("bah") ||
    t.includes("bas")
  ) {
    return { type: "pay_lookup" };
  }

  // Financial Dashboard / Budget / Affordability
  if (
    t.includes("budget") ||
    t.includes("afford") ||
    t.includes("expenses") ||
    t.includes("mortgage") ||
    t.includes("financial")
  ) {
    return { type: "financial_dashboard" };
  }

  // Analysis / Memo
  if (t.includes("analysis") || t.includes("memo") || t.includes("fiduciary") || t.includes("results")) {
    return { type: "analysis" };
  }

  // AIOU Test
  if (t.includes("aiou") || t.includes("psych") || t.includes("personality") || t.includes("code") || t.includes("unlock")) {
    return { type: "aiou" };
  }

  // RealtySaSS Unlock
  if (t.includes("realtysass") || t.includes("sass") || t.includes("unlock") || t.includes("tools")) {
    return { type: "sass_unlock" };
  }

  // Blog intents (keep your originals)
  if (t.includes("va loan") || (t.includes("va") && t.includes("loan")) || t.includes("certificate")) {
    return { type: "blog_va" };
  }
  if (t.includes("steps") || t.includes("first time") || t.includes("buying") || t.includes("process")) {
    return { type: "blog_steps" };
  }
  if (t.includes("realtor") || t.includes("agent")) {
    return { type: "blog_realtor" };
  }
  if (t.includes("risk") || t.includes("danger") || t.includes("mistake")) {
    return { type: "blog_risks" };
  }

  return null;
}

function fmtUSD(n) {
  return (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function buildRankPayReply(profileSafe, paySnap) {
  const name = normStr(profileSafe?.full_name) || "Service Member";
  const rank = normStr(profileSafe?.rank) || "—";
  const yos = profileSafe?.yos ?? "—";
  const base = normStr(profileSafe?.base) || "—";
  const zip = normStr(profileSafe?.zip) || "";

  if (!paySnap?.ok) {
    // Still return something useful
    return (
      `Got you, ${name}. Here’s what I can see on file:\n\n` +
      `• Rank: **${rank}**\n` +
      `• YOS: **${yos}**\n` +
      `• Base: **${base}**\n\n` +
      `I can calculate your **Base Pay + BAH + Total** as soon as your profile includes a valid **ZIP** for BAH (or you tell me the ZIP).`
    );
  }

  const p = paySnap.pay || {};
  const basNote = "BAS is not included in the pay-tables total unless you add it separately in your dashboard logic.";
  return (
    `Yes, ${name} — I’ve got you.\n\n` +
    `• Rank: **${p.rankTitle || p.rank}**, YOS **${p.yos}**\n` +
    `• Base Pay: **${fmtUSD(p.basePay)} / mo**\n` +
    `• BAH: **${fmtUSD(p.bah)} / mo** ${zip ? `(ZIP ${zip})` : ""}\n` +
    `• Total (Base + BAH): **${fmtUSD(p.total)} / mo**\n\n` +
    `${basNote}`
  );
}

/* ============================================================
   //#6 — HANDLER
============================================================ */
module.exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // Parse body
  let payload = {};
  try {
    payload = safeJsonParse(event.body);
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const userText = normStr(payload.message);
  if (!userText) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing message" }) };

  // ============================================================
  // //#6.1 — OPTIONAL: attach user identity
  // We expect: payload.context.email (preferred) OR payload.email
  // ============================================================
  const ctx = payload.context && typeof payload.context === "object" ? payload.context : {};
  const email = normStr(ctx.email || payload.email || "");

  let profile = null;
  let profileSafe = null;
  let paySnap = null;

  if (email) {
    const profRes = await fetchProfileByEmail(email);
    if (profRes.ok) {
      profile = profRes.profile;
      profileSafe = redactProfile(profile);
      paySnap = await computePaySnapshotFromProfile(profile);
    }
  }

  // ============================================================
  // //#6.2 — INTENT ROUTING FIRST (profile-aware)
  // ============================================================
  const intent = detectIntent(userText);

  if (intent?.type === "rank_lookup") {
    if (!profileSafe) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          intent: "rank_lookup",
          reply:
            "I can answer that instantly once I can see your profile. Quick fix: make sure the chat request sends your email (from your saved profile) so I can pull your rank + YOS from Supabase.",
        }),
      };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "rank_lookup",
        reply: `On file: **${profileSafe.rank || "—"}** (YOS **${profileSafe.yos ?? "—"}**).`,
        profile: profileSafe,
      }),
    };
  }

  if (intent?.type === "pay_lookup") {
    if (!profileSafe) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          intent: "pay_lookup",
          reply:
            "I can calculate your monthly total pay the moment I can see your profile. Right now I’m missing identity context. Send your email with the chat request and I’ll pull Rank/YOS/ZIP from Supabase automatically.",
        }),
      };
    }

    const reply = buildRankPayReply(profileSafe, paySnap);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "pay_lookup",
        reply,
        profile: profileSafe,
        pay: paySnap?.ok ? paySnap.pay : null,
      }),
    };
  }

  // Your original “guided funnel” replies — now upgraded with identity if available
  if (intent?.type === "financial_dashboard") {
    const who = profileSafe?.rank && profileSafe?.full_name
      ? `${profileSafe.rank} ${profileSafe.full_name}`
      : "you";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "financial_dashboard",
        reply:
          `Copy that — let’s build your true financial profile first, so we don’t guess.\n\n` +
          `For ${who}, the fastest path is the Full Financial Analysis tool. Once your obligations are itemized, I’ll give you a clean affordability verdict.\n\n` +
          `Open it here:\n**https://theorozcorealty.com/dashboard**`,
        profile: profileSafe || undefined,
      }),
    };
  }

  if (intent?.type === "analysis") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "analysis",
        reply:
          "Your Fiduciary Snapshot explains affordability, monthly cushion, and risk level.\n\nIf you’ve already completed the dashboard, open your Analysis page here:\n\n**https://theorozcorealty.com/analysis**\n\nAsk me anything about your numbers — I’ll break them down cleanly.",
      }),
    };
  }

  if (intent?.type === "aiou") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "aiou",
        reply:
          "Next step is your A.I.O.U Personality Test — it reveals your buying psychology and generates your **6-digit unlock code** for RealtySaSS.\n\nBegin here:\n\n**https://theorozcorealty.com/aiou**",
      }),
    };
  }

  if (intent?.type === "sass_unlock") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "sass_unlock",
        reply:
          "RealtySaSS is our private suite of tools.\n\nEnter your unlock code here:\n\n**https://theorozcorealty.com/realtysass**\n\nIf you don’t have a code yet, take AIOU and I’ll prepare it for you.",
      }),
    };
  }

  if (intent?.type === "blog_va") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "blog_va",
        reply:
          "Here’s the clean walkthrough of the **VA Loan Process**:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/va-loan-process\n\nWant me to tailor this to your timeline + base?",
      }),
    };
  }

  if (intent?.type === "blog_steps") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "blog_steps",
        reply:
          "Here’s your guide to the **Home Buying Steps**:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps\n\nWant me to match these steps to your situation?",
      }),
    };
  }

  if (intent?.type === "blog_realtor") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "blog_realtor",
        reply:
          "Here’s the article on whether you actually **need a realtor**:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/do-i-need-a-realtor\n\nWant the pros/cons for military buyers?",
      }),
    };
  }

  if (intent?.type === "blog_risks") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        intent: "blog_risks",
        reply:
          "Here’s a clean breakdown of the **benefits & risks** of buying:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps\n\nIf you tell me your target price, I’ll flag the risk points precisely.",
      }),
    };
  }

  // ============================================================
  // //#6.3 — FALLBACK: OpenAI (with profile context if available)
  // ============================================================
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: `Elena (dev echo): “${userText}” — Add OPENAI_API_KEY to enable real answers.`,
        profile: profileSafe || null,
        pay: paySnap?.ok ? paySnap.pay : null,
      }),
    };
  }

  const system = [
    "You are Elena, a warm, emotionally-intelligent A.I. Concierge for OrozcoRealty.",
    "Voice: luxury-smooth, high-trust, professional, never explicit.",
    "You prioritize deterministic facts provided in context (profile + pay) and never invent numbers.",
    "Keep answers under 8 sentences and give a crisp next step.",
  ].join(" ");

  const contextFacts = {
    hasProfile: Boolean(profileSafe),
    profile: profileSafe || null,
    pay: paySnap?.ok ? paySnap.pay : null,
  };

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `Context (use if present; do NOT invent):\n${JSON.stringify(contextFacts)}\n\nUser:\n${userText}`,
    },
  ];

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.35,
        max_tokens: 450,
        messages,
      }),
    });

    const data = await resp.json().catch(() => ({}));
    const reply = normStr(data?.choices?.[0]?.message?.content) || "I’m right here. What are we solving today?";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply,
        profile: profileSafe || null,
        pay: paySnap?.ok ? paySnap.pay : null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server exception", detail: String(err?.message || err) }),
    };
  }
};

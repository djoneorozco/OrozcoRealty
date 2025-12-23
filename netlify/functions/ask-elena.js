// netlify/functions/ask-elena.js
// Elena — Profile-Aware Concierge v2.0
// - Keeps your Intent Router
// - Adds Supabase profile lookup (public.profiles) when email is provided
// - Adds deterministic pay awareness (Base Pay + BAS always; BAH if ZIP table available)
// - Prevents "income" keyword from immediately routing users away if we can answer now
// CommonJS + Node 18 native fetch

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

/* ============================================================
   //#0 — CORS
============================================================ */
const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://new-real-estate-purchase.webflow.io",
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
   //#1 — SUPABASE (Service Role)
   ENV REQUIRED:
   - SUPABASE_URL
   - SUPABASE_SERVICE_KEY
============================================================ */
function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY; // service role (server only)
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { "X-Client-Info": "ask-elena-v2.0" } },
  });
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

async function fetchProfileByEmail(email) {
  const e = normEmail(email);
  if (!e) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  // Pull only what we need (don’t over-fetch)
  const { data, error } = await supabase
    .from("profiles")
    .select(
      [
        "email",
        "full_name",
        "rank",
        "rank_paygrade",
        "years_of_service",
        "yos",
        "base",
        "zip",
        "family",
        "va_disability",
        "mode",
      ].join(",")
    )
    .eq("email", e)
    .maybeSingle();

  if (error) return null;
  return data || null;
}

/* ============================================================
   //#2 — PAY TABLES (Deterministic)
   Uses local JSON if present:
   netlify/functions/data/militaryPayTables.json
   (You already have this file per your system memory.)
============================================================ */
let __PAY_TABLES_CACHE__ = null;

function loadPayTablesSafe() {
  try {
    if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;
    const fp = path.join(__dirname, "data", "militaryPayTables.json");
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf8");
    const json = JSON.parse(raw);
    __PAY_TABLES_CACHE__ = json;
    return json;
  } catch (_) {
    return null;
  }
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickClosestLE(keys, target) {
  // keys are strings (e.g., "0","1","2","3","4","5","6","8","10","12","14","16","18","20","22","24","26","28","30")
  // pick closest <= target, else smallest
  const nums = keys
    .map((k) => ({ k, n: Number(k) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n);

  if (!nums.length) return null;

  let best = nums[0].k;
  for (const item of nums) {
    if (item.n <= target) best = item.k;
    else break;
  }
  return best;
}

function inferPaygrade(profile) {
  // Prefer rank_paygrade like "E-7"
  const rp = String(profile?.rank_paygrade || "").trim();
  if (rp) return rp;

  // Fallback: if profile.rank is "MSgt", you can’t deterministically map without a dictionary.
  // We’ll return empty and still answer with what we can.
  return "";
}

function inferIsOfficer(paygrade) {
  const pg = String(paygrade || "").toUpperCase();
  return pg.startsWith("O-") || pg.startsWith("O");
}

function hasDependentsFromProfile(profile) {
  // Your profile "family" is often a number (e.g., 7).
  // If family > 1 → has dependents.
  const fam = toNum(profile?.family);
  if (fam === null) return null;
  return fam > 1;
}

function dollars(n) {
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function computeMonthlyPayFromTables(profile) {
  const tables = loadPayTablesSafe();
  if (!tables) return null;

  const paygrade = inferPaygrade(profile);
  const yosRaw = toNum(profile?.years_of_service ?? profile?.yos);
  const yos = yosRaw === null ? null : Math.max(0, Math.floor(yosRaw));

  const isOfficer = inferIsOfficer(paygrade);

  // BASEPAY
  let basePay = null;
  if (paygrade && yos !== null && tables?.BASEPAY?.[paygrade]) {
    const yosKeys = Object.keys(tables.BASEPAY[paygrade] || {});
    const k = pickClosestLE(yosKeys, yos);
    if (k && tables.BASEPAY[paygrade][k] != null) basePay = Number(tables.BASEPAY[paygrade][k]);
  }

  // BAS
  let bas = null;
  const basTable = tables?.BAS;
  if (basTable) {
    const key = isOfficer ? "officer" : "enlisted";
    if (basTable[key] != null) bas = Number(basTable[key]);
  }

  // BAH (only if we have ZIP + table includes it)
  let bah = null;
  const zip = String(profile?.zip || "").trim();
  const bahTx = tables?.BAH_TX;
  if (zip && bahTx && bahTx[zip]) {
    const hasDeps = hasDependentsFromProfile(profile);
    const depBucket =
      hasDeps === true ? "with" : hasDeps === false ? "without" : "with"; // default to "with" if unknown

    // Table structure in your memory:
    // BAH_TX[ZIP] -> { with{rank:bah}, without{rank:bah} }
    const rankKey = paygrade || "";
    const v = bahTx[zip]?.[depBucket]?.[rankKey];
    if (v != null) bah = Number(v);
  }

  const total = [basePay, bas, bah].filter((x) => Number.isFinite(x)).reduce((a, b) => a + b, 0) || null;

  return {
    paygrade: paygrade || null,
    yos: yos !== null ? yos : null,
    basePay: Number.isFinite(basePay) ? basePay : null,
    bas: Number.isFinite(bas) ? bas : null,
    bah: Number.isFinite(bah) ? bah : null,
    total: Number.isFinite(total) ? total : null,
    zip: zip || null,
  };
}

/* ============================================================
   //#3 — INTENT ROUTER (Upgraded: profile-aware)
============================================================ */
function isCompensationQuestion(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("how much") ||
    t.includes("make") ||
    t.includes("salary") ||
    t.includes("income") ||
    t.includes("base pay") ||
    t.includes("bah") ||
    t.includes("bas") ||
    t.includes("total pay") ||
    t.includes("compensation")
  );
}

function detectIntent(text, ctx) {
  const t = String(text || "").toLowerCase();
  const hasProfile = !!ctx?.profile;

  // ------------------------------------------------------------
  // 1) PAY / INCOME — If we can answer with profile, do it first
  // ------------------------------------------------------------
  if (isCompensationQuestion(t) && hasProfile) {
    const pay = ctx?.pay || null;

    // Build a precise, honest answer from what we actually know
    const name = String(ctx.profile?.full_name || "").trim() || "you";
    const rank = String(ctx.profile?.rank || ctx.profile?.rank_paygrade || "").trim();
    const yos = ctx.profile?.years_of_service ?? ctx.profile?.yos;

    // Always: Base Pay + BAS if available
    const basePayStr = pay?.basePay != null ? dollars(pay.basePay) : null;
    const basStr = pay?.bas != null ? dollars(pay.bas) : null;
    const bahStr = pay?.bah != null ? dollars(pay.bah) : null;
    const totalStr = pay?.total != null ? dollars(pay.total) : null;

    let reply = "";

    // If we have strong numbers:
    if (basePayStr || basStr || bahStr) {
      reply += `Here’s what I can calculate right now for ${name}${rank ? ` (${rank}` : ""}${yos != null ? `, ${yos} YOS` : ""}:\n\n`;

      if (basePayStr) reply += `• Base Pay (monthly): **${basePayStr}**\n`;
      if (basStr) reply += `• BAS (monthly): **${basStr}**\n`;

      if (bahStr) {
        reply += `• BAH (monthly): **${bahStr}**${pay?.zip ? ` (ZIP ${pay.zip})` : ""}\n`;
      } else {
        reply += `• BAH: I can calculate this once I have your **ZIP** (BAH is ZIP-specific).\n`;
      }

      if (totalStr) reply += `\n**Estimated monthly total:** **${totalStr}**\n`;

      reply += `\nIf you want, tell me your ZIP and whether you have dependents, and I’ll pin your BAH exactly.`;
    } else {
      // We have profile but not enough to compute
      reply =
        `I can see your profile, but I’m missing the fields needed to compute your pay precisely (paygrade/YOS/ZIP).\n\n` +
        `If you give me your **paygrade (ex: E-7)**, **years of service**, and **ZIP**, I’ll calculate Base Pay + BAS + BAH.`;
    }

    return { type: "compensation", reply };
  }

  // ------------------------------------------------------------
  // 2) Financial Dashboard / Budget / Affordability
  // (Do NOT auto-route purely on “income” if no profile OR if user asked “how much do I make”)
  // ------------------------------------------------------------
  if (
    t.includes("budget") ||
    t.includes("afford") ||
    t.includes("expenses") ||
    t.includes("mortgage") ||
    t.includes("financial") ||
    (t.includes("income") && !isCompensationQuestion(t)) ||
    t.includes("debt") ||
    t.includes("obligation")
  ) {
    const prefix = hasProfile
      ? `I can see your profile basics already. Now let’s build your *true* monthly picture (debt + expenses + savings).\n\n`
      : `To get started, let’s build your true financial profile.\n\n`;

    return {
      type: "financial_dashboard",
      reply:
        prefix +
        `Open your Financial Dashboard here:\n\n` +
        `**https://theorozcorealty.com/dashboard**\n\n` +
        `Once that’s filled out, I’ll give you a clean affordability verdict (safe / tight / high risk) and next steps.`,
    };
  }

  // ------------------------------------------------------------
  // 3) Analysis / Memo
  // ------------------------------------------------------------
  if (t.includes("analysis") || t.includes("memo") || t.includes("fiduciary") || t.includes("results")) {
    return {
      type: "analysis",
      reply:
        `Your Fiduciary Snapshot explains real affordability, monthly cushion, and risk level.\n\n` +
        `If you’ve completed the dashboard, open your Analysis page here:\n\n` +
        `**https://theorozcorealty.com/analysis**\n\n` +
        `Ask me what looks “off” and I’ll break it down clearly.`,
    };
  }

  // ------------------------------------------------------------
  // 4) AIOU Test
  // ------------------------------------------------------------
  if (t.includes("aiou") || t.includes("psych") || t.includes("personality") || t.includes("code") || t.includes("unlock")) {
    return {
      type: "aiou",
      reply:
        `Next step is your A.I.O.U Personality Test — it reveals your buying psychology and generates your unlock code.\n\n` +
        `Begin here:\n\n` +
        `**https://theorozcorealty.com/aiou**\n\n` +
        `It’s quick, insightful, and it makes the rest of the system feel “made for you.”`,
    };
  }

  // ------------------------------------------------------------
  // 5) RealtySaSS Unlock
  // ------------------------------------------------------------
  if (t.includes("realtysass") || t.includes("sass") || t.includes("unlock") || t.includes("tools")) {
    return {
      type: "sass_unlock",
      reply:
        `RealtySaSS is our private suite of intelligent tools.\n\n` +
        `Enter your unlock code here:\n\n` +
        `**https://theorozcorealty.com/realtysass**\n\n` +
        `If you don’t have a code yet, take AIOU and I’ll line it up for you.`,
    };
  }

  // ------------------------------------------------------------
  // 6) Blog intents
  // ------------------------------------------------------------
  if (t.includes("va loan") || (t.includes("va") && t.includes("certificate"))) {
    return {
      type: "blog_va",
      reply:
        `Here’s the clean walkthrough of the VA Loan Process:\n\n` +
        `https://new-real-estate-purchase.webflow.io/blog-page/va-loan-process\n\n` +
        `If you tell me your timeline + credit range, I’ll tailor the steps.`,
    };
  }

  if (t.includes("steps") || t.includes("first time") || t.includes("buying") || t.includes("process")) {
    return {
      type: "blog_steps",
      reply:
        `Here’s your guide to Home Buying Steps:\n\n` +
        `https://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps\n\n` +
        `Want me to map these steps to your situation?`,
    };
  }

  if (t.includes("realtor") || t.includes("agent")) {
    return {
      type: "blog_realtor",
      reply:
        `Here’s the article on whether you actually need a realtor:\n\n` +
        `https://new-real-estate-purchase.webflow.io/blog-page/do-i-need-a-realtor\n\n` +
        `If you tell me your market + timeline, I’ll give you the pros/cons.`,
    };
  }

  if (t.includes("risk") || t.includes("danger") || t.includes("mistake")) {
    return {
      type: "blog_risks",
      reply:
        `Here’s a clean breakdown of risks and benefits of buying:\n\n` +
        `https://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps\n\n` +
        `If you share your price target and debts, I’ll call the risk level bluntly.`,
    };
  }

  return null;
}

/* ============================================================
   //#4 — OPENAI FALLBACK
============================================================ */
async function callOpenAI({ userText, profile, pay }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return `Elena (dev echo): “${userText}” — Add OPENAI_API_KEY to enable real answers.`;
  }

  // Keep it short + directive, but now WITH profile context
  const systemParts = [
    "You are Elena, a warm, emotionally-intelligent A.I. Concierge for OrozcoRealty.",
    "Voice: high-trust, calm, strategic, slightly playful, never explicit.",
    "Keep answers under 8 sentences. End with a next step.",
    "Use deterministic numbers provided in context; do NOT invent pay, BAH, BAS, debts, or rates.",
  ];

  const profileBrief = profile
    ? {
        full_name: profile.full_name || null,
        rank: profile.rank || null,
        rank_paygrade: profile.rank_paygrade || null,
        years_of_service: profile.years_of_service ?? profile.yos ?? null,
        base: profile.base || null,
        family: profile.family || null,
        va_disability: profile.va_disability || null,
        zip: profile.zip || null,
        mode: profile.mode || null,
      }
    : null;

  const payBrief = pay
    ? {
        basePay_monthly: pay.basePay ?? null,
        bas_monthly: pay.bas ?? null,
        bah_monthly: pay.bah ?? null,
        total_monthly_estimate: pay.total ?? null,
        zip_used_for_bah: pay.zip ?? null,
      }
    : null;

  const contextBlock = {
    profile: profileBrief,
    pay: payBrief,
    rules: {
      if_missing_bah_zip: "If BAH is null, ask for ZIP and dependents.",
      if_user_asks_income: "Explain what you can compute now (base pay + BAS) and what you need for BAH.",
    },
  };

  const messages = [
    { role: "system", content: systemParts.join(" ") },
    {
      role: "system",
      content:
        "Context JSON (truth source, do not fabricate beyond this):\n" + JSON.stringify(contextBlock),
    },
    { role: "user", content: userText },
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 500,
      messages,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  const reply = (data?.choices?.[0]?.message?.content || "").trim();
  return reply || "I’m right here. What would you like to do next?";
}

/* ============================================================
   //#5 — HANDLER
============================================================ */
module.exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // Parse body
  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const userText = String(payload.message || "").trim();
  if (!userText) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing message" }) };
  }

  /* ============================================================
     //#5.1 — PROFILE CONTEXT (email passed from UI)
     Supported places to send email:
     - payload.email
     - payload.context.email
     - payload.context.identity.email
  ============================================================ */
  const email =
    normEmail(payload?.email) ||
    normEmail(payload?.context?.email) ||
    normEmail(payload?.context?.identity?.email);

  let profile = null;
  if (email) {
    profile = await fetchProfileByEmail(email);
  }

  // Deterministic pay summary if we can
  const pay = profile ? computeMonthlyPayFromTables(profile) : null;

  /* ============================================================
     //#6 — INTENT ROUTING FIRST (NOW PROFILE-AWARE)
  ============================================================ */
  const intent = detectIntent(userText, { profile, pay });
  if (intent) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: intent.reply,
        intent: intent.type,
        profile_found: !!profile,
        pay_known: !!pay,
      }),
    };
  }

  /* ============================================================
     //#7 — OPENAI FALLBACK (WITH CONTEXT)
  ============================================================ */
  try {
    const reply = await callOpenAI({ userText, profile, pay });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply,
        intent: "openai_fallback",
        profile_found: !!profile,
        pay_known: !!pay,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server exception", detail: String(err) }),
    };
  }
};

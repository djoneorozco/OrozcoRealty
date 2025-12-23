// netlify/functions/ask-elena.js
// v2.1 — Profile-Aware Elena (Supabase profile lookup + deterministic pay basics)
//
// WHAT THIS DOES:
// 1) Pulls user's Supabase profile by email (same idea as profile-by-email.js)
// 2) Uses profile context for replies (rank/yos/base/family/VA/name)
// 3) Answers "what's my rank" / "what's my monthly pay" using deterministic pay tables:
//    - Base Pay + BAS always (if rank + YOS exist)
//    - BAH only if ZIP provided (or later if you add ZIP/base->zip mapping)
//
// REQUIRED ENV:
// - SUPABASE_URL
// - SUPABASE_SERVICE_KEY
// - (optional) OPENAI_API_KEY  (used only for non-deterministic Qs)
//
// OPTIONAL LOCAL FILE (recommended):
// - netlify/functions/data/militaryPayTables.json  (same as your pay-tables.js uses)

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://www.theorozcorealty.com",
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

function respond(statusCode, headers, payload) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload || {}),
  };
}

/* ============================================================
   //#1 — Profile helpers (match profile-by-email.js)
============================================================ */
const SELECT_COLS = [
  "id",
  "created_at",
  "profiles_user_id_unique",
  "email",
  "full_name",
  "last_name",
  "phone",
  "mode",
  "rank",
  "rank_paygrade",
  "va_disability",
  "yos",
  "family",
  "base",
  "notes",
].join(",");

function normalizeEmail(x) {
  return String(x || "").trim().toLowerCase();
}

function getEmailFromPayload(payload) {
  // Accept email from multiple places (so your UI can send it however is easiest)
  const direct = normalizeEmail(payload.email);
  if (direct) return direct;

  const ctx = payload.context || {};
  const ctxEmail = normalizeEmail(ctx.email);
  if (ctxEmail) return ctxEmail;

  const ctxProfileEmail = normalizeEmail(ctx.profile?.email);
  if (ctxProfileEmail) return ctxProfileEmail;

  const identEmail = normalizeEmail(payload.identity?.email);
  if (identEmail) return identEmail;

  return "";
}

function safeStr(x) {
  const s = String(x ?? "").trim();
  return s || "";
}

function lastNameOf(fullName, lastNameField) {
 жы
  const ln = safeStr(lastNameField);
  if (ln) return ln;

  const name = safeStr(fullName);
  if (!name) return "";
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * Normalize paygrade to match your pay tables keys.
 * Examples:
 *  - "E7"  -> "E-7"
 *  - "E-7" -> "E-7"
 *  - "O1"  -> "O-1"
 *  - "W3"  -> "W-3"
 */
function normalizePaygrade(x) {
  const raw = safeStr(x).toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";

  // already has hyphen
  if (/^[EOW]-\d{1,2}$/.test(raw)) return raw;

  // compact form (E7/O1/W3)
  if (/^[EOW]\d{1,2}$/.test(raw)) {
    return raw[0] + "-" + raw.slice(1);
  }

  // if they stored rank like "E-7" or "E7" in "rank" field, still ok;
  // for anything else, return as-is
  return raw;
}

function rankShort(paygradeOrRank) {
  const p = normalizePaygrade(paygradeOrRank);
  const map = {
    "E-1": "AB",
    "E-2": "Amn",
    "E-3": "A1C",
    "E-4": "SrA",
    "E-5": "SSgt",
    "E-6": "TSgt",
    "E-7": "MSgt",
    "E-8": "SMSgt",
    "E-9": "CMSgt",
    "W-1": "WO1",
    "W-2": "CWO2",
    "W-3": "CWO3",
    "W-4": "CWO4",
    "W-5": "CWO5",
    "O-1": "2nd Lt",
    "O-2": "1st Lt",
    "O-3": "Capt",
    "O-4": "Maj",
    "O-5": "Lt Col",
    "O-6": "Col",
    "O-7": "Brig Gen",
    "O-8": "Maj Gen",
    "O-9": "Lt Gen",
    "O-10": "Gen",
  };
  return map[p] || p || "";
}

/* ============================================================
   //#2 — Pay tables (deterministic)
   Uses netlify/functions/data/militaryPayTables.json if present
============================================================ */
let __PAY_TABLES_CACHE__ = null;

function loadPayTables() {
  if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;
  try {
    const fp = path.join(
      process.cwd(),
      "netlify",
      "functions",
      "data",
      "militaryPayTables.json"
    );
    const raw = fs.readFileSync(fp, "utf8");
    __PAY_TABLES_CACHE__ = JSON.parse(raw);
    return __PAY_TABLES_CACHE__;
  } catch (e) {
    // If file not present, we can still function with profile context + OpenAI fallback.
    __PAY_TABLES_CACHE__ = null;
    return null;
  }
}

function money(n) {
  const x = Number(n) || 0;
  return x.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// pick nearest YOS key <= requested YOS if exact missing
function pickYosValue(tableForRank, yos) {
  if (!tableForRank || typeof tableForRank !== "object") return 0;

  const y = Number(yos);
  if (!Number.isFinite(y)) return 0;

  // direct hit
  const direct = tableForRank[String(y)];
  if (direct != null) return Number(direct) || 0;

  // nearest lower
  const keys = Object.keys(tableForRank)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return 0;

  let best = keys[0];
  for (const k of keys) {
    if (k <= y) best = k;
    else break;
  }
  return Number(tableForRank[String(best)]) || 0;
}

function computePayBasics({ paygrade, yos, zip, family }) {
  const tables = loadPayTables();
  if (!tables) {
    return { ok: false, reason: "Pay tables JSON not available on server." };
  }

  const pg = normalizePaygrade(paygrade);
  const y = Number(yos);

  if (!pg || !Number.isFinite(y)) {
    return { ok: false, reason: "Missing rank/paygrade or YOS." };
  }

  const baseTable = tables.BASEPAY?.[pg];
  const basePay = pickYosValue(baseTable, y);

  // BAS: enlisted/officer
  const isOfficer = pg.startsWith("O-") || pg.startsWith("W-");
  const bas = Number(isOfficer ? tables.BAS?.officer : tables.BAS?.enlisted) || 0;

  // BAH (needs ZIP)
  let bah = 0;
  let bahNote = "";
  const z = safeStr(zip);
  if (z) {
    // NOTE: your file uses BAH_TX; expand later to BAH_<STATE> if needed
    const bahRec = tables.BAH_TX?.[z];
    if (bahRec) {
      const fam = !!family;
      const bucket = fam ? bahRec.with : bahRec.without;
      bah = Number(bucket?.[pg]) || 0;
      if (!bah) bahNote = "BAH for that ZIP/paygrade not found.";
    } else {
      bahNote = "BAH ZIP not found in table.";
    }
  } else {
    bahNote = "BAH needs a ZIP code (or base→ZIP mapping).";
  }

  const total = basePay + bas + bah;

  return {
    ok: true,
    basePay,
    bas,
    bah,
    total,
    bahNote,
  };
}

/* ============================================================
   //#3 — Intent router (profile-aware + pay-aware)
============================================================ */
function detectIntent(text) {
  const t = String(text || "").toLowerCase();

  // Pay / income questions (highest priority)
  if (
    t.includes("how much do i make") ||
    t.includes("monthly pay") ||
    t.includes("total pay") ||
    t.includes("salary") ||
    (t.includes("pay") && (t.includes("monthly") || t.includes("total") || t.includes("my")))
  ) {
    return { type: "pay_question" };
  }

  // Rank / profile
  if (t.includes("my rank") || (t.includes("rank") && t.includes("my")) || t.includes("profile")) {
    return { type: "profile_question" };
  }

  // Financial Dashboard / Budget / Affordability
  if (
    t.includes("budget") ||
    t.includes("afford") ||
    t.includes("income") ||
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
  if (t.includes("aiou") || t.includes("psych") || t.includes("personality") || t.includes("unlock")) {
    return { type: "aiou" };
  }

  // RealtySaSS Unlock
  if (t.includes("realtysass") || t.includes("sass") || t.includes("tools")) {
    return { type: "sass_unlock" };
  }

  // Blog intents
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

/* ============================================================
   //#4 — Main handler
============================================================ */
module.exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    // Must return 204 with headers; body may be empty JSON for simplicity
    return respond(204, headers, {});
  }

  if (event.httpMethod !== "POST") {
    return respond(405, headers, { error: "Method Not Allowed" });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, headers, { error: "Invalid JSON body" });
  }

  const userText = String(payload.message || "").trim();
  if (!userText) {
    return respond(400, headers, { error: "Missing message" });
  }

  // ------------------------------------------------------------
  // //#4.1 — Supabase profile lookup (if email provided)
  // ------------------------------------------------------------
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const email = getEmailFromPayload(payload);
  let profile = null;

  if (email && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await supabase
        .from("profiles")
        .select(SELECT_COLS)
        .eq("email", email)
        .maybeSingle();

      if (!error && data) profile = data;
    } catch (_) {
      // swallow; we'll still respond
    }
  }

  // Basic profile context
  const fullName = safeStr(profile?.full_name) || safeStr(payload.context?.profile?.full_name);
  const ln = lastNameOf(fullName, profile?.last_name);

  const pg = normalizePaygrade(profile?.rank_paygrade || profile?.rank || payload.context?.profile?.rank_paygrade || payload.context?.profile?.rank);
  const yos = (profile?.yos ?? payload.context?.profile?.yos ?? payload.context?.yos ?? null);
  const base = safeStr(profile?.base || payload.context?.profile?.base || payload.context?.base || "");
  const family = (profile?.family ?? payload.context?.profile?.family ?? payload.context?.family ?? null);

  // ZIP can be passed in (optional)
  const zip = safeStr(payload.zip || payload.context?.zip || "");

  // A slim, stable object you can trust downstream
  const profileContext = profile
    ? {
        email: profile.email || null,
        full_name: profile.full_name || null,
        last_name: profile.last_name || null,
        rank_paygrade: profile.rank_paygrade || null,
        rank: profile.rank || null,
        yos: profile.yos ?? null,
        base: profile.base || null,
        family: profile.family ?? null,
        va_disability: profile.va_disability ?? null,
        mode: profile.mode || null,
      }
    : null;

  // ------------------------------------------------------------
  // //#4.2 — Intent routing (profile-aware)
  // ------------------------------------------------------------
  const intent = detectIntent(userText);

  if (intent?.type === "profile_question") {
    if (!profile) {
      return respond(200, headers, {
        intent: "profile_question",
        reply:
          "I can answer that instantly once I have your saved profile. Quick fix: include your email in this chat request so I can pull rank + YOS from Supabase.",
        profile: null,
      });
    }

    const rankLabel = rankShort(pg) || pg || "—";
    const y = (yos !== null && yos !== undefined) ? String(yos) : "—";
    const fam = (family !== null && family !== undefined) ? String(family) : "—";
    const va = (profile?.va_disability !== null && profile?.va_disability !== undefined) ? `${profile.va_disability}%` : "—";

    return respond(200, headers, {
      intent: "profile_question",
      reply:
        `Got you, ${rankLabel} ${ln || ""}. ` +
        `Here’s what I see on file: Rank ${rankLabel}, ${y} YOS, Base ${base || "—"}, Family ${fam}, VA ${va}.`,
      profile: profileContext,
    });
  }

  if (intent?.type === "pay_question") {
    if (!profile) {
      return respond(200, headers, {
        intent: "pay_question",
        reply:
          "I can calculate that instantly once I can see your saved profile. Include your email so I can pull your rank + YOS from Supabase.",
        profile: null,
      });
    }

    const pay = computePayBasics({
      paygrade: pg,
      yos,
      zip,
      family: !!family,
    });

    const rankLabel = rankShort(pg) || pg || "—";

    if (!pay.ok) {
      return respond(200, headers, {
        intent: "pay_question",
        reply:
          `I have your profile (${rankLabel}, ${String(yos ?? "—")} YOS), but I can’t run pay math yet: ${pay.reason}`,
        profile: profileContext,
      });
    }

    const lines = [];
    lines.push(`Here’s your monthly pay snapshot, ${rankLabel} ${ln || ""}:`);
    lines.push(`• Base Pay: ${money(pay.basePay)}`);
    lines.push(`• BAS: ${money(pay.bas)}`);
    if (pay.bah > 0) lines.push(`• BAH: ${money(pay.bah)}`);
    else lines.push(`• BAH: — (${pay.bahNote || "ZIP required"})`);
    lines.push(`= Estimated Total: ${money(pay.total)} / month`);

    return respond(200, headers, {
      intent: "pay_question",
      reply: lines.join("\n"),
      profile: profileContext,
      pay: {
        basePay: pay.basePay,
        bas: pay.bas,
        bah: pay.bah,
        total: pay.total,
        bahNote: pay.bahNote || "",
        inputs: {
          paygrade: pg || null,
          yos: Number(yos) || null,
          zip: zip || null,
          family: !!family,
        },
      },
    });
  }

  // Keep these experiences simple; personalize greeting if we can
  if (intent?.type === "financial_dashboard") {
    const who =
      (rankShort(pg) ? `${rankShort(pg)} ${ln || ""}`.trim() : (ln ? `Hello ${ln}` : "Quick next step"));
    return respond(200, headers, {
      intent: "financial_dashboard",
      reply:
        `${who} — to size your mortgage safely, we need your real monthly obligations. ` +
        `Open your Financial Dashboard here:\n\nhttps://theorozcorealty.com/dashboard\n\n` +
        `Once it’s filled out, I’ll translate it into a clean affordability verdict.`,
      profile: profileContext,
    });
  }

  if (intent?.type === "analysis") {
    return respond(200, headers, {
      intent: "analysis",
      reply:
        "Your Fiduciary Snapshot explains affordability, monthly cushion, and risk.\n\nOpen it here:\n\nhttps://theorozcorealty.com/analysis\n\nAsk me what any number means — I’ll translate it cleanly.",
      profile: profileContext,
    });
  }

  if (intent?.type === "aiou") {
    return respond(200, headers, {
      intent: "aiou",
      reply:
        "Next step is your A.I.O.U Personality Test — it reveals your buying psychology and generates your unlock code.\n\nBegin here:\n\nhttps://theorozcorealty.com/aiou",
      profile: profileContext,
    });
  }

  if (intent?.type === "sass_unlock") {
    return respond(200, headers, {
      intent: "sass_unlock",
      reply:
        "RealtySaSS is the private suite of tools. Enter your unlock code here:\n\nhttps://theorozcorealty.com/realtysass\n\nNo code yet? Take AIOU and I’ll prep it.",
      profile: profileContext,
    });
  }

  if (intent?.type === "blog_va") {
    return respond(200, headers, {
      intent: "blog_va",
      reply:
        "VA Loan Process walkthrough:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/va-loan-process",
      profile: profileContext,
    });
  }

  if (intent?.type === "blog_steps") {
    return respond(200, headers, {
      intent: "blog_steps",
      reply:
        "Home Buying Steps guide:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps",
      profile: profileContext,
    });
  }

  if (intent?.type === "blog_realtor") {
    return respond(200, headers, {
      intent: "blog_realtor",
      reply:
        "Do you need a realtor?\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/do-i-need-a-realtor",
      profile: profileContext,
    });
  }

  if (intent?.type === "blog_risks") {
    return respond(200, headers, {
      intent: "blog_risks",
      reply:
        "Benefits & risks of buying a home:\n\nhttps://new-real-estate-purchase.webflow.io/blog-page/home-buying-steps",
      profile: profileContext,
    });
  }

  // ------------------------------------------------------------
  // //#4.3 — OpenAI fallback (profile-aware in prompt)
  // ------------------------------------------------------------
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const hint = profile
      ? `I can see your profile (${rankShort(pg) || pg || "—"}, ${String(yos ?? "—")} YOS, ${base || "—"}).`
      : "I can’t see your profile yet (email not included in request).";
    return respond(200, headers, {
      reply: `Elena (dev echo): “${userText}” — ${hint} Add OPENAI_API_KEY for natural-language answers.`,
      profile: profileContext,
    });
  }

  const system = [
    "You are Elena, a warm, emotionally-intelligent A.I. Concierge for OrozcoRealty.",
    "Voice: calm, high-trust, executive clarity. Slightly flirty but never explicit.",
    "Be BLUF-first. Keep answers under 8 sentences.",
    "If user asks for pay math and you have rank + YOS, explain Base Pay + BAS; ask for ZIP if they want BAH.",
    "If you do NOT have profile context, ask for the email (or tell them to sync profile) in one sentence max, then continue helping.",
  ].join(" ");

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify({
        message: userText,
        profile: profileContext,
        zip: zip || null,
        notes: "If profile is present, use it. If missing, request email once and proceed with guidance.",
      }),
    },
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
        temperature: 0.35,
        max_tokens: 500,
        messages,
      }),
    });

    const data = await resp.json();
    const reply =
      (data?.choices?.[0]?.message?.content || "").trim() ||
      "I’m right here. What are we solving today?";

    return respond(200, headers, {
      reply,
      profile: profileContext || undefined,
    });
  } catch (err) {
    return respond(500, headers, {
      error: "Server exception",
      detail: String(err),
    });
  }
};

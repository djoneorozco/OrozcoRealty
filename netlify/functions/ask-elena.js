// netlify/functions/ask-elena.js
// v2.4 — Profile-aware Elena (Supabase profile lookup + deterministic pay basics + affordability)
//
// GOAL:
// - Elena can answer questions about the user's profile + pay (Base Pay + BAS, and BAH if ZIP/base is available)
// - Adds deterministic “How much house can I afford?” quick answer
// - Uses deterministic pay tables from:
//     ✅ netlify/functions/militaryPayTables.json (primary)
//     ↩︎ netlify/functions/data/militaryPayTables.json (fallback)
//
// REQUIRED ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// OPTIONAL ENV:
//   OPENAI_API_KEY   (only for non-deterministic questions)
//
// CLIENT SHOULD CALL (recommended):
//   POST https://theorozcorealty.netlify.app/api/ask-elena
//   body: { message, email, zip?, context?: { profile?: {...} } }

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

/* ============================================================
   //#1 — CORS
============================================================ */
const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://www.theorozcorealty.com",
  "https://new-real-estate-purchase.webflow.io",
  "https://www.new-real-estate-purchase.webflow.io",
  "https://theorozcorealty.netlify.app",
  "http://localhost:8888",
];

function corsHeaders(origin) {
  const o = String(origin || "").trim();
  const allow = ALLOW_ORIGINS.includes(o) ? o : "*";
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
  return { statusCode, headers, body: JSON.stringify(payload || {}) };
}

/* ============================================================
   //#2 — Supabase profile fields (match profile-by-email.js)
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

/* ============================================================
   //#3 — Utility helpers
============================================================ */
function safeStr(x) {
  const s = String(x ?? "").trim();
  return s || "";
}

function normalizeEmail(x) {
  return safeStr(x).toLowerCase();
}

function lastNameOf(fullName, lastNameField) {
  const ln = safeStr(lastNameField);
  if (ln) return ln;

  const name = safeStr(fullName);
  if (!name) return "";
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function getEmailFromPayload(payload) {
  // Priority order: payload.email -> payload.context.email -> payload.context.profile.email
  // -> payload.identity.email
  const direct = normalizeEmail(payload?.email);
  if (direct) return direct;

  const ctxEmail = normalizeEmail(payload?.context?.email);
  if (ctxEmail) return ctxEmail;

  const ctxProfEmail = normalizeEmail(payload?.context?.profile?.email);
  if (ctxProfEmail) return ctxProfEmail;

  const identEmail = normalizeEmail(payload?.identity?.email);
  if (identEmail) return identEmail;

  return "";
}

/**
 * Normalize paygrade to match your pay table keys:
 *  - "E7"  -> "E-7"
 *  - "E-7" -> "E-7"
 *  - "O1"  -> "O-1"
 */
function normalizePaygrade(x) {
  const raw = safeStr(x).toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  if (/^[EOW]-\d{1,2}$/.test(raw)) return raw;
  if (/^[EOW]\d{1,2}$/.test(raw)) return raw[0] + "-" + raw.slice(1);
  return raw; // fallback
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

function money(n) {
  const x = Number(n) || 0;
  return x.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function normalizeBaseName(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/* ============================================================
   //#3B — Mortgage helpers (deterministic)
============================================================ */
function monthlyPaymentPI(principal, aprPercent, termYears) {
  const P = Number(principal) || 0;
  const apr = Number(aprPercent) || 0;
  const years = Number(termYears) || 30;
  const n = Math.max(1, Math.round(years * 12));

  if (P <= 0) return 0;

  const r = apr > 0 ? (apr / 100) / 12 : 0;
  if (r === 0) return P / n;

  const pow = Math.pow(1 + r, n);
  return P * (r * pow) / (pow - 1);
}

function principalFromPaymentPI(payment, aprPercent, termYears) {
  const M = Number(payment) || 0;
  const apr = Number(aprPercent) || 0;
  const years = Number(termYears) || 30;
  const n = Math.max(1, Math.round(years * 12));

  if (M <= 0) return 0;

  const r = apr > 0 ? (apr / 100) / 12 : 0;
  if (r === 0) return M * n;

  const pow = Math.pow(1 + r, n);
  // P = M * (( (1+r)^n - 1 ) / ( r*(1+r)^n ))
  return M * ((pow - 1) / (r * pow));
}

/* ============================================================
   //#4 — Deterministic pay tables (militaryPayTables.json)
============================================================ */
let __PAY_TABLES_CACHE__ = null;
let __PAY_TABLES_PATH_USED__ = null;

function loadPayTables() {
  if (__PAY_TABLES_CACHE__ !== null) return __PAY_TABLES_CACHE__;

  // ✅ Primary: your real location
  const p1 = path.join(process.cwd(), "netlify", "functions", "militaryPayTables.json");
  // ↩︎ Fallback: older location (keeps legacy deployments alive)
  const p2 = path.join(process.cwd(), "netlify", "functions", "data", "militaryPayTables.json");

  try {
    let fp = null;
    if (fs.existsSync(p1)) fp = p1;
    else if (fs.existsSync(p2)) fp = p2;

    if (!fp) {
      __PAY_TABLES_CACHE__ = null;
      __PAY_TABLES_PATH_USED__ = null;
      return null;
    }

    const raw = fs.readFileSync(fp, "utf8");
    __PAY_TABLES_CACHE__ = JSON.parse(raw);
    __PAY_TABLES_PATH_USED__ = fp;
    return __PAY_TABLES_CACHE__;
  } catch (_) {
    __PAY_TABLES_CACHE__ = null;
    __PAY_TABLES_PATH_USED__ = null;
    return null;
  }
}

// choose nearest YOS key <= requested YOS if exact missing
function pickYosValue(tableForRank, yos) {
  if (!tableForRank || typeof tableForRank !== "object") return 0;

  const y = Number(yos);
  if (!Number.isFinite(y)) return 0;

  const direct = tableForRank[String(y)];
  if (direct != null) return Number(direct) || 0;

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

function deriveZipFromBase(tables, baseName) {
  const baseToZip =
    tables?.BAH?.base_to_zip ||
    tables?.BAH?.baseToZip ||
    {};

  if (!baseName) return "";

  const want = normalizeBaseName(baseName);
  if (!want) return "";

  // Build normalized lookup (handles “JBSA-Lackland”, “JBSA Lackland”, etc.)
  const map = new Map();
  for (const [k, v] of Object.entries(baseToZip || {})) {
    const nk = normalizeBaseName(k);
    if (nk) map.set(nk, safeStr(v));
  }

  return map.get(want) || "";
}

function lookupBah(tables, zip, paygrade, familyBool) {
  const z = safeStr(zip);
  if (!z) return { bah: 0, note: "BAH needs a ZIP code (or a base name for base→ZIP mapping)." };

  // Prefer the main table first
  const rec =
    tables?.BAH?.by_zip?.[z] ||
    tables?.BAH?.byZip?.[z] ||
    tables?.BAH_TX?.[z] ||
    null;

  if (!rec) return { bah: 0, note: "BAH ZIP not found in table." };

  const bucket = familyBool ? rec.with : rec.without;
  const val = Number(bucket?.[paygrade]) || 0;

  if (!val) return { bah: 0, note: "BAH for that ZIP/paygrade not found." };
  return { bah: val, note: "" };
}

function computePayBasics({ paygrade, yos, zip, family, base }) {
  const tables = loadPayTables();
  if (!tables) return { ok: false, reason: "Pay tables JSON not available on server." };

  const pg = normalizePaygrade(paygrade);
  const y = Number(yos);

  if (!pg || !Number.isFinite(y)) {
    return { ok: false, reason: "Missing rank/paygrade or YOS." };
  }

  const baseTable = tables.BASEPAY?.[pg];
  const basePay = pickYosValue(baseTable, y);

  const isOfficer = pg.startsWith("O-") || pg.startsWith("W-");
  const bas = Number(isOfficer ? tables.BAS?.officer : tables.BAS?.enlisted) || 0;

  // ✅ ZIP priority: explicit zip -> derived from base -> none
  let z = safeStr(zip);
  if (!z) {
    const derived = deriveZipFromBase(tables, base);
    if (derived) z = derived;
  }

  const { bah, note: bahNote } = lookupBah(tables, z, pg, !!family);

  return {
    ok: true,
    basePay,
    bas,
    bah,
    total: basePay + bas + bah,
    bahNote: bahNote || "",
    resolvedZip: z || "",
  };
}

/* ============================================================
   //#5 — Intent detection (simple + reliable)
============================================================ */
function detectIntent(text) {
  const t = String(text || "").toLowerCase();

  // Pay
  if (
    t.includes("monthly pay") ||
    t.includes("total pay") ||
    t.includes("how much do i make") ||
    t.includes("salary") ||
    (t.includes("pay") && (t.includes("monthly") || t.includes("total") || t.includes("mine") || t.includes("my")))
  ) return { type: "pay_question" };

  // Profile
  if (t.includes("my rank") || (t.includes("rank") && t.includes("my")) || t.includes("profile loaded")) {
    return { type: "profile_question" };
  }

  // NEW: Affordability / housing budget
  if (
    t.includes("afford") ||
    t.includes("how much house") ||
    t.includes("how much home") ||
    t.includes("most i can spend") ||
    (t.includes("spend") && (t.includes("house") || t.includes("home"))) ||
    (t.includes("budget") && (t.includes("house") || t.includes("home") || t.includes("mortgage")))
  ) return { type: "affordability_question" };

  return null;
}

/* ============================================================
   //#6 — Main handler
============================================================ */
module.exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return respond(204, headers, {});
  if (event.httpMethod !== "POST") return respond(405, headers, { error: "Method Not Allowed" });

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, headers, { error: "Invalid JSON body" });
  }

  const userText = safeStr(payload.message);
  if (!userText) return respond(400, headers, { error: "Missing message" });

  // --- Accept context.profile from client (fast path) ---
  const contextProfile = payload?.context?.profile && typeof payload.context.profile === "object"
    ? payload.context.profile
    : null;

  // --- Supabase lookup by email (authoritative) ---
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const email = getEmailFromPayload(payload);
  let profile = null;
  let usedSupabase = false;

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

      if (!error && data) {
        profile = data;
        usedSupabase = true;
      }
    } catch (_) {
      // swallow — we can still respond using contextProfile
    }
  }

  // If Supabase didn’t return, fall back to contextProfile
  if (!profile && contextProfile) profile = contextProfile;

  // Build minimal profile context for replies
  const fullName = safeStr(profile?.full_name);
  const ln = lastNameOf(fullName, profile?.last_name);
  const pg = normalizePaygrade(profile?.rank_paygrade || profile?.rank);
  const yos = profile?.yos ?? null;
  const base = safeStr(profile?.base);
  const family = profile?.family ?? null;
  const va = profile?.va_disability ?? null;

  // ZIP supplied by caller (optional)
  const zip = safeStr(payload.zip || payload?.context?.zip || "");

  const profileContext = profile
    ? {
        email: normalizeEmail(profile.email || email) || null,
        full_name: fullName || null,
        last_name: safeStr(profile.last_name) || null,
        rank_paygrade: safeStr(profile.rank_paygrade) || null,
        rank: safeStr(profile.rank) || null,
        yos: (yos === null || yos === undefined) ? null : Number(yos),
        base: base || null,
        family: (family === null || family === undefined) ? null : family,
        va_disability: (va === null || va === undefined) ? null : va,
        mode: safeStr(profile.mode) || null,
      }
    : null;

  const intent = detectIntent(userText);

  // ------------------------------------------------------------
  // Resolve ZIP early (used for deterministic + OpenAI fallback)
  // ------------------------------------------------------------
  const tables = loadPayTables(); // cached
  const derivedZip = (!zip && base && tables) ? deriveZipFromBase(tables, base) : "";
  const resolvedZip = zip || derivedZip || "";

  // ============================================================
  // //#6.1 — Profile question (deterministic)
  // ============================================================
  if (intent?.type === "profile_question") {
    if (!profileContext || !profileContext.email) {
      return respond(200, headers, {
        intent: "profile_question",
        reply:
          "I can answer that instantly once your profile is synced. Send your email (or load your profile in the shell) and I’ll pull your rank + YOS.",
        profile: null,
        debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
      });
    }

    const r = rankShort(pg) || pg || "—";
    const y = (profileContext.yos !== null && profileContext.yos !== undefined) ? String(profileContext.yos) : "—";
    const fam = (profileContext.family !== null && profileContext.family !== undefined) ? String(profileContext.family) : "—";
    const vaTxt = (profileContext.va_disability !== null && profileContext.va_disability !== undefined) ? `${profileContext.va_disability}%` : "—";

    return respond(200, headers, {
      intent: "profile_question",
      reply:
        `Locked in. I see you as ${r} ${ln || ""} — ${y} YOS, Base ${base || "—"}, Family ${fam}, VA ${vaTxt}.`.trim(),
      profile: profileContext,
      debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
    });
  }

  // ============================================================
  // //#6.2 — Pay question (deterministic)
  // ============================================================
  if (intent?.type === "pay_question") {
    if (!profileContext || !profileContext.email) {
      return respond(200, headers, {
        intent: "pay_question",
        reply:
          "I can calculate that instantly once your profile is synced. Send your email (or load your profile in the shell) so I can grab rank + YOS.",
        profile: null,
        debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
      });
    }

    const pay = computePayBasics({
      paygrade: pg,
      yos: profileContext.yos,
      zip: resolvedZip,
      family: !!profileContext.family,
      base: profileContext.base,
    });

    const r = rankShort(pg) || pg || "—";

    if (!pay.ok) {
      return respond(200, headers, {
        intent: "pay_question",
        reply:
          `I can see your profile (${r}, ${String(profileContext.yos ?? "—")} YOS), but pay math can’t run yet: ${pay.reason}`,
        profile: profileContext,
        debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
      });
    }

    const lines = [];
    lines.push(`Monthly pay snapshot for ${r} ${ln || ""}:`.trim());
    lines.push(`• Base Pay: ${money(pay.basePay)}`);
    lines.push(`• BAS: ${money(pay.bas)}`);

    if (pay.bah > 0) {
      lines.push(`• BAH: ${money(pay.bah)}${pay.resolvedZip ? ` (ZIP ${pay.resolvedZip})` : ""}`);
    } else {
      lines.push(`• BAH: — (${pay.bahNote || "ZIP required"})`);
    }

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
        resolvedZip: pay.resolvedZip || "",
        inputs: {
          paygrade: pg || null,
          yos: profileContext.yos ?? null,
          zip: resolvedZip || null,
          base: profileContext.base || null,
          family: !!profileContext.family
        },
      },
      debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
    });
  }

  // ============================================================
  // //#6.3 — Affordability question (deterministic quick answer)
  // ============================================================
  if (intent?.type === "affordability_question") {
    if (!profileContext || !profileContext.email) {
      return respond(200, headers, {
        intent: "affordability_question",
        reply:
          "I can calculate that fast — I just need your profile synced (email) so I can pull rank + YOS + base for BAH.",
        profile: null,
        debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
      });
    }

    const r = rankShort(pg) || pg || "—";

    const pay = computePayBasics({
      paygrade: pg,
      yos: profileContext.yos,
      zip: resolvedZip,
      family: !!profileContext.family,
      base: profileContext.base,
    });

    if (!pay.ok) {
      return respond(200, headers, {
        intent: "affordability_question",
        reply:
          `I can see your profile (${r}, ${String(profileContext.yos ?? "—")} YOS), but pay math can’t run yet: ${pay.reason}`,
        profile: profileContext,
        debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
      });
    }

    // Deterministic housing cap (matches your system’s spirit)
    const totalPay = Number(pay.total) || 0;
    const allInCap = totalPay * 0.30;              // “safe” all-in housing cap
    const piTarget = allInCap / 1.28;              // your dashboard buffer for taxes/ins/HOA

    // Quick estimate assumptions (explicitly labeled)
    const aprAssumed = 7.0;
    const termAssumed = 30;

    // Convert PI target -> max principal -> max price for 0% and 5% down
    const maxPrincipal = principalFromPaymentPI(piTarget, aprAssumed, termAssumed);

    const price0 = maxPrincipal;                   // 0% down (VA-style estimate)
    const price5 = maxPrincipal / (1 - 0.05);      // 5% down

    const lines = [];
    lines.push(`BLUF: Your “safe” all-in housing cap is about ${money(allInCap)}/mo.`);
    lines.push(`That’s a P&I target of ~${money(piTarget)}/mo (using your 1.28 buffer).`);
    lines.push("");
    lines.push(`Pay snapshot for ${r} ${ln || ""}:`.trim());
    lines.push(`• Base Pay: ${money(pay.basePay)}`);
    lines.push(`• BAS: ${money(pay.bas)}`);
    if (pay.bah > 0) lines.push(`• BAH: ${money(pay.bah)}${pay.resolvedZip ? ` (ZIP ${pay.resolvedZip})` : ""}`);
    else lines.push(`• BAH: — (${pay.bahNote || "needs base/ZIP"})`);
    lines.push(`= Total Pay Used: ${money(totalPay)}/mo`);
    lines.push("");
    lines.push(`Quick max price estimate (assumes ${aprAssumed}% APR, ${termAssumed}yr fixed):`);
    lines.push(`• ~${money(price0)} home price @ 0% down (VA-style rough cap)`);
    lines.push(`• ~${money(price5)} home price @ 5% down`);
    lines.push("");
    lines.push(`If you tell me your credit score + planned down payment, I’ll tighten this to your real APR band.`);

    return respond(200, headers, {
      intent: "affordability_question",
      reply: lines.join("\n"),
      profile: profileContext,
      pay: {
        basePay: pay.basePay,
        bas: pay.bas,
        bah: pay.bah,
        total: pay.total,
        resolvedZip: pay.resolvedZip || "",
      },
      affordability: {
        ratios: { housing_cap_pct: 0.30, buffer_allin_to_pi: 1.28 },
        allInCapMonthly: allInCap,
        piTargetMonthly: piTarget,
        assumptions: { apr_percent: aprAssumed, term_years: termAssumed },
        maxPrincipal,
        maxPrice_0_down: price0,
        maxPrice_5_down: price5,
      },
      debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
    });
  }

  // ============================================================
  // //#6.4 — OpenAI fallback (profile-aware, optional)
  // ============================================================
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const hint = profileContext
      ? `I can see your profile (${rankShort(pg) || pg || "—"}, ${String(profileContext.yos ?? "—")} YOS, ${base || "—"}).`
      : "I can’t see your profile yet (sync it in the shell or include email).";
    return respond(200, headers, {
      intent: "fallback_no_openai",
      reply: `Elena (dev echo): “${userText}” — ${hint} Add OPENAI_API_KEY for natural-language answers.`,
      profile: profileContext,
      debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
    });
  }

  // Provide pay preview to the LLM so it DOESN’T ask for ZIP if base already gives one.
  let payPreview = null;
  if (profileContext && pg && profileContext.yos !== null && profileContext.yos !== undefined) {
    const p = computePayBasics({
      paygrade: pg,
      yos: profileContext.yos,
      zip: resolvedZip,
      family: !!profileContext.family,
      base: profileContext.base,
    });
    if (p?.ok) payPreview = p;
  }

  const system = [
    "You are Elena, a warm, high-trust A.I. Concierge for OrozcoRealty.",
    "BLUF-first. Keep answers under 8 sentences. No fluff.",
    "If a question needs math, ask for the missing inputs explicitly.",
    "If profile is available, use it (rank/yos/base/family/VA).",
    "IMPORTANT: If resolvedZip is provided (either user ZIP or derived from base), DO NOT ask for ZIP.",
    "If payPreview is provided, you can reference Base Pay + BAS + BAH + Total directly.",
  ].join(" ");

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.35,
        max_tokens: 450,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              message: userText,
              profile: profileContext,
              resolvedZip: resolvedZip || null,
              payPreview: payPreview
                ? {
                    basePay: payPreview.basePay,
                    bas: payPreview.bas,
                    bah: payPreview.bah,
                    total: payPreview.total,
                    bahNote: payPreview.bahNote,
                  }
                : null,
              note: "Use resolvedZip/payPreview if present. Only ask for missing inputs once.",
            }),
          },
        ],
      }),
    });

    const data = await resp.json();
    const reply = (data?.choices?.[0]?.message?.content || "").trim() || "I’m here — what are we solving today?";

    return respond(200, headers, {
      intent: "openai_fallback",
      reply,
      profile: profileContext || undefined,
      debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null, resolvedZip: resolvedZip || null },
    });
  } catch (err) {
    return respond(500, headers, {
      error: "Server exception",
      detail: String(err),
      debug: { usedSupabase, hasContextProfile: !!contextProfile, payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },
    });
  }
};

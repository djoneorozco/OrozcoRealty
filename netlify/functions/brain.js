// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.1)
// - Fetch Supabase profile by email
// - Compute Base Pay + BAS + BAH + Total Pay (deterministic)
// - Load city JSON (targets + market averages)
// - CORS-safe for Webflow preview + live
//
// POST BODY:
//   { email, cityKey, bedrooms }
//
// RETURNS:
//   {
//     ok: true/false,
//     input: { email, cityKey, bedrooms },
//     profile: {...},
//     pay: { basePay, bah, bas, totalPay },
//     city: { key, market, targets, raw },
//     missing: [...]
//   }
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

// -----------------------------
// //#1 CORS
// -----------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Content-Type": "application/json",
};

// -----------------------------
// //#2 Small helpers
// -----------------------------
function respond(statusCode, obj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(obj),
  };
}

function safeKey(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

function toInt(x) {
  const n = Number.parseInt(String(x ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeRank(rank) {
  const r = String(rank || "").trim().toUpperCase();
  // Accept "E6" -> "E-6"
  const m = r.match(/^([EO]|W)\s*-?\s*(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  return r;
}

function pickNearestYos(tableForRank, yos) {
  // table keys are usually "0".."40"
  const keys = Object.keys(tableForRank || {})
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a,b)=>a-b);

  if (!keys.length) return null;

  // choose max key <= yos, else smallest key
  let chosen = keys[0];
  for (const k of keys) {
    if (k <= yos) chosen = k;
  }
  return tableForRank[String(chosen)] ?? null;
}

// -----------------------------
// //#3 Cached file loads (fast + stable)
// -----------------------------
let __PAY_TABLES_CACHE__ = null;

function loadPayTables() {
  if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;

  // NOTE: Using URL keeps this stable in Netlify’s runtime
  const url = new URL("./data/militaryPayTables.json", import.meta.url);

  try {
    const raw = fs.readFileSync(url, "utf8");
    __PAY_TABLES_CACHE__ = JSON.parse(raw);
    return __PAY_TABLES_CACHE__;
  } catch (e) {
    throw new Error(`File not found: ${url.pathname}`);
  }
}

function loadCity(cityKey) {
  const key = safeKey(cityKey || "SanAntonio");
  const url = new URL(`./cities/${key}.json`, import.meta.url);

  try {
    const raw = fs.readFileSync(url, "utf8");
    const data = JSON.parse(raw);

    // Normalize a "market" object for the UI
    const market =
      data.market ||
      data?.housing?.market ||
      data?.realEstate?.market ||
      {};

    const targets =
      data.targets ||
      data?.housing?.targets ||
      data?.realEstate?.targets ||
      {};

    return {
      key,
      market,
      targets,
      raw: data,
    };
  } catch (e) {
    throw new Error(`City file not found: ${url.pathname}`);
  }
}

// -----------------------------
// //#4 Deterministic pay math
// -----------------------------
function computePay(profile, payTables) {
  const missing = [];

  const rank = normalizeRank(profile?.rank_paygrade || profile?.rank || "");
  const yos = toInt(profile?.yos ?? profile?.years_of_service ?? profile?.yearsOfService);
  const zip = String(profile?.zip || profile?.postal_code || "").trim();
  const family = Boolean(profile?.family ?? profile?.dependents ?? profile?.has_dependents);

  if (!rank) missing.push("rank_paygrade");
  if (yos === null) missing.push("yos");
  if (!zip) missing.push("zip");

  // Base pay
  let basePay = 0;
  if (rank && yos !== null) {
    const baseTable = payTables?.BASEPAY?.[rank];
    if (!baseTable) {
      missing.push("basepay_table_for_rank");
    } else {
      const picked = pickNearestYos(baseTable, yos);
      if (picked == null) missing.push("basepay_value");
      else basePay = Number(picked) || 0;
    }
  }

  // BAS
  let bas = 0;
  const isOfficer = /^O-/.test(rank);
  const basObj = payTables?.BAS || {};
  if (typeof basObj === "object") {
    bas = Number(isOfficer ? basObj.officer : basObj.enlisted) || 0;
  }

  // BAH (this dataset key is BAH_TX in your repo memory)
  let bah = 0;
  if (zip && rank) {
    const bahZip = payTables?.BAH_TX?.[zip] || payTables?.BAH?.[zip];
    if (!bahZip) {
      missing.push("bah_zip_not_found");
    } else {
      const bucket = family ? bahZip.with : bahZip.without;
      if (!bucket) {
        missing.push("bah_bucket_missing");
      } else {
        const val = bucket?.[rank];
        if (val == null) missing.push("bah_rank_not_found");
        else bah = Number(val) || 0;
      }
    }
  }

  const totalPay = basePay + bas + bah;

  return {
    ok: missing.length === 0 && totalPay > 0,
    missing,
    pay: { basePay, bah, bas, totalPay },
  };
}

// -----------------------------
// //#5 Supabase profile lookup
// -----------------------------
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY; // service role key
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchProfileByEmail(email) {
  const sb = getSupabase();

  // Adjust select list to match your table columns (safe: select '*')
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (error) throw new Error(error.message || "Supabase profile fetch failed.");
  if (!data) throw new Error("Profile not found for this email.");

  return data;
}

// -----------------------------
// //#6 Netlify handler
// -----------------------------
export async function handler(event) {
  try {
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    // Simple GET sanity check
    if (event.httpMethod === "GET") {
      return respond(200, {
        ok: true,
        note: "POST JSON to this endpoint: { email, cityKey, bedrooms }",
      });
    }

    if (event.httpMethod !== "POST") {
      return respond(405, { ok: false, error: "Method not allowed." });
    }

    const body = JSON.parse(event.body || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const cityKey = safeKey(body.cityKey || "SanAntonio");
    const bedrooms = toInt(body.bedrooms) ?? 4;

    if (!email) return respond(400, { ok: false, error: "Missing email." });

    // Load data files
    const payTables = loadPayTables();
    const city = loadCity(cityKey);

    // Profile
    const profile = await fetchProfileByEmail(email);

    // Deterministic pay
    const computed = computePay(profile, payTables);

    return respond(200, {
      ok: computed.ok,
      input: { email, cityKey, bedrooms },
      profile,
      pay: computed.pay,
      city,
      missing: computed.missing,
    });

  } catch (e) {
    return respond(500, { ok: false, error: String(e?.message || e) });
  }
}

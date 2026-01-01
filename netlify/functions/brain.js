// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.5) — Adds Veteran Pay Branch (Retirement + VA Disability)
// - Fetch Supabase profile by email
// - Active Duty path: Base Pay + BAS + BAH + Total Pay (deterministic) [UNCHANGED]
// - Veteran/Retired path: Retirement Pay (est.) + VA Disability Pay (deterministic)
// - Load city JSON (targets + market averages)
// - Adds schemaVersion + stable response shape
//
// POST BODY:
//   { email, cityKey, bedrooms }
//
// RETURNS (stable contract):
//   {
//     ok: true/false,
//     schemaVersion: "1.0",
//     input: { email, cityKey, bedrooms },
//     profile: {...},
//     pay: {
//       basePay, bah, bas, totalPay, total,
//       // veteran extras (when mode/status indicates vet):
//       retirementPay, vaDisabilityPay, totalVeteranPay,
//       payModel: "active_duty" | "veteran"
//     },
//     city: { key, market, targets, raw, avg_home_value, target_rent, ... },
//     missing: [...],
//     errors: [...]
//   }
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// -----------------------------
// //#0 Schema Version (contract)
// -----------------------------
const SCHEMA_VERSION = "1.0";

// -----------------------------
// //#1 CORS (robust)
// -----------------------------
function buildCorsHeaders(event){
  const origin =
    event?.headers?.origin ||
    event?.headers?.Origin ||
    "*";

  const reqHeaders =
    event?.headers?.["access-control-request-headers"] ||
    event?.headers?.["Access-Control-Request-Headers"] ||
    "Content-Type, Authorization";

  return {
    "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

function respond(event, statusCode, obj) {
  return {
    statusCode,
    headers: buildCorsHeaders(event),
    body: JSON.stringify(obj),
  };
}

// -----------------------------
// //#2 Small helpers
// -----------------------------
function safeKey(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

function toInt(x) {
  const n = Number.parseInt(String(x ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function toNum(x) {
  const n = Number(String(x ?? "").trim());
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
  const keys = Object.keys(tableForRank || {})
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a,b)=>a-b);

  if (!keys.length) return null;

  let chosen = keys[0];
  for (const k of keys) {
    if (k <= yos) chosen = k;
  }
  return tableForRank[String(chosen)] ?? null;
}

function normalizeBaseName(s){
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normStr(x){ return String(x ?? "").trim(); }
function lower(x){ return String(x ?? "").trim().toLowerCase(); }

// -----------------------------
// //#2.1 Detect Pay Model (Active vs Veteran/Retired)
// -----------------------------
function detectPayModel(profile){
  const mode = lower(profile?.mode || profile?.status || profile?.user_type || profile?.type);
  // You can expand these as your CRM grows:
  const veteranModes = new Set(["vet","veteran","retired","retiree","separated","civilian"]);
  if (veteranModes.has(mode)) return "veteran";
  return "active_duty";
}

// -----------------------------
// //#2.2 VA Disability Lookup (flexible patterns)
// -----------------------------
function getVaDisabilityMonthly(payTables, percent, family){
  const pctKey = String(percent ?? "").trim();
  if (!pctKey) return { amount: 0, source: null };

  // Common shapes we support:
  // A) DISABILITY[ "100" ] = 3900
  // B) DISABILITY_FULL["100"] = 4200
  // C) DISABILITY = { with: { "100": ... }, without: { "100": ... } }
  // D) DISABILITY = { with_dependents: {...}, without_dependents: {...} }

  const DIS = payTables?.DISABILITY ?? null;
  const DIS_FULL = payTables?.DISABILITY_FULL ?? null;

  // Prefer dependents-aware tables if present
  if (family === true) {
    if (DIS_FULL && typeof DIS_FULL === "object" && DIS_FULL[pctKey] != null) {
      return { amount: Number(DIS_FULL[pctKey]) || 0, source: "DISABILITY_FULL[pct]" };
    }
    if (DIS && typeof DIS === "object") {
      const w =
        DIS.with ||
        DIS.with_dependents ||
        DIS.withDependents ||
        DIS.dependents ||
        null;
      if (w && w[pctKey] != null) return { amount: Number(w[pctKey]) || 0, source: "DISABILITY.with[pct]" };
    }
  }

  // Fall back to non-dependent or base table
  if (DIS && typeof DIS === "object") {
    if (DIS[pctKey] != null) return { amount: Number(DIS[pctKey]) || 0, source: "DISABILITY[pct]" };

    const wo =
      DIS.without ||
      DIS.without_dependents ||
      DIS.withoutDependents ||
      DIS.no_dependents ||
      DIS.noDependents ||
      null;
    if (wo && wo[pctKey] != null) return { amount: Number(wo[pctKey]) || 0, source: "DISABILITY.without[pct]" };
  }

  if (DIS_FULL && typeof DIS_FULL === "object" && DIS_FULL[pctKey] != null) {
    return { amount: Number(DIS_FULL[pctKey]) || 0, source: "DISABILITY_FULL[pct]" };
  }

  return { amount: 0, source: null };
}

// -----------------------------
// //#2.3 Retirement Pay Estimate (deterministic, simple)
// - Uses current base pay as a proxy for "high-3" (planning estimate).
// - Multiplier: High-36/Final Pay ~ 2.5% per year; BRS ~ 2.0% per year.
//   (We default to 2.5% unless profile.retirement_system says 'brs'.)
// -----------------------------
function estimateRetirementPayMonthly(basePayCurrent, yos, profile){
  const sys = lower(profile?.retirement_system || profile?.retirementSystem || profile?.retire_system);
  const isBRS = (sys === "brs" || sys === "blended");

  const perYear = isBRS ? 0.02 : 0.025;
  const years = Number(yos) || 0;

  // Typical caps used in common planning charts:
  // Legacy: 75% at 30 years; BRS: 60% at 30 years
  const cap = isBRS ? 0.60 : 0.75;

  const mult = Math.min(years * perYear, cap);
  const est = Number(basePayCurrent) * mult;

  return {
    amount: Number.isFinite(est) ? est : 0,
    multiplier: mult,
    model: isBRS ? "brs" : "high36"
  };
}

// -----------------------------
// //#3 File loading (Netlify-safe)
// -----------------------------
const ROOT = process.cwd(); // /var/task
const PAY_TABLES_PATH = path.join(ROOT, "netlify", "functions", "data", "militaryPayTables.json");
const CITIES_DIR      = path.join(ROOT, "netlify", "functions", "cities");

let __PAY_TABLES_CACHE__ = null;
const __CITY_CACHE__ = new Map();

function loadPayTables() {
  if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;

  if (!fs.existsSync(PAY_TABLES_PATH)) {
    throw new Error(`militaryPayTables.json not found at ${PAY_TABLES_PATH}`);
  }

  const raw = fs.readFileSync(PAY_TABLES_PATH, "utf8");
  __PAY_TABLES_CACHE__ = JSON.parse(raw);
  return __PAY_TABLES_CACHE__;
}

function loadCity(cityKey) {
  const key = safeKey(cityKey || "SanAntonio");

  if (__CITY_CACHE__.has(key)) return __CITY_CACHE__.get(key);

  const filePath = path.join(CITIES_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`City JSON not found at ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  const marketRaw =
    data.market ||
    data?.housing?.market ||
    data?.realEstate?.market ||
    {};

  const targets =
    data.targets ||
    data?.housing?.targets ||
    data?.realEstate?.targets ||
    {};

  // Normalize Avg Home Value
  const zillowAvg = toNum(marketRaw?.zillow_average_home_value);
  const medianSale = toNum(marketRaw?.median_sale_price_current);
  const medianList = toNum(marketRaw?.median_listing_price_realtor);
  const ownerOccMedian = toNum(data?.housing?.median_value_owner_occupied);

  const avgHome =
    zillowAvg ??
    medianSale ??
    medianList ??
    ownerOccMedian ??
    null;

  const avgHomeSource =
    (zillowAvg != null && "housing.market.zillow_average_home_value") ||
    (medianSale != null && "housing.market.median_sale_price_current") ||
    (medianList != null && "housing.market.median_listing_price_realtor") ||
    (ownerOccMedian != null && "housing.median_value_owner_occupied") ||
    null;

  // Normalize Target Rent
  const targetRent =
    toNum(targets?.target_rent) ??
    toNum(targets?.targetRent) ??
    toNum(targets?.rent_target) ??
    toNum(targets?.recommended_rent) ??
    toNum(targets?.recommendedRent) ??
    toNum(targets?.target_monthly_rent) ??
    toNum(targets?.targetMonthlyRent) ??
    null;

  const market = {
    ...marketRaw,
    avg_home_value: avgHome,
    average_home_value: avgHome,
    avgHome: avgHome,
    city_avg_home: avgHome,
    avg_home_value_source: avgHomeSource,
  };

  const out = {
    key,
    market,
    targets,
    raw: data,
    avg_home_value: avgHome ?? 0,
    target_rent: targetRent ?? 0,
    avg_home_value_source: avgHomeSource
  };

  __CITY_CACHE__.set(key, out);
  return out;
}

// -----------------------------
// //#4 Deterministic pay math
// -----------------------------
function computePay(profile, payTables) {
  const missing = [];

  const payModel = detectPayModel(profile);

  const rank = normalizeRank(profile?.rank_paygrade || profile?.rank || "");
  const yos = toInt(profile?.yos ?? profile?.years_of_service ?? profile?.yearsOfService);

  const famRaw = profile?.family ?? profile?.dependents ?? profile?.has_dependents;
  const family = famRaw === true || String(famRaw).toLowerCase() === "true";

  // Active Duty path (UNCHANGED, except we label model)
  if (payModel === "active_duty") {

    // Prefer explicit ZIP on profile; otherwise derive from base
    const explicitZip = String(profile?.zip || profile?.postal_code || "").trim();
    const baseName = String(profile?.base || profile?.duty_station || profile?.station || "").trim();

    let zip = explicitZip;

    if (!zip && baseName) {
      const baseToZipRaw =
        payTables?.BAH?.base_to_zip ||
        payTables?.BAH?.baseToZip ||
        payTables?.BASE_ZIP ||
        {};

      const baseToZipNorm = new Map();
      for (const [k, v] of Object.entries(baseToZipRaw || {})) {
        const nk = normalizeBaseName(k);
        if (nk) baseToZipNorm.set(nk, String(v || "").trim());
      }

      const derived = baseToZipNorm.get(normalizeBaseName(baseName));
      if (derived) zip = derived;
      else missing.push("bah_base_zip_missing");
    }

    if (!rank) missing.push("rank_paygrade");
    if (yos === null) missing.push("yos");

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
    bas = Number(isOfficer ? basObj.officer : basObj.enlisted) || 0;

    // BAH
    let bah = 0;
    if (zip && rank) {
      const bahByZip = payTables?.BAH?.by_zip || payTables?.BAH?.byZip || null;
      const bahZip =
        (bahByZip && bahByZip?.[zip]) ||
        payTables?.BAH_TX?.[zip] ||
        payTables?.BAH?.[zip] ||
        null;

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
    } else {
      if (!zip) missing.push("bah_zip_missing");
    }

    const totalPay = basePay + bas + bah;

    return {
      ok: missing.length === 0 && totalPay > 0,
      missing,
      pay: {
        payModel,
        basePay,
        bah,
        bas,
        totalPay,
        total: totalPay
      }
    };
  }

  // Veteran/Retired path (NEW)
  if (!rank) missing.push("rank_paygrade");
  if (yos === null) missing.push("yos");

  // Base pay (used only as retirement estimate base)
  let basePayCurrent = 0;
  if (rank && yos !== null) {
    const baseTable = payTables?.BASEPAY?.[rank];
    if (!baseTable) {
      missing.push("basepay_table_for_rank");
    } else {
      const picked = pickNearestYos(baseTable, yos);
      if (picked == null) missing.push("basepay_value");
      else basePayCurrent = Number(picked) || 0;
    }
  }

  const vaPct = toInt(profile?.va_disability ?? profile?.vaDisability ?? profile?.va_rating ?? profile?.vaRating);
  if (vaPct === null) missing.push("va_disability");

  // VA disability monthly (deterministic lookup)
  const va = getVaDisabilityMonthly(payTables, vaPct, family);
  if (vaPct != null && va.amount === 0) missing.push("va_disability_table_missing");

  // Retirement pay estimate monthly
  const ret = estimateRetirementPayMonthly(basePayCurrent, yos ?? 0, profile);
  if (basePayCurrent === 0) missing.push("retirement_basepay_missing");

  // Veterans don't receive BAS/BAH (set to 0)
  const bas = 0;
  const bah = 0;

  const retirementPay = ret.amount;
  const vaDisabilityPay = va.amount;
  const totalVeteranPay = retirementPay + vaDisabilityPay;

  return {
    ok: totalVeteranPay > 0,
    missing,
    pay: {
      payModel,
      // keep these for UI backward compatibility:
      basePay: basePayCurrent,
      bah,
      bas,
      // Make "Total Pay" tile correct immediately:
      totalPay: totalVeteranPay,
      total: totalVeteranPay,
      // new fields for deeper UI:
      retirementPay,
      vaDisabilityPay,
      totalVeteranPay,
      retirementModel: ret.model,
      retirementMultiplier: ret.multiplier,
      vaDisabilitySource: va.source
    }
  };
}

// -----------------------------
// //#5 Output Guardrails
// -----------------------------
function guardBrainResponse(payload){
  const errors = [];

  const out = payload && typeof payload === "object" ? payload : {};
  out.schemaVersion = String(out.schemaVersion || SCHEMA_VERSION);

  if (!out.profile || typeof out.profile !== "object") {
    out.profile = {};
    errors.push("profile_missing");
  }
  if (!out.profile.email) errors.push("profile.email_missing");

  if (!out.pay || typeof out.pay !== "object") {
    out.pay = { basePay: 0, bas: 0, bah: 0, totalPay: 0, total: 0, payModel: "active_duty" };
    errors.push("pay_missing");
  }

  out.pay.basePay = Number(out.pay.basePay) || 0;
  out.pay.bas     = Number(out.pay.bas) || 0;
  out.pay.bah     = Number(out.pay.bah) || 0;
  out.pay.totalPay = Number(out.pay.totalPay) || (out.pay.basePay + out.pay.bas + out.pay.bah);
  out.pay.total = Number(out.pay.total) || out.pay.totalPay;
  out.pay.payModel = String(out.pay.payModel || "active_duty");

  if (!out.city || typeof out.city !== "object") {
    out.city = { key: null, market: {}, targets: {}, raw: {} };
    errors.push("city_missing");
  }
  out.city.avg_home_value = Number(out.city.avg_home_value) || Number(out.city?.market?.avg_home_value) || 0;
  out.city.target_rent    = Number(out.city.target_rent) || 0;

  if (!Array.isArray(out.missing)) out.missing = [];
  const existingErrors = Array.isArray(out.errors) ? out.errors : [];
  out.errors = [...existingErrors, ...errors];

  return out;
}

// -----------------------------
// //#6 Supabase profile lookup
// -----------------------------
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchProfileByEmail(email) {
  const sb = getSupabase();

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
// //#7 Netlify handler
// -----------------------------
export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: buildCorsHeaders(event), body: "" };
    }

    if (event.httpMethod === "GET") {
      return respond(event, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        note: "POST JSON to this endpoint: { email, cityKey, bedrooms }"
      });
    }

    if (event.httpMethod !== "POST") {
      return respond(event, 405, { ok: false, error: "Method not allowed." });
    }

    const body = JSON.parse(event.body || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const cityKey = safeKey(body.cityKey || "SanAntonio");
    const bedrooms = toInt(body.bedrooms) ?? 4;

    if (!email) return respond(event, 400, { ok: false, error: "Missing email." });

    const payTables = loadPayTables();
    const city = loadCity(cityKey);
    const profile = await fetchProfileByEmail(email);
    const computed = computePay(profile, payTables);

    const payload = {
      ok: computed.ok,
      schemaVersion: SCHEMA_VERSION,
      input: { email, cityKey, bedrooms },
      profile,
      pay: computed.pay,
      city,
      missing: computed.missing,
      errors: []
    };

    const hardened = guardBrainResponse(payload);
    return respond(event, 200, hardened);

  } catch (e) {
    return respond(event, 500, {
      ok: false,
      schemaVersion: SCHEMA_VERSION,
      error: String(e?.message || e),
      errors: ["server_error"]
    });
  }
}

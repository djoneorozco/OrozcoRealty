// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.7) — Minimal-input Veteran Pay (NO user-entered dollars)
// - Fetch Supabase profile by email
// - Active Duty: Base Pay + BAS + BAH (deterministic)
// - Veteran/Retired (minimal inputs):
//     * BAH = 0, BAS = 0
//     * VA Disability Pay: computed from DISABILITY_FULL using assumptions:
//         - profile.family (number) => member + spouse + (family-2) children under 18
//         - spouse assumed if family>=2
//     * Retirement Pay (estimate): High-3 using BASEPAY steps (last 3 steps <= YOS)
//         - uses RETIREMENT.systems.high3 multiplier by default (or profile.retirement_system if present)
// - Load city JSON (targets + market averages)
//
// POST BODY:
//   { email, cityKey, bedrooms }
//
// RETURNS:
//   { ok, schemaVersion, input, profile, pay, city, missing }
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = "1.0";

// -----------------------------
// //#1 CORS (robust)
// -----------------------------
function buildCorsHeaders(event){
  const origin = event?.headers?.origin || event?.headers?.Origin || "*";
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
  return { statusCode, headers: buildCorsHeaders(event), body: JSON.stringify(obj) };
}

// -----------------------------
// //#2 Small helpers
// -----------------------------
function safeKey(s) {
  return String(s || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
}

function toInt(x) {
  const n = Number.parseInt(String(x ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function toNum(x) {
  const n = Number(String(x ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function lower(x){ return String(x ?? "").trim().toLowerCase(); }

function normalizeRank(rank) {
  const r = String(rank || "").trim().toUpperCase();
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

// -----------------------------
// //#2.1 Pay model detection (your current data uses: mode = "ad" or "vet")
// -----------------------------
function detectPayModel(profile){
  const mode = lower(profile?.mode || profile?.status || profile?.user_type || profile?.type);

  // treat these as veteran/retired path
  const veteranModes = new Set(["vet","veteran","retired","retiree","separated","civilian"]);

  // treat these as active duty path
  const activeModes = new Set(["ad","active","active_duty","activeduty","active-duty"]);

  if (veteranModes.has(mode)) return "veteran";
  if (activeModes.has(mode)) return "active_duty";

  // default to active duty if unknown (safer for your current UI expectations)
  return "active_duty";
}

// -----------------------------
// //#2.2 Family assumptions from minimal current inputs
// - Your profiles.family is currently stored as text in Supabase.
// - We interpret it as "family size including the member"
//   family=7 => member + spouse + 5 kids under 18
// -----------------------------
function deriveDependentsFromFamilySize(profile){
  const famRaw = profile?.family ?? profile?.dependents ?? profile?.has_dependents;
  const familySize = toInt(famRaw);

  if (!familySize || familySize < 1) {
    return { familySize: 0, hasSpouse: false, kidsUnder18: 0 };
  }

  const hasSpouse = familySize >= 2;
  const kidsUnder18 = Math.max(familySize - 2, 0);

  return { familySize, hasSpouse, kidsUnder18 };
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

/**
 * IMPORTANT FIX:
 * Your UI looks for bedroom blocks at:
 *   brain.city.bedrooms["4"]...
 * or brain.city.by_bedroom["4"]...
 *
 * Your SanAntonio.json stores: raw.by_bedroom
 * Previous brain.js only returned { raw }, so UI couldn't find it.
 *
 * This function now exposes:
 *  - out.by_bedroom  (top-level)
 *  - out.bedrooms    (alias)
 *  - out.avg_home_value (top-level, schema-friendly)
 *  - out.target_rent    (top-level, schema-friendly)
 */
function loadCity(cityKey, bedrooms) {
  const key = safeKey(cityKey || "SanAntonio");
  const beds = toInt(bedrooms) ?? 4;

  // Cache key must include bedrooms now because we compute target_rent from it
  const cacheKey = `${key}__b${beds}`;
  if (__CITY_CACHE__.has(cacheKey)) return __CITY_CACHE__.get(cacheKey);

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

  // --- market avg home value (your existing logic)
  const zillowAvg = toNum(marketRaw?.zillow_average_home_value);
  const medianSale = toNum(marketRaw?.median_sale_price_current);
  const medianList = toNum(marketRaw?.median_listing_price_realtor);
  const ownerOccMedian = toNum(data?.housing?.median_value_owner_occupied);

  const avgHome =
    zillowAvg ??
    medianSale ??
    medianList ??
    ownerOccMedian ??
    // ALSO allow your canonical top-level fields
    toNum(data?.avg_home_value ?? data?.average_home_value ?? data?.avgHome ?? data?.city_avg_home) ??
    null;

  const avgHomeSource =
    (zillowAvg != null && "housing.market.zillow_average_home_value") ||
    (medianSale != null && "housing.market.median_sale_price_current") ||
    (medianList != null && "housing.market.median_listing_price_realtor") ||
    (ownerOccMedian != null && "housing.median_value_owner_occupied") ||
    ((toNum(data?.avg_home_value ?? data?.average_home_value ?? data?.avgHome ?? data?.city_avg_home) != null) && "avg_home_value(top-level)") ||
    null;

  const market = {
    ...marketRaw,
    avg_home_value: avgHome,
    average_home_value: avgHome,
    avgHome: avgHome,
    city_avg_home: avgHome,
    avg_home_value_source: avgHomeSource,
  };

  // --- Bedroom blocks (YOUR SanAntonio.json uses by_bedroom)
  const byBedroom =
    data?.by_bedroom ||
    data?.byBedroom ||
    data?.bedrooms ||
    data?.housing_by_bedroom ||
    null;

  const bedKey = String(beds);
  const bedBlock = (byBedroom && typeof byBedroom === "object")
    ? (byBedroom?.[bedKey] || byBedroom?.[Number(bedKey)] || null)
    : null;

  // --- target rent (schema-friendly, computed from bedroom avg if available)
  const rentFromBedroom =
    toNum(bedBlock?.rent_monthly?.avg) ??
    toNum(bedBlock?.rentMonthly?.avg) ??
    toNum(bedBlock?.rent?.avg) ??
    null;

  const targetRent =
    rentFromBedroom ??
    toNum(data?.target_rent ?? data?.targetRent) ??
    toNum(targets?.target_rent ?? targets?.targetRent) ??
    null;

  // Final city object
  const out = {
    key,

    // existing structure
    market,
    targets,

    // NEW: schema-friendly + UI-friendly top-level fields
    avg_home_value: avgHome,
    average_home_value: avgHome,
    avgHome: avgHome,
    city_avg_home: avgHome,

    target_rent: targetRent,
    targetRent: targetRent,

    // NEW: expose bedroom blocks where UI expects them
    by_bedroom: byBedroom || null,
    bedrooms: byBedroom || null, // alias for your UI scripts
    bedrooms_used: beds,

    // keep raw for everything else (unchanged)
    raw: data,
  };

  __CITY_CACHE__.set(cacheKey, out);
  return out;
}

// -----------------------------
// //#4 Deterministic pay math
// -----------------------------
function computeBasePay(rank, yos, payTables, missing){
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
  return basePay;
}

function computeBAS(rank, payTables){
  const isOfficer = /^O-/.test(rank);
  const basObj = payTables?.BAS || {};
  return Number(isOfficer ? basObj.officer : basObj.enlisted) || 0;
}

function computeBAH(rank, familyBool, zip, payTables, missing){
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
      const bucket = familyBool ? bahZip.with : bahZip.without;
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
  return bah;
}

// -----------------------------
// //#4.1 Veteran VA Disability computation (minimal inputs)
// Uses DISABILITY_FULL if present; otherwise DISABILITY.
// Assumptions:
//  - familySize >= 2 => spouse
//  - kidsUnder18 = familySize - 2
// -----------------------------
function computeVaDisability(profile, payTables, missing){
  const pct = toInt(profile?.va_disability ?? profile?.vaDisability ?? profile?.va_rating ?? profile?.vaRating);
  if (pct === null) {
    missing.push("va_disability");
    return { amount: 0, debug: { pct: null, method: "missing" } };
  }

  const pctKey = String(pct);
  const full = payTables?.DISABILITY_FULL?.[pctKey] || null;

  const { familySize, hasSpouse, kidsUnder18 } = deriveDependentsFromFamilySize(profile);

  // If we have FULL table, use it (better)
  if (full && typeof full === "object") {
    // baseline selection based on our assumptions
    let baseKey = "veteran";
    if (hasSpouse && kidsUnder18 >= 1) baseKey = "veteran_spouse_one_child";
    else if (hasSpouse && kidsUnder18 === 0) baseKey = "veteran_spouse";
    else if (!hasSpouse && kidsUnder18 >= 1) baseKey = "veteran_one_child";

    const base = Number(full?.[baseKey]) || 0;
    const addPerChild = Number(full?.additional_child_under_18) || 0;
    const extraKids = Math.max(kidsUnder18 - 1, 0); // because *_one_child already includes 1 child

    const amount = base + (extraKids * addPerChild);

    return {
      amount,
      debug: {
        pct,
        method: "DISABILITY_FULL",
        familySize,
        hasSpouse,
        kidsUnder18,
        baseKey,
        base,
        addPerChild,
        extraKids
      }
    };
  }

  // fallback to simple table
  const simple = Number(payTables?.DISABILITY?.[pctKey]) || 0;
  if (!simple) missing.push("va_disability_table_missing");
  return { amount: simple, debug: { pct, method: "DISABILITY", familySize } };
}

// -----------------------------
// //#4.2 Retirement pay estimate (High-3 using BASEPAY steps)
// Minimal: rank + yos + retirement_system(optional)
// - High-3 estimate = average of last 3 pay steps <= yos (using available step keys)
// - retirement = high3_est * (multiplier_per_year * yos)
// - If yos < 20 => retirement = 0 (default eligibility rule)
// -----------------------------
function computeRetirementPay(profile, rank, yos, payTables, missing){
  if (yos === null) {
    missing.push("yos");
    return { amount: 0, debug: { method: "missing_yos" } };
  }

  // Eligibility (MVP rule)
  if (yos < 20) {
    return { amount: 0, debug: { method: "ineligible_yos<20", yos } };
  }

  const baseTable = payTables?.BASEPAY?.[rank] || null;
  if (!baseTable) {
    missing.push("basepay_table_for_rank");
    return { amount: 0, debug: { method: "missing_basepay_table" } };
  }

  // Gather step keys <= yos
  const keys = Object.keys(baseTable)
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a,b)=>a-b);

  const eligible = keys.filter(k => k <= yos);
  if (!eligible.length) {
    missing.push("high3_steps_missing");
    return { amount: 0, debug: { method: "no_steps<=yos", yos } };
  }

  // last 3 steps (or fewer if not available)
  const lastSteps = eligible.slice(Math.max(eligible.length - 3, 0));
  const pays = lastSteps.map(k => Number(baseTable[String(k)]) || 0).filter(v => v > 0);

  if (!pays.length) {
    missing.push("high3_values_missing");
    return { amount: 0, debug: { method: "no_pay_values" } };
  }

  const high3 = pays.reduce((a,b)=>a+b,0) / pays.length;

  // retirement system
  const sysRaw = lower(profile?.retirement_system || profile?.retirementSystem || "high3");
  const sys = (sysRaw === "brs" || sysRaw === "blended") ? "brs" : "high3";

  const multPerYear = toNum(payTables?.RETIREMENT?.systems?.[sys]?.multiplier_per_year) ?? (sys === "brs" ? 0.02 : 0.025);
  const rawMultiplier = multPerYear * yos;

  // soft cap
  const cap = (sys === "brs") ? 0.60 : 0.75;
  const multiplier = Math.min(rawMultiplier, cap);

  const amount = high3 * multiplier;

  return {
    amount,
    debug: {
      method: "high3_estimate_from_BASEPAY",
      sys,
      multPerYear,
      yos,
      multiplier,
      high3,
      stepsUsed: lastSteps,
      paysUsed: pays
    }
  };
}

// -----------------------------
// //#4.3 Main pay compute
// -----------------------------
function computePay(profile, payTables) {
  const missing = [];

  const payModel = detectPayModel(profile);

  const rank = normalizeRank(profile?.rank_paygrade || profile?.rank || "");
  const yos = toInt(profile?.yos ?? profile?.years_of_service ?? profile?.yearsOfService);

  // Family boolean for AD BAH lookup
  const famRaw = profile?.family ?? profile?.dependents ?? profile?.has_dependents;
  const familyBool = String(famRaw).toLowerCase() === "true" || famRaw === true || (toInt(famRaw) || 0) >= 2;

  // Prefer explicit ZIP; otherwise derive from base
  const explicitZip = String(profile?.zip || profile?.postal_code || "").trim();

  // IMPORTANT: include next duty fields too (helps Lackland routing in your data)
  const baseName = String(
    profile?.base ||
    profile?.duty_station ||
    profile?.station ||
    profile?.next_duty_location ||
    profile?.nextDutyLocation ||
    ""
  ).trim();

  let zip = explicitZip;

  if (!rank) missing.push("rank_paygrade");
  if (yos === null) missing.push("yos");

  // Compute base pay (used for AD totals, and also shown for vets as a proxy)
  const basePay = computeBasePay(rank, yos, payTables, missing);

  // -------------------------
  // Veteran Path
  // -------------------------
  if (payModel === "veteran") {
    const bas = 0;
    const bah = 0;

    const va = computeVaDisability(profile, payTables, missing);
    const ret = computeRetirementPay(profile, rank, yos, payTables, missing);

    const retirementPay = Number(ret.amount) || 0;
    const vaDisabilityPay = Number(va.amount) || 0;

    const totalPay = retirementPay + vaDisabilityPay;

    return {
      ok: totalPay > 0,
      missing,
      pay: {
        payModel,
        payAccuracy: "deterministic_va + estimated_retirement",
        basePay,         // proxy (current base pay step)
        bas,             // 0 for vets
        bah,             // 0 for vets
        retirementPay,
        vaDisabilityPay,
        totalPay,
        total: totalPay,
        debug: { retirement: ret.debug, va: va.debug }
      },
    };
  }

  // -------------------------
  // Active Duty Path
  // -------------------------
  // Derive ZIP from base if missing
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

  const bas = computeBAS(rank, payTables);
  const bah = computeBAH(rank, familyBool, zip, payTables, missing);
  const totalPay = basePay + bas + bah;

  return {
    ok: missing.length === 0 && totalPay > 0,
    missing,
    pay: {
      payModel,
      payAccuracy: "deterministic",
      basePay,
      bah,
      bas,
      totalPay,
      total: totalPay
    },
  };
}

// -----------------------------
// //#5 Supabase profile lookup
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
// //#6 Netlify handler
// -----------------------------
export async function handler(event) {
  try {
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: buildCorsHeaders(event), body: "" };
    }

    // GET sanity check
    if (event.httpMethod === "GET") {
      return respond(event, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        note: "POST JSON to this endpoint: { email, cityKey, bedrooms }",
      });
    }

    if (event.httpMethod !== "POST") {
      return respond(event, 405, { ok: false, schemaVersion: SCHEMA_VERSION, error: "Method not allowed." });
    }

    const body = JSON.parse(event.body || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const cityKey = safeKey(body.cityKey || "SanAntonio");
    const bedrooms = toInt(body.bedrooms) ?? 4;

    if (!email) return respond(event, 400, { ok: false, schemaVersion: SCHEMA_VERSION, error: "Missing email." });

    const payTables = loadPayTables();

    // IMPORTANT: loadCity now also receives bedrooms to compute target_rent and expose bedroom blocks
    const city = loadCity(cityKey, bedrooms);

    const profile = await fetchProfileByEmail(email);
    const computed = computePay(profile, payTables);

    return respond(event, 200, {
      ok: computed.ok,
      schemaVersion: SCHEMA_VERSION,
      input: { email, cityKey, bedrooms },
      profile,
      pay: computed.pay,
      city,
      missing: computed.missing,
    });

  } catch (e) {
    return respond(event, 500, { ok: false, schemaVersion: SCHEMA_VERSION, error: String(e?.message || e) });
  }
}

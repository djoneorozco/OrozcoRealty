// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.9) — Pay + City + FULL Mortgage Breakdown
//
// ✅ Key upgrades vs your v1.8:
// - Returns a consistent mortgage object with:
//   mortgage.breakdown = { principalInterest, propertyTax, insurance, hoa, pmi, totalMonthly }
// - Tracks sources for each assumption (APR, taxRate, insRate, HOA, PMI, price, dpPct)
// - Keeps deterministic APR by credit score (same bands as your dashboard)
// - Uses city defaults when available (property_tax_rate, insurance_rate, hoa_monthly)
// - Safe fallbacks when city fields are missing
//
// POST BODY:
// {
//   email, cityKey, bedrooms,
//   price?, dpPct?, termYears?, creditScore?, apr?,
//   taxRate?, insRate?, hoa?, pmiRate?, loanType?,
//   overrides?: { ...safe profile overrides... }
// }
//
// RETURNS:
// { ok, schemaVersion, input, profile, profileEffective, overridesApplied, pay, city, missing,
//   mortgage: { ok, breakdown, assumptions, sources },
//   estimatedMonthlyMortgage
// }
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = "1.2";

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

function pickFirst(obj, keys){
  for (const k of keys){
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// -----------------------------
// //#2.1 Pay model detection
// -----------------------------
function detectPayModel(profile){
  const mode = lower(profile?.mode || profile?.status || profile?.user_type || profile?.type);

  const veteranModes = new Set(["vet","veteran","retired","retiree","separated","civilian"]);
  const activeModes = new Set(["ad","active","active_duty","activeduty","active-duty"]);

  if (veteranModes.has(mode)) return "veteran";
  if (activeModes.has(mode)) return "active_duty";

  return "active_duty";
}

// -----------------------------
// //#2.2 Family assumptions
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
// //#2.3 Apply “what-if” overrides (never persisted)
// -----------------------------
function applyOverridesToProfile(profile, overridesRaw){
  const overrides = (overridesRaw && typeof overridesRaw === "object") ? overridesRaw : null;
  if (!profile || !overrides) return { profileEffective: profile, overridesApplied: null };

  const ALLOWED = new Set([
    "rank_paygrade","rank",
    "yos","years_of_service","yearsOfService",
    "base","duty_station","station",
    "zip","postal_code",
    "family","dependents","has_dependents",
    "mode","status","user_type","type",
    "va_disability","vaDisability","va_rating","vaRating",
    "creditScore","credit_score",
    "dpPct","down_payment_pct",
    "termYears","term_years",
    "apr"
  ]);

  const applied = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!ALLOWED.has(k)) continue;
    if (v === undefined) continue;
    applied[k] = v;
  }

  if (!Object.keys(applied).length) {
    return { profileEffective: profile, overridesApplied: null };
  }

  if (applied.rank_paygrade != null) applied.rank_paygrade = normalizeRank(applied.rank_paygrade);
  if (applied.rank != null) applied.rank = normalizeRank(applied.rank);

  const out = { ...profile, ...applied };
  return { profileEffective: out, overridesApplied: applied };
}

// -----------------------------
// //#3 File loading (Netlify-safe)
// -----------------------------
const ROOT = process.cwd(); // /var/task

const PAY_TABLES_PATHS = [
  path.join(ROOT, "netlify", "functions", "militaryPayTables.json"),
  path.join(ROOT, "netlify", "functions", "data", "militaryPayTables.json"),
];

const CITIES_DIR = path.join(ROOT, "netlify", "functions", "cities");

let __PAY_TABLES_CACHE__ = null;
let __PAY_TABLES_PATH_USED__ = null;
const __CITY_CACHE__ = new Map();

function loadPayTables() {
  if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;

  let found = null;
  for (const p of PAY_TABLES_PATHS) {
    if (fs.existsSync(p)) { found = p; break; }
  }

  if (!found) {
    throw new Error(
      `militaryPayTables.json not found. Tried:\n- ${PAY_TABLES_PATHS.join("\n- ")}\n` +
      `Fix: ensure it's bundled via netlify.toml [functions].included_files.`
    );
  }

  const raw = fs.readFileSync(found, "utf8");
  __PAY_TABLES_CACHE__ = JSON.parse(raw);
  __PAY_TABLES_PATH_USED__ = found;
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

  // Normalize market + targets (keeps your existing behavior)
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

  const zillowAvg = toNum(marketRaw?.zillow_average_home_value);
  const medianSale = toNum(marketRaw?.median_sale_price_current);
  const medianList = toNum(marketRaw?.median_listing_price_realtor);
  const ownerOccMedian = toNum(data?.housing?.median_value_owner_occupied);

  const avgHome =
    zillowAvg ??
    medianSale ??
    medianList ??
    ownerOccMedian ??
    toNum(data?.avg_home_value ?? data?.average_home_value ?? data?.avgHome ?? data?.city_avg_home) ??
    null;

  const avgHomeSource =
    (zillowAvg != null && "housing.market.zillow_average_home_value") ||
    (medianSale != null && "housing.market.median_sale_price_current") ||
    (medianList != null && "housing.market.median_listing_price_realtor") ||
    (ownerOccMedian != null && "housing.median_value_owner_occupied") ||
    null;

  const market = {
    ...marketRaw,
    avg_home_value: avgHome,
    average_home_value: avgHome,
    avgHome: avgHome,
    city_avg_home: avgHome,
    avg_home_value_source: avgHomeSource,
  };

  // Bedroom blocks
  const bedrooms =
    (data?.bedrooms && typeof data.bedrooms === "object" ? data.bedrooms : null) ||
    (data?.by_bedroom && typeof data.by_bedroom === "object" ? data.by_bedroom : null) ||
    (data?.byBedroom && typeof data.byBedroom === "object" ? data.byBedroom : null) ||
    null;

  const bedroomsUsed =
    (data?.bedrooms && "bedrooms") ||
    (data?.by_bedroom && "by_bedroom") ||
    (data?.byBedroom && "byBedroom") ||
    null;

  function avgFromBedroomPath(obj, getter){
    if (!obj || typeof obj !== "object") return null;
    const vals = [];
    for (const k of Object.keys(obj)){
      const v = getter(obj[k]);
      const n = toNum(v);
      if (n != null && n > 0) vals.push(n);
    }
    if (!vals.length) return null;
    return Math.round(vals.reduce((a,b)=>a+b,0) / vals.length);
  }

  const derivedTargetRent = avgFromBedroomPath(bedrooms, (b)=> b?.rent_monthly?.avg ?? b?.rentMonthly?.avg ?? b?.rent?.avg);
  const derivedUtilities  = avgFromBedroomPath(bedrooms, (b)=> b?.utilities?.total?.avg ?? b?.utilities_total?.avg ?? b?.utilities?.avg);

  const targetRent =
    toNum(data?.target_rent ?? data?.targetRent ?? targets?.target_rent ?? targets?.targetRent) ??
    derivedTargetRent ??
    null;

  const avgUtilities =
    toNum(data?.avg_utilities ?? data?.average_utilities ?? data?.avgUtilities) ??
    derivedUtilities ??
    null;

  const out = {
    key,
    ...data,
    market,
    targets,
    raw: data,

    bedrooms,
    bedrooms_used: bedroomsUsed,

    target_rent: targetRent,
    targetRent: targetRent,

    avg_home_value: toNum(data?.avg_home_value ?? data?.average_home_value ?? data?.avgHome ?? data?.city_avg_home) ?? avgHome ?? null,
    average_home_value: toNum(data?.average_home_value) ?? (toNum(data?.avg_home_value) ?? avgHome ?? null),
    avgHome: toNum(data?.avgHome) ?? (toNum(data?.avg_home_value) ?? avgHome ?? null),
    city_avg_home: toNum(data?.city_avg_home) ?? (toNum(data?.avg_home_value) ?? avgHome ?? null),

    avg_utilities: avgUtilities,
    average_utilities: avgUtilities,
    avgUtilities: avgUtilities,
  };

  __CITY_CACHE__.set(key, out);
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

function computeVaDisability(profile, payTables, missing){
  const pct = toInt(profile?.va_disability ?? profile?.vaDisability ?? profile?.va_rating ?? profile?.vaRating);
  if (pct === null) {
    missing.push("va_disability");
    return { amount: 0, debug: { pct: null, method: "missing" } };
  }

  const pctKey = String(pct);
  const full = payTables?.DISABILITY_FULL?.[pctKey] || null;

  const { familySize, hasSpouse, kidsUnder18 } = deriveDependentsFromFamilySize(profile);

  if (full && typeof full === "object") {
    let baseKey = "veteran";
    if (hasSpouse && kidsUnder18 >= 1) baseKey = "veteran_spouse_one_child";
    else if (hasSpouse && kidsUnder18 === 0) baseKey = "veteran_spouse";
    else if (!hasSpouse && kidsUnder18 >= 1) baseKey = "veteran_one_child";

    const base = Number(full?.[baseKey]) || 0;
    const addPerChild = Number(full?.additional_child_under_18) || 0;
    const extraKids = Math.max(kidsUnder18 - 1, 0);

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

  const simple = Number(payTables?.DISABILITY?.[pctKey]) || 0;
  if (!simple) missing.push("va_disability_table_missing");
  return { amount: simple, debug: { pct, method: "DISABILITY", familySize } };
}

function computeRetirementPay(profile, rank, yos, payTables, missing){
  if (yos === null) {
    missing.push("yos");
    return { amount: 0, debug: { method: "missing_yos" } };
  }

  if (yos < 20) {
    return { amount: 0, debug: { method: "ineligible_yos<20", yos } };
  }

  const baseTable = payTables?.BASEPAY?.[rank] || null;
  if (!baseTable) {
    missing.push("basepay_table_for_rank");
    return { amount: 0, debug: { method: "missing_basepay_table" } };
  }

  const keys = Object.keys(baseTable)
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a,b)=>a-b);

  const eligible = keys.filter(k => k <= yos);
  if (!eligible.length) {
    missing.push("high3_steps_missing");
    return { amount: 0, debug: { method: "no_steps<=yos", yos } };
  }

  const lastSteps = eligible.slice(Math.max(eligible.length - 3, 0));
  const pays = lastSteps.map(k => Number(baseTable[String(k)]) || 0).filter(v => v > 0);

  if (!pays.length) {
    missing.push("high3_values_missing");
    return { amount: 0, debug: { method: "no_pay_values" } };
  }

  const high3 = pays.reduce((a,b)=>a+b,0) / pays.length;

  const sysRaw = lower(profile?.retirement_system || profile?.retirementSystem || "high3");
  const sys = (sysRaw === "brs" || sysRaw === "blended") ? "brs" : "high3";

  const multPerYear = toNum(payTables?.RETIREMENT?.systems?.[sys]?.multiplier_per_year) ?? (sys === "brs" ? 0.02 : 0.025);
  const rawMultiplier = multPerYear * yos;

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

function computePay(profile, payTables) {
  const missing = [];

  const payModel = detectPayModel(profile);

  const rank = normalizeRank(profile?.rank_paygrade || profile?.rank || "");
  const yos = toInt(profile?.yos ?? profile?.years_of_service ?? profile?.yearsOfService);

  const famRaw = profile?.family ?? profile?.dependents ?? profile?.has_dependents;
  const familyBool = String(famRaw).toLowerCase() === "true" || famRaw === true || (toInt(famRaw) || 0) >= 2;

  const explicitZip = String(profile?.zip || profile?.postal_code || "").trim();
  const baseName = String(profile?.base || profile?.duty_station || profile?.station || "").trim();
  let zip = explicitZip;

  if (!rank) missing.push("rank_paygrade");
  if (yos === null) missing.push("yos");

  const basePay = computeBasePay(rank, yos, payTables, missing);

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
        basePay,
        bas,
        bah,
        retirementPay,
        vaDisabilityPay,
        totalPay,
        total: totalPay,
        debug: { retirement: ret.debug, va: va.debug }
      },
    };
  }

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
// //#4.5 Mortgage math (FULL breakdown)
// -----------------------------
function pmti(P, r, n){
  if (!P || P <= 0 || !Number.isFinite(P)) return 0;
  if (!r || r === 0) return P / Math.max(1, n);
  const x = Math.pow(1 + r, n);
  return P * (r * x) / (x - 1);
}

// Same APR bands your dashboard uses
function scoreAPR(score){
  const s = Number(score) || 720;
  if (s>=780) return 6.50;
  if (s>=760) return 6.75;
  if (s>=720) return 7.00;
  if (s>=700) return 7.20;
  if (s>=680) return 7.35;
  if (s>=660) return 7.85;
  if (s>=640) return 8.25;
  if (s>=620) return 9.25;
  return 9.95;
}

function pickMortgagePrice({ body, profile, city, bedrooms }){
  const bodyPrice = toNum(body?.price ?? body?.homePrice ?? body?.purchase_price ?? body?.purchasePrice);
  const profPrice = toNum(profile?.price ?? profile?.home_price ?? profile?.projected_home_price ?? profile?.projectedHomePrice);

  const bedsKey = String(bedrooms ?? 4);
  const bedsRoot =
    city?.bedrooms || city?.raw?.bedrooms ||
    city?.by_bedroom || city?.raw?.by_bedroom ||
    city?.byBedroom || city?.raw?.byBedroom ||
    null;

  let bedPrice = null;
  if (bedsRoot && typeof bedsRoot === "object"){
    const b = bedsRoot[bedsKey] || bedsRoot[Number(bedsKey)] || null;
    if (b){
      const block = b?.home_price ?? b?.homePrice ?? b?.price ?? b?.home_value;
      const avg = (typeof block === "object") ? toNum(block?.avg ?? block?.value ?? block?.amount) : toNum(block);
      const low = (typeof block === "object") ? toNum(block?.low) : null;
      const high= (typeof block === "object") ? toNum(block?.high): null;
      bedPrice = avg ?? (low!=null && high!=null ? Math.round((low+high)/2) : null);
    }
  }

  const cityAvg =
    toNum(city?.avg_home_value ?? city?.average_home_value ?? city?.avgHome ?? city?.city_avg_home) ??
    toNum(city?.market?.avg_home_value ?? city?.market?.zillow_average_home_value) ??
    toNum(city?.raw?.avg_home_value ?? city?.raw?.average_home_value) ??
    toNum(city?.raw?.market?.zillow_average_home_value) ??
    null;

  const price = bodyPrice ?? profPrice ?? bedPrice ?? cityAvg ?? 0;

  const source =
    (bodyPrice != null && "body.price") ||
    (profPrice != null && "profile.price") ||
    (bedPrice != null && "city.bedrooms[bed].home_price") ||
    (cityAvg != null && "city.avg_home_value") ||
    "none";

  return { price, source };
}

// Decide a default PMI/MIP behavior by loan type (still simple & deterministic)
function defaultPmiRate({ loanType, dpPct }){
  const lt = String(loanType || "").trim().toLowerCase();
  if (lt === "va") return 0;                  // VA: no monthly PMI
  if (lt === "fha") return 0.55;              // FHA: typical annual MIP ballpark (simplified)
  if (dpPct >= 20) return 0;                  // no PMI at >=20% down
  return 0.50;                                // conventional PMI ballpark
}

function computeMortgageEstimate({ body, profile, city, bedrooms }){
  const sources = {};

  const { price, source: priceSource } = pickMortgagePrice({ body, profile, city, bedrooms });
  sources.price = priceSource;

  if (!price || price <= 0){
    return {
      ok: false,
      breakdown: {
        principalInterest: 0,
        propertyTax: 0,
        insurance: 0,
        hoa: 0,
        pmi: 0,
        totalMonthly: 0,
      },
      assumptions: { note: "No price available yet." },
      sources
    };
  }

  // Down payment %
  const dpPct =
    toNum(body?.dpPct ?? body?.downPaymentPct ?? profile?.dpPct ?? profile?.down_payment_pct) ??
    toNum(city?.mortgage_assumptions?.down_payment_percent) ??
    5;
  sources.dpPct =
    (body?.dpPct != null || body?.downPaymentPct != null) ? "body.dpPct" :
    (profile?.dpPct != null || profile?.down_payment_pct != null) ? "profile.dpPct" :
    (city?.mortgage_assumptions?.down_payment_percent != null) ? "city.mortgage_assumptions.down_payment_percent" :
    "default:5";

  // Term
  const termYears =
    toInt(body?.termYears ?? body?.term ?? profile?.termYears ?? profile?.term_years) ??
    toInt(city?.mortgage_assumptions?.term_years) ??
    30;
  sources.termYears =
    (body?.termYears != null || body?.term != null) ? "body.termYears" :
    (profile?.termYears != null || profile?.term_years != null) ? "profile.termYears" :
    (city?.mortgage_assumptions?.term_years != null) ? "city.mortgage_assumptions.term_years" :
    "default:30";

  // Credit score -> APR
  const creditScore =
    toInt(body?.creditScore ?? profile?.creditScore ?? profile?.credit_score) ??
    null;

  const apr =
    toNum(body?.apr ?? profile?.apr) ??
    (creditScore != null ? scoreAPR(creditScore) : toNum(city?.mortgage_assumptions?.apr_percent)) ??
    7.0;
  sources.apr =
    (body?.apr != null) ? "body.apr" :
    (profile?.apr != null) ? "profile.apr" :
    (creditScore != null) ? "scoreAPR(creditScore)" :
    (city?.mortgage_assumptions?.apr_percent != null) ? "city.mortgage_assumptions.apr_percent" :
    "default:7.0";

  // City-driven rates (these DO vary by city/county/state)
  const taxRate =
    toNum(body?.taxRate ?? profile?.taxRate) ??
    toNum(city?.tax_rate ?? city?.property_tax_rate ?? city?.raw?.property_tax_rate) ??
    1.20;
  sources.taxRate =
    (body?.taxRate != null) ? "body.taxRate" :
    (profile?.taxRate != null) ? "profile.taxRate" :
    (city?.tax_rate != null) ? "city.tax_rate" :
    (city?.property_tax_rate != null || city?.raw?.property_tax_rate != null) ? "city.property_tax_rate" :
    "default:1.20";

  const insRate =
    toNum(body?.insRate ?? profile?.insRate) ??
    toNum(city?.insurance_rate ?? city?.raw?.insurance_rate) ??
    0.50;
  sources.insRate =
    (body?.insRate != null) ? "body.insRate" :
    (profile?.insRate != null) ? "profile.insRate" :
    (city?.insurance_rate != null || city?.raw?.insurance_rate != null) ? "city.insurance_rate" :
    "default:0.50";

  const hoa =
    toNum(body?.hoa ?? profile?.hoa ?? profile?.hoa_monthly ?? city?.hoa_monthly ?? city?.raw?.hoa_monthly) ??
    0;
  sources.hoa =
    (body?.hoa != null) ? "body.hoa" :
    (profile?.hoa != null || profile?.hoa_monthly != null) ? "profile.hoa_monthly" :
    (city?.hoa_monthly != null || city?.raw?.hoa_monthly != null) ? "city.hoa_monthly" :
    "default:0";

  // PMI (loan-type dependent). If caller explicitly provides pmiRate, we use it.
  const loanType = String(body?.loanType ?? profile?.loanType ?? profile?.loan_type ?? "").trim();
  const pmiRate =
    toNum(body?.pmiRate ?? profile?.pmiRate) ??
    defaultPmiRate({ loanType, dpPct });
  sources.pmiRate =
    (body?.pmiRate != null) ? "body.pmiRate" :
    (profile?.pmiRate != null) ? "profile.pmiRate" :
    "defaultPmiRate(loanType,dpPct)";

  const dpAmt = Math.max(0, price * (Math.max(0, dpPct) / 100));
  const loan  = Math.max(0, price - dpAmt);

  const mRate = (apr/100) / 12;
  const n = Math.max(1, termYears * 12);

  const principalInterest = loan > 0 ? pmti(loan, mRate, n) : 0;

  const propertyTax = (price * (taxRate/100)) / 12;
  const insurance  = (price * (insRate/100)) / 12;

  const pmi = (loan > 0 && pmiRate > 0) ? (loan * (pmiRate/100)) / 12 : 0;

  const totalMonthly = principalInterest + propertyTax + insurance + hoa + pmi;

  return {
    ok: totalMonthly > 0,
    breakdown: {
      principalInterest,
      propertyTax,
      insurance,
      hoa,
      pmi,
      totalMonthly
    },
    assumptions: {
      price,
      dpPct,
      dpAmt,
      loan,
      apr,
      termYears,
      taxRate,
      insRate,
      hoa,
      pmiRate,
      loanType: loanType || undefined,
      creditScore: creditScore ?? undefined
    },
    sources
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
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: buildCorsHeaders(event), body: "" };
    }

    if (event.httpMethod === "GET") {
      return respond(event, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        note: "POST JSON: { email, cityKey, bedrooms, price?, dpPct?, termYears?, creditScore?, apr?, taxRate?, insRate?, hoa?, pmiRate?, loanType?, overrides? }",
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
    const city = loadCity(cityKey);

    const profile = await fetchProfileByEmail(email);

    // Apply “what-if” overrides (never persisted)
    const { profileEffective, overridesApplied } = applyOverridesToProfile(profile, body.overrides);

    const computed = computePay(profileEffective, payTables);

    // FULL mortgage breakdown (this is what your UI should consume)
    const mortgage = computeMortgageEstimate({ body, profile: profileEffective, city, bedrooms });

    return respond(event, 200, {
      ok: computed.ok,
      schemaVersion: SCHEMA_VERSION,
      input: { email, cityKey, bedrooms },
      debug: { payTablesPathUsed: __PAY_TABLES_PATH_USED__ || null },

      profile,
      profileEffective,
      overridesApplied: overridesApplied || null,

      pay: computed.pay,
      city,
      missing: computed.missing,

      mortgage,
      estimatedMonthlyMortgage: Number(mortgage?.breakdown?.totalMonthly || 0) || 0,
    });

  } catch (e) {
    return respond(event, 500, { ok: false, schemaVersion: SCHEMA_VERSION, error: String(e?.message || e) });
  }
}

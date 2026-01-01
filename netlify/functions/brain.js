// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.4) — Schema Versioning + Guardrails (NO logic changes)
// - Fetch Supabase profile by email
// - Compute Base Pay + BAS + BAH + Total Pay (deterministic)
// - Load city JSON (targets + market averages)
// - Adds schemaVersion + stable response shape
// - Adds pay.total alias (keeps pay.totalPay for backward compatibility)
// - Optional: reads schema files if present (profile.schema.json / brain.schema.json)
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
//     pay: { basePay, bah, bas, totalPay, total },
//     city: { key, market, targets, raw, avg_home_value, target_rent, ... },
//     missing: [...],
//     errors: [...],
//     schema: { profile: {...}?, brain: {...}? }   // optional (only if found)
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

// -----------------------------
// //#2.5 Schema file loader (optional, non-blocking)
// - You created: profile.schema.json + brain.schema.json
// - You said folder: netlify/function (singular)
// - Project baseline is: netlify/functions (plural)
// We look for both. If not found (Netlify bundle), we just skip.
// -----------------------------
const __SCHEMA_CACHE__ = { profile: null, brain: null, tried: false };

function tryLoadSchemaFiles(){
  if (__SCHEMA_CACHE__.tried) return __SCHEMA_CACHE__;
  __SCHEMA_CACHE__.tried = true;

  try {
    const ROOT = process.cwd();
    const candidates = [
      path.join(ROOT, "netlify", "functions"),
      path.join(ROOT, "netlify", "function")
    ];

    let schemaDir = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { schemaDir = c; break; }
    }
    if (!schemaDir) return __SCHEMA_CACHE__;

    const profilePath = path.join(schemaDir, "profile.schema.json");
    const brainPath   = path.join(schemaDir, "brain.schema.json");

    if (fs.existsSync(profilePath)) {
      __SCHEMA_CACHE__.profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    }
    if (fs.existsSync(brainPath)) {
      __SCHEMA_CACHE__.brain = JSON.parse(fs.readFileSync(brainPath, "utf8"));
    }
  } catch {
    // never block runtime for schema loading
  }

  return __SCHEMA_CACHE__;
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

  // ------------------------------------------------------------
  // //#3.1 Normalize "City Avg Home" into predictable keys
  // ------------------------------------------------------------
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

  // Normalize target rent if present (best-effort aliases)
  const targetRent =
    toNum(targets?.target_rent) ??
    toNum(targets?.targetRent) ??
    toNum(targets?.rent_target) ??
    toNum(targets?.recommended_rent) ??
    toNum(targets?.recommendedRent) ??
    toNum(targets?.target_monthly_rent) ??
    toNum(targets?.targetMonthlyRent) ??
    null;

  // Create a market object that keeps your existing fields,
  // but adds canonical aliases the UI can reliably read.
  const market = {
    ...marketRaw,

    // Canonical + common aliases (so your tile will populate)
    avg_home_value: avgHome,
    average_home_value: avgHome,
    avgHome: avgHome,
    city_avg_home: avgHome,

    // Debug hint
    avg_home_value_source: avgHomeSource,
  };

  // City wrapper stays the same, but we also surface
  // canonical summary fields at the top-level for convenience.
  const out = {
    key,
    market,
    targets,
    raw: data,

    // canonical summary fields
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

  const rank = normalizeRank(profile?.rank_paygrade || profile?.rank || "");
  const yos = toInt(profile?.yos ?? profile?.years_of_service ?? profile?.yearsOfService);

  const famRaw = profile?.family ?? profile?.dependents ?? profile?.has_dependents;
  const family = famRaw === true || String(famRaw).toLowerCase() === "true";

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
    // Keep legacy field name totalPay, and we’ll add alias later
    pay: { basePay, bah, bas, totalPay }
  };
}

// -----------------------------
// //#4.5 Output Guardrails (schema-ish without dependencies)
// - Ensures stable fields exist
// - Adds pay.total alias
// - Adds errors array
// -----------------------------
function guardBrainResponse(payload){
  const errors = [];

  const out = payload && typeof payload === "object" ? payload : {};
  out.schemaVersion = String(out.schemaVersion || SCHEMA_VERSION);

  // profile
  if (!out.profile || typeof out.profile !== "object") {
    out.profile = {};
    errors.push("profile_missing");
  }
  if (!out.profile.email) {
    errors.push("profile.email_missing");
  }

  // pay
  if (!out.pay || typeof out.pay !== "object") {
    out.pay = { basePay: 0, bas: 0, bah: 0, totalPay: 0 };
    errors.push("pay_missing");
  }

  // Normalize numeric values
  out.pay.basePay = Number(out.pay.basePay) || 0;
  out.pay.bas     = Number(out.pay.bas) || 0;
  out.pay.bah     = Number(out.pay.bah) || 0;
  out.pay.totalPay = Number(out.pay.totalPay) || (out.pay.basePay + out.pay.bas + out.pay.bah);

  // Add schema-friendly alias (does not break old UI)
  out.pay.total = Number(out.pay.total) || out.pay.totalPay;

  // city
  if (!out.city || typeof out.city !== "object") {
    out.city = { key: null, market: {}, targets: {}, raw: {} };
    errors.push("city_missing");
  }
  // Make sure canonical fields exist at top-level
  out.city.avg_home_value = Number(out.city.avg_home_value) || Number(out.city?.market?.avg_home_value) || 0;
  out.city.target_rent    = Number(out.city.target_rent) || 0;

  // missing array
  if (!Array.isArray(out.missing)) out.missing = [];

  // attach errors (merge)
  const existingErrors = Array.isArray(out.errors) ? out.errors : [];
  out.errors = [...existingErrors, ...errors];

  return out;
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
      const schemas = tryLoadSchemaFiles();
      return respond(event, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        note: "POST JSON to this endpoint: { email, cityKey, bedrooms }",
        schemaFilesFound: {
          profile: !!schemas.profile,
          brain: !!schemas.brain
        }
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

    // Optional schema files (non-blocking)
    const schemas = tryLoadSchemaFiles();

    // Build response (same as before, plus schemaVersion + errors)
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

    // Attach schema files only if found (safe, optional)
    if (schemas.profile || schemas.brain) {
      payload.schema = {};
      if (schemas.profile) payload.schema.profile = schemas.profile;
      if (schemas.brain) payload.schema.brain = schemas.brain;
    }

    // Guardrails (adds pay.total alias, canonical city fields, etc.)
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

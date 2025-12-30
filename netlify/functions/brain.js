// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.0) — Single source of truth for:
// - Supabase profile lookup by email
// - Pay calc (Base Pay + BAS + BAH) using militaryPayTables.json
// - City market pull using cities/<cityKey>.json
//
// Fixes:
// - NO redeclare of __filename (prevents Netlify crash)
// - Proper CORS + OPTIONS handling (preflight passes on Webflow)
// ============================================================

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

// ============================================================
// //#0 – CORS
// ============================================================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload)
  };
}

// ============================================================
// //#1 – Lazy file caches (so we don’t re-read JSON every call)
// ============================================================
let _PAY_CACHE = null;
let _CITY_CACHE = new Map();

function loadPayTables() {
  if (_PAY_CACHE) return _PAY_CACHE;

  const payPath = path.join(__dirname, "data", "militaryPayTables.json");
  const raw = fs.readFileSync(payPath, "utf8");
  _PAY_CACHE = JSON.parse(raw);
  return _PAY_CACHE;
}

function loadCity(cityKey) {
  const key = String(cityKey || "").trim();
  if (!key) return null;

  if (_CITY_CACHE.has(key)) return _CITY_CACHE.get(key);

  const cityPath = path.join(__dirname, "cities", `${key}.json`);
  if (!fs.existsSync(cityPath)) return null;

  const raw = fs.readFileSync(cityPath, "utf8");
  const city = JSON.parse(raw);
  _CITY_CACHE.set(key, city);
  return city;
}

// ============================================================
// //#2 – Helpers
// ============================================================
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1";
  }
  return false;
}

function cleanZip(z) {
  const s = String(z || "").trim();
  const m = s.match(/\d{5}/);
  return m ? m[0] : "";
}

function num(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

// pick exact YOS if exists, otherwise pick highest YOS <= requested
function pickYosValue(table, yos) {
  if (!table || typeof table !== "object") return null;

  const yosNum = Math.max(0, Math.floor(num(yos)));
  const exactKey = String(yosNum);

  if (Object.prototype.hasOwnProperty.call(table, exactKey)) {
    return num(table[exactKey]);
  }

  // fallback: nearest lower
  const keys = Object.keys(table)
    .map(k => Number(k))
    .filter(k => Number.isFinite(k))
    .sort((a, b) => a - b);

  if (!keys.length) return null;

  let best = null;
  for (const k of keys) {
    if (k <= yosNum) best = k;
    if (k > yosNum) break;
  }
  if (best === null) best = keys[0];
  return num(table[String(best)]);
}

function isOfficer(rankPaygrade) {
  const r = String(rankPaygrade || "").toUpperCase().trim();
  return r.startsWith("O-") || r.startsWith("O");
}

// ============================================================
// //#3 – Core compute
// ============================================================
function computePay({ payTables, rankPaygrade, yos, zip, family }) {
  const missing = [];

  const rankKey = String(rankPaygrade || "").trim();
  if (!rankKey) missing.push("rank_paygrade");

  const yosNum = Math.max(0, Math.floor(num(yos)));
  if (!Number.isFinite(yosNum)) missing.push("yos");

  const zip5 = cleanZip(zip);
  if (!zip5) missing.push("zip");

  // --- Base Pay ---
  let basePay = null;
  try {
    const baseTable = payTables?.BASEPAY?.[rankKey];
    basePay = pickYosValue(baseTable, yosNum);
    if (!basePay) missing.push("basePay");
  } catch (_) {
    missing.push("basePay");
  }

  // --- BAS ---
  let bas = null;
  try {
    const group = isOfficer(rankKey) ? "officer" : "enlisted";
    bas = num(payTables?.BAS?.[group]);
    if (!bas) missing.push("bas");
  } catch (_) {
    missing.push("bas");
  }

  // --- BAH (ZIP lookup) ---
  let bah = null;
  let bahMeta = null;

  try {
    const bahZip = payTables?.BAH_TX?.[zip5]; // your dataset key
    if (!bahZip) {
      missing.push("bah_zip_not_found");
    } else {
      const depKey = family ? "with" : "without";
      const byRank = bahZip?.[depKey] || {};
      bah = num(byRank?.[rankKey]);
      bahMeta = {
        zip: zip5,
        location: bahZip.location || bahZip.base || null,
        dependents: family ? "with" : "without",
        verified: !!bahZip.verified
      };
      if (!bah) missing.push("bah_rank_not_found");
    }
  } catch (_) {
    missing.push("bah");
  }

  // total = sum of what we have (missing ones treated as 0)
  const totalPay = num(basePay) + num(bas) + num(bah);

  return {
    basePay: num(basePay),
    bas: num(bas),
    bah: num(bah),
    totalPay,
    bahMeta,
    missing,
    complete: missing.length === 0
  };
}

// ============================================================
// //#4 – Supabase Profile Lookup
// ============================================================
async function fetchProfileByEmail(email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars." };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (error) return { ok: false, error: error.message || "Supabase error." };
  if (!data) return { ok: false, error: "No profile found for this email." };

  return { ok: true, profile: data };
}

// ============================================================
// //#5 – Handler
// ============================================================
exports.handler = async function handler(event) {
  // OPTIONS preflight (critical for Webflow → Netlify calls)
  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }

  const email = String(body.email || "").trim().toLowerCase();
  const cityKey = String(body.cityKey || "SanAntonio").trim();
  const bedrooms = Number(body.bedrooms || 4);

  if (!email) {
    return respond(400, { ok: false, error: "Missing email." });
  }

  try {
    // 1) Profile
    const profRes = await fetchProfileByEmail(email);
    if (!profRes.ok) {
      return respond(200, {
        ok: false,
        error: "Profile lookup failed.",
        profile_error: profRes.error,
        debug: { email, cityKey, bedrooms }
      });
    }

    const p = profRes.profile || {};

    // normalize expected fields (works even if your column names vary)
    const rankPaygrade =
      p.rank_paygrade ||
      p.rank ||
      p.rankPaygrade ||
      p.rank_pay_grade ||
      "";

    const yos =
      p.yos ??
      p.years_of_service ??
      p.yearsOfService ??
      p.years_service ??
      0;

    const zip =
      p.zip ||
      p.zipcode ||
      p.postal_code ||
      p.postal ||
      "";

    const family =
      toBool(p.family ?? p.has_dependents ?? p.dependents ?? p.with_dependents);

    // 2) Pay compute
    const payTables = loadPayTables();
    const pay = computePay({
      payTables,
      rankPaygrade,
      yos,
      zip,
      family
    });

    // 3) City JSON
    const city = loadCity(cityKey);
    const market = city?.market || city?.targets || city?.meta?.market || {};

    // done
    return respond(200, {
      ok: true,
      email,
      inputs: { cityKey, bedrooms },
      profile: {
        // keep it compact but useful
        email: p.email || email,
        full_name: p.full_name || p.name || null,
        rank_paygrade: rankPaygrade || null,
        yos: num(yos),
        zip: cleanZip(zip) || null,
        family
      },
      pay,
      city: {
        key: cityKey,
        market,
        raw: city || null
      }
    });
  } catch (e) {
    // Always return CORS headers even on crash
    return respond(200, {
      ok: false,
      error: "Brain exception.",
      detail: String(e && (e.message || e) || "Unknown error")
    });
  }
};

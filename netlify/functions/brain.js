// netlify/functions/brain.js
//
// CENTRAL BRAIN — v1.0 (Webflow + Netlify)
// What it does (single call):
// 1) Receives { email, cityKey, bedrooms } from the UI
// 2) Pulls the user's profile from Supabase (by email)
// 3) Loads military pay tables (local JSON)
// 4) Loads city JSON (local JSON)
// 5) Computes: Base Pay, BAH, BAS, Total Pay + returns city market/targets
//
// IMPORTANT:
// - CommonJS only (NO fileURLToPath / import.meta.url)
// - Robust file loading using __dirname (avoids your prior path crash)
// - CORS handled for Webflow preview domains
//
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

// ==============================
// //#1 CORS (match your site usage)
// ==============================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  };
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ==============================
// //#2 Helpers: Safe file loading
// Uses __dirname so it works in Netlify runtime bundling
// ==============================
function readJsonFile(absPath) {
  if (!absPath || typeof absPath !== "string") {
    throw new Error(`Invalid path passed to readJsonFile(): ${String(absPath)}`);
  }
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, "utf8");
  const j = safeJsonParse(raw);
  if (!j) throw new Error(`Invalid JSON: ${absPath}`);
  return j;
}

function loadPayTables() {
  // Your repo shows: netlify/functions/data/militaryPayTables.json
  // In Netlify runtime, this function file's __dirname is the deployed function folder.
  // So "data/..." must be alongside brain.js at deploy time.
  const abs = path.join(__dirname, "data", "militaryPayTables.json");
  return readJsonFile(abs);
}

function normalizeCityKey(cityKey) {
  const k = String(cityKey || "").trim();
  // block path traversal + weird chars
  if (!/^[A-Za-z0-9\-]+$/.test(k)) return "";
  return k;
}

function loadCity(cityKey) {
  const key = normalizeCityKey(cityKey);
  if (!key) throw new Error("Invalid cityKey.");
  const abs = path.join(__dirname, "cities", `${key}.json`);
  return readJsonFile(abs);
}

// ==============================
// //#3 Helpers: Pay computation
// ==============================
function rankGroup(rankPaygrade) {
  const r = String(rankPaygrade || "").toUpperCase();
  if (r.startsWith("O")) return "officer";
  if (r.startsWith("W")) return "officer"; // treat warrants as officer for BAS
  if (r.startsWith("E")) return "enlisted";
  return "enlisted";
}

function normalizeZip(zip) {
  const z = String(zip || "").trim();
  if (!z) return "";
  const digits = z.replace(/\D/g, "");
  if (!digits) return "";
  return digits.padStart(5, "0").slice(0, 5);
}

function normalizeYos(yos) {
  const n = Number(yos);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function lookupBasePay(BASEPAY, rank, yos) {
  if (!BASEPAY || !rank || yos == null) return null;
  const table = BASEPAY[rank];
  if (!table) return null;

  // Most tables store YOS as keys like "0","1","2",...
  const keyExact = String(yos);
  if (table[keyExact] != null) return Number(table[keyExact]);

  // Fallback: choose the highest key <= yos
  const keys = Object.keys(table)
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return null;

  let pick = keys[0];
  for (const k of keys) {
    if (k <= yos) pick = k;
  }
  return Number(table[String(pick)]);
}

function lookupBah(BAH_TX, zip, rank, family) {
  if (!BAH_TX || !zip || !rank) return null;
  const row = BAH_TX[zip] || BAH_TX[String(zip)] || null;
  if (!row) return null;

  // Your stored schema (from memory): { with: {RANK: bah}, without: {RANK: bah} }
  const bucket = family ? row.with : row.without;
  if (!bucket) return null;
  const v = bucket[rank];
  if (v == null) return null;
  return Number(v);
}

function lookupBas(BAS, rank) {
  if (!BAS || !rank) return null;
  const grp = rankGroup(rank);
  const v = BAS[grp];
  if (v == null) return null;
  return Number(v);
}

function pickCityMarket(cityJson) {
  // Make this resilient to your city.json shape
  const c = cityJson || {};
  return (
    c.market ||
    (c.housing && c.housing.market) ||
    (c.housingMarket) ||
    (c.data && c.data.market) ||
    {}
  );
}

function pickCityTargets(cityJson) {
  const c = cityJson || {};
  return (
    c.targets ||
    (c.housing && c.housing.targets) ||
    (c.data && c.data.targets) ||
    {}
  );
}

// ==============================
// //#4 Supabase: fetch profile
// ==============================
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY; // service role key
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizeProfile(p) {
  const prof = p || {};

  const rank =
    prof.rank_paygrade ||
    prof.rank ||
    prof.paygrade ||
    prof.rankPaygrade ||
    "";

  const yos =
    prof.yos ??
    prof.years_of_service ??
    prof.yearsOfService ??
    null;

  const zip =
    prof.zip ||
    prof.base_zip ||
    prof.baseZip ||
    "";

  // family can be boolean or a string
  const famRaw =
    prof.family ??
    prof.has_dependents ??
    prof.dependents ??
    prof.with_dependents ??
    false;

  const family =
    famRaw === true ||
    String(famRaw).toLowerCase() === "true" ||
    String(famRaw).toLowerCase() === "yes" ||
    String(famRaw).toLowerCase() === "with";

  return {
    email: prof.email || "",
    rank_paygrade: String(rank || "").toUpperCase(),
    yos: normalizeYos(yos),
    zip: normalizeZip(zip),
    family,
    // keep originals for debugging if needed
    _raw: prof,
  };
}

// ==============================
// //#5 Main handler
// ==============================
exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return respond(200, { ok: true });
    }

    if (event.httpMethod !== "POST") {
      // So opening /api/brain in a browser doesn't crash
      return respond(200, {
        ok: true,
        note: "POST JSON to this endpoint: { email, cityKey, bedrooms }",
      });
    }

    const body = safeJsonParse(event.body || "") || {};
    const email = String(body.email || "").trim().toLowerCase();
    const cityKey = String(body.cityKey || "SanAntonio").trim();
    const bedrooms = Number(body.bedrooms || 4);

    if (!email) return respond(400, { ok: false, error: "Missing email." });

    // 1) Supabase profile lookup
    const supabase = getSupabase();
    const { data: profileRow, error: profileErr } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (profileErr) {
      return respond(500, { ok: false, error: "Supabase error.", detail: profileErr.message });
    }
    if (!profileRow) {
      return respond(404, { ok: false, error: "Profile not found for this email." });
    }

    const profile = normalizeProfile(profileRow);

    // 2) Load pay tables + city JSON
    const payTables = loadPayTables();
    const cityJson = loadCity(cityKey);

    // 3) Compute pay
    const missing = [];
    if (!profile.rank_paygrade) missing.push("rank_paygrade");
    if (profile.yos == null) missing.push("yos");
    if (!profile.zip) missing.push("zip");

    const BASEPAY = payTables.BASEPAY || null;
    const BAS = payTables.BAS || null;
    const BAH_TX = payTables.BAH_TX || null;

    const basePay = lookupBasePay(BASEPAY, profile.rank_paygrade, profile.yos);
    const bas = lookupBas(BAS, profile.rank_paygrade);

    // BAH is ZIP-based — if ZIP missing or not in table, will return null
    const bah = lookupBah(BAH_TX, profile.zip, profile.rank_paygrade, profile.family);

    const pay = {
      basePay: Number.isFinite(basePay) ? basePay : null,
      bah: Number.isFinite(bah) ? bah : null,
      bas: Number.isFinite(bas) ? bas : null,
      totalPay:
        (Number.isFinite(basePay) ? basePay : 0) +
        (Number.isFinite(bah) ? bah : 0) +
        (Number.isFinite(bas) ? bas : 0),
    };

    // 4) City outputs
    const market = pickCityMarket(cityJson);
    const targets = pickCityTargets(cityJson);

    return respond(200, {
      ok: true,
      email,
      profile: {
        email: profile.email,
        rank_paygrade: profile.rank_paygrade,
        yos: profile.yos,
        zip: profile.zip,
        family: profile.family,
      },
      pay,
      city: {
        key: cityKey,
        bedrooms: Number.isFinite(bedrooms) ? bedrooms : 4,
        market,
        targets,
        // keep raw if you want to inspect quickly
        _raw: cityJson,
      },
      missing,
    });
  } catch (e) {
    return respond(500, {
      ok: false,
      error: String(e && e.message ? e.message : e),
    });
  }
};

// netlify/functions/brain.js
// =========================================================
// OrozcoRealty • CENTRAL BRAIN (v1.1 TEST)
// ONE call → Supabase profile → militaryPayTables.json → city.json
//
// Returns (what you requested):
//  - Base Pay (monthly)
//  - BAS (monthly)
//  - BAH (monthly) (by ZIP; can fallback to city default ZIP if present)
//  - Total Pay = Base + BAS + BAH
//  - City housing market averages (best-effort from city.json)
//  - PCS Snapshot-friendly payload
//
// ENV REQUIRED:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// FILES REQUIRED:
//   netlify/functions/data/militaryPayTables.json
//   netlify/functions/cities/<CityKey>.json   (ex: SanAntonio.json)
//
// Notes:
// - This is intentionally defensive. If city.json keys differ, it returns 0 + notes.
// - Once we confirm your city.json structure, we’ll tighten extraction to be exact.
// =========================================================

import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function json(body, statusCode = 200) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function safeParseJSON(str) {
  try { return JSON.parse(str || "{}"); } catch { return null; }
}

function num(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

function toZip5(z) {
  const s = String(z || "").trim();
  const m = s.match(/^(\d{5})/);
  return m ? m[1] : "";
}

function normalizePaygrade(v) {
  // accepts "E-6", "E6", "e6", "O3", etc → "E-6"
  const s = String(v || "").trim().toUpperCase();
  const m = s.match(/^([EO])\s*[-]?\s*(\d{1,2})$/);
  if (!m) return "";
  return `${m[1]}-${Number(m[2])}`;
}

function isOfficer(paygrade) {
  return /^O-\d+$/i.test(paygrade);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readJSON(relPath) {
  const abs = path.join(__dirname, relPath);
  const raw = await fs.readFile(abs, "utf8");
  return JSON.parse(raw);
}

// =========================================================
// //#3 — Supabase profile lookup (by email)
// =========================================================
async function loadProfileByEmail(email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY" };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });

  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("email", email)
    .limit(1);

  if (error) return { ok: false, error: error.message };
  if (!data || !data.length) return { ok: false, error: "No profile found for email" };

  return { ok: true, profile: data[0] };
}

// =========================================================
// //#4 — City JSON helpers (best-effort market extraction)
// =========================================================
function getByPath(obj, pathStr) {
  try {
    return pathStr.split(".").reduce((acc, k) => (acc && acc[k] != null ? acc[k] : null), obj);
  } catch { return null; }
}

function firstNumberFromPaths(obj, paths) {
  for (const p of paths) {
    const v = getByPath(obj, p);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function firstStringFromPaths(obj, paths) {
  for (const p of paths) {
    const v = getByPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function inferCityDefaultZip(cityJson) {
  // tries common patterns: city.defaultZip, city.zip, city.zips[0], city.meta.zip, etc.
  const candidate =
    firstStringFromPaths(cityJson, [
      "defaultZip",
      "zip",
      "zipcode",
      "bahZip",
      "meta.zip",
      "meta.defaultZip"
    ]) ||
    (Array.isArray(cityJson?.zips) && cityJson.zips.length ? String(cityJson.zips[0]) : "") ||
    (Array.isArray(cityJson?.zipCodes) && cityJson.zipCodes.length ? String(cityJson.zipCodes[0]) : "") ||
    "";

  return toZip5(candidate);
}

function extractCityMarket(cityJson) {
  // We don’t know your exact city.json schema yet, so we search common keys.
  // Once you confirm your schema, we’ll lock to the correct keys.
  const notes = [];
  if (!cityJson || typeof cityJson !== "object") {
    return {
      ok: false,
      cityName: "",
      state: "",
      avgHomePrice: 0,
      medianHomePrice: 0,
      avgRent: 0,
      medianRent: 0,
      notes: ["city_json_missing"]
    };
  }

  const cityName = firstStringFromPaths(cityJson, ["city", "name", "meta.city", "meta.name"]);
  const state = firstStringFromPaths(cityJson, ["state", "meta.state"]);

  const avgHomePrice = firstNumberFromPaths(cityJson, [
    "housing.avg_home_price",
    "housing.average_home_price",
    "market.avg_home_price",
    "market.average_home_price",
    "zillow.avg_home_price",
    "zillow.average_home_price",
    "avg_home_price",
    "average_home_price"
  ]);

  const medianHomePrice = firstNumberFromPaths(cityJson, [
    "housing.median_home_price",
    "housing.median_home_value",
    "market.median_home_price",
    "market.median_home_value",
    "zillow.median_home_price",
    "zillow.median_home_value",
    "median_home_price",
    "median_home_value"
  ]);

  const avgRent = firstNumberFromPaths(cityJson, [
    "housing.avg_rent",
    "housing.average_rent",
    "market.avg_rent",
    "market.average_rent",
    "zillow.avg_rent",
    "zillow.average_rent",
    "avg_rent",
    "average_rent"
  ]);

  const medianRent = firstNumberFromPaths(cityJson, [
    "housing.median_rent",
    "market.median_rent",
    "zillow.median_rent",
    "median_rent"
  ]);

  if (!avgHomePrice) notes.push("avgHomePrice_not_found");
  if (!medianHomePrice) notes.push("medianHomePrice_not_found");
  if (!avgRent) notes.push("avgRent_not_found");
  if (!medianRent) notes.push("medianRent_not_found");

  return {
    ok: true,
    cityName,
    state,
    avgHomePrice,
    medianHomePrice,
    avgRent,
    medianRent,
    notes
  };
}

function extractCityTargets(cityJson, bedrooms = 4) {
  const b = Math.max(1, Math.min(10, Number(bedrooms) || 4));
  const res = {
    city_ok: !!cityJson,
    bedrooms: b,
    targetRent: 0,
    targetHomePrice: 0,
    notes: []
  };

  if (!cityJson || typeof cityJson !== "object") {
    res.notes.push("city_json_missing");
    return res;
  }

  const rentCandidates = [
    () => cityJson?.targets?.bedrooms?.[String(b)]?.rent,
    () => cityJson?.targets?.[`rent_${b}br`],
    () => cityJson?.cityTargets?.targetRent,
    () => cityJson?.targets?.rent?.[String(b)],
    () => cityJson?.targets?.targetRent
  ];

  const homeCandidates = [
    () => cityJson?.targets?.bedrooms?.[String(b)]?.homePrice,
    () => cityJson?.targets?.[`home_${b}br`],
    () => cityJson?.cityTargets?.targetHomePrice,
    () => cityJson?.targets?.homePrice?.[String(b)],
    () => cityJson?.targets?.targetHomePrice
  ];

  const rent = rentCandidates.map(fn => fn()).find(v => Number(v) > 0);
  const home = homeCandidates.map(fn => fn()).find(v => Number(v) > 0);

  res.targetRent = num(rent, 0);
  res.targetHomePrice = num(home, 0);

  if (!res.targetRent) res.notes.push("targetRent_not_found");
  if (!res.targetHomePrice) res.notes.push("targetHomePrice_not_found");

  return res;
}

// =========================================================
// //#5 — Military pay calculations
// =========================================================
function computePay({ payTables, paygrade, yos, zip, family }) {
  const out = {
    paygrade,
    yos,
    zip,
    family: !!family,
    basePay: 0,
    bas: 0,
    bah: 0,
    totalPay: 0,
    notes: []
  };

  if (!payTables || typeof payTables !== "object") {
    out.notes.push("payTables_missing");
    return out;
  }

  const BASEPAY = payTables.BASEPAY || {};
  const BAS = payTables.BAS || {};
  const BAH_TX = payTables.BAH_TX || {};

  // Base Pay
  const baseRankTable = BASEPAY[paygrade];
  if (baseRankTable) {
    const key = String(yos);
    out.basePay = num(baseRankTable[key] ?? baseRankTable[yos], 0);
  } else {
    out.notes.push("basepay_rank_not_found");
  }

  // BAS
  const basKey = isOfficer(paygrade) ? "officer" : "enlisted";
  out.bas = num(BAS[basKey], 0);
  if (!out.bas) out.notes.push("bas_not_found");

  // BAH (ZIP required)
  const z = toZip5(zip);
  if (!z) {
    out.notes.push("zip_missing_bah_unavailable");
  } else if (!BAH_TX[z]) {
    out.notes.push("zip_not_found_in_BAH_TX");
  } else {
    const row = BAH_TX[z] || {};
    const bucket = family ? (row.with || {}) : (row.without || {});
    const bahValue = bucket[paygrade];

    if (bahValue == null) {
      out.notes.push("bah_missing_for_rank_in_zip");
      out.bah = 0;
    } else {
      out.bah = num(bahValue, 0);
    }
  }

  out.totalPay = out.basePay + out.bas + out.bah;
  return out;
}

// =========================================================
// //#6 — Handler
// =========================================================
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  const body = safeParseJSON(event.body);
  const email = String(body?.email || "").trim().toLowerCase();
  const cityKey = String(body?.cityKey || "SanAntonio").trim();
  const bedrooms = num(body?.bedrooms, 4);

  if (!email) return json({ ok: false, error: "Missing email" }, 400);

  // Load pay tables
  let payTables = null;
  try {
    payTables = await readJSON("./data/militaryPayTables.json");
  } catch (e) {
    return json({
      ok: false,
      error: "Failed reading militaryPayTables.json",
      detail: String(e?.message || e)
    }, 500);
  }

  // Load city json (optional but recommended)
  let cityJson = null;
  let cityLoadNote = null;
  try {
    cityJson = await readJSON(`./cities/${cityKey}.json`);
  } catch (e) {
    cityLoadNote = `City JSON not found for ${cityKey}: ${String(e?.message || e)}`;
  }

  // Load profile
  const profRes = await loadProfileByEmail(email);
  const profileOk = profRes.ok;
  const profile = profileOk ? profRes.profile : null;

  // Extract profile fields (multiple possible names)
  const paygrade = normalizePaygrade(
    profile?.rank_paygrade ??
    profile?.paygrade ??
    profile?.rank ??
    profile?.rankPaygrade ??
    ""
  );

  const yos = num(
    profile?.yos ??
    profile?.years_of_service ??
    profile?.yearsService ??
    profile?.yearsofservice ??
    0
  );

  const family =
    (profile?.family ?? profile?.has_dependents ?? profile?.dependents ?? false) === true ||
    String(profile?.family ?? profile?.has_dependents ?? "").toLowerCase() === "true";

  // ZIP: prefer profile zip, else try city default zip if available
  let zip = toZip5(
    profile?.zip ??
    profile?.zipcode ??
    profile?.postal ??
    profile?.bah_zip ??
    ""
  );

  if (!zip && cityJson) {
    const z2 = inferCityDefaultZip(cityJson);
    if (z2) zip = z2;
  }

  // Compute pay
  const pay = computePay({ payTables, paygrade, yos, zip, family });

  // City targets + city market
  const cityTargets = extractCityTargets(cityJson, bedrooms);
  const cityMarket = extractCityMarket(cityJson);

  // PCS Snapshot payload
  const pcsSnapshot = {
    email,
    paygrade: pay.paygrade,
    yos: pay.yos,
    zip: pay.zip,
    family: pay.family,
    basePay: pay.basePay,
    bah: pay.bah,
    bas: pay.bas,
    totalPay: pay.totalPay,
    cityKey,
    bedrooms: cityTargets.bedrooms,
    targetRent: cityTargets.targetRent,
    targetHomePrice: cityTargets.targetHomePrice,
    cityMarket: {
      cityName: cityMarket.cityName,
      state: cityMarket.state,
      avgHomePrice: cityMarket.avgHomePrice,
      medianHomePrice: cityMarket.medianHomePrice,
      avgRent: cityMarket.avgRent,
      medianRent: cityMarket.medianRent
    }
  };

  return json({
    ok: true,
    test: "brain_v1_1_pay_city_market",
    profile_ok: profileOk,
    profile_error: profileOk ? null : profRes.error,
    profile: profileOk ? {
      email: profile?.email ?? email,
      rank_paygrade: paygrade,
      yos,
      zip,
      family
    } : null,
    pay,
    city: {
      cityKey,
      city_ok: !!cityJson,
      load_note: cityLoadNote,
      targets: cityTargets,
      market: cityMarket
    },
    pcsSnapshot
  });
}

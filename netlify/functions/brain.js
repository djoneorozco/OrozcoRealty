// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.2) — Base-Derived ZIP
// - Fetch Supabase profile by email
// - Load Pay Tables (deterministic)
// - Load City/Base JSON (targets + market averages)
// - Derive ZIP from:
//     1) profile.zip (if present)
//     2) city.default_bah_zip (recommended)
// - Compute Base Pay + BAS + BAH + Total Pay
//
// POST BODY:
//   { email, cityKey, bedrooms, baseKey? }
//
// RETURNS:
//   {
//     ok: true/false,
//     input: { email, cityKey, bedrooms, baseKey },
//     profile: {...},
//     derived: { zip, zipSource, cityKeyUsed },
//     pay: { basePay, bah, bas, totalPay },
//     city: { key, market, targets, raw },
//     missing: [...]
//   }
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function normalizeKeyToFilename(key) {
  // Converts "Fort Sam Houston" -> "Fort-Sam-Houston"
  // Keeps existing hyphens, removes weird chars, collapses hyphens.
  const s = String(key || "").trim();
  const hyphened = s
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return hyphened || "";
}

function pickNearestYos(tableForRank, yos) {
  const keys = Object.keys(tableForRank || {})
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return null;

  let chosen = keys[0];
  for (const k of keys) {
    if (k <= yos) chosen = k;
  }
  return tableForRank[String(chosen)] ?? null;
}

function readJsonFromRelative(relPathFromThisFile) {
  // Robust on Netlify: resolves relative to this module file
  const abs = fileURLToPath(new URL(relPathFromThisFile, import.meta.url));
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

// -----------------------------
// //#3 Cached file loads (fast + stable)
// -----------------------------
let __PAY_TABLES_CACHE__ = null;

function loadPayTables() {
  if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;
  try {
    __PAY_TABLES_CACHE__ = readJsonFromRelative("./data/militaryPayTables.json");
    return __PAY_TABLES_CACHE__;
  } catch (e) {
    throw new Error(`militaryPayTables.json not found at netlify/functions/data/`);
  }
}

function loadCity(cityKey) {
  const key = normalizeKeyToFilename(cityKey || "");
  if (!key) throw new Error("Missing cityKey/baseKey.");

  try {
    const data = readJsonFromRelative(`./cities/${key}.json`);

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
    throw new Error(`City/Base file not found: netlify/functions/cities/${key}.json`);
  }
}

// -----------------------------
// //#4 ZIP derivation (Base → City JSON → default_bah_zip)
// -----------------------------
function deriveZip(profile, cityObj) {
  // 1) Prefer explicitly stored zip (if you ever add it later)
  const direct =
    String(profile?.zip || profile?.postal_code || profile?.postalCode || "").trim();
  if (direct) {
    return { zip: direct, zipSource: "profile.zip" };
  }

  // 2) Prefer city/base JSON mapping (recommended)
  const raw = cityObj?.raw || {};
  const z1 = String(raw?.default_bah_zip || raw?.defaultBahZip || "").trim();
  if (z1) {
    return { zip: z1, zipSource: `cities/${cityObj.key}.json:default_bah_zip` };
  }

  // Optional list
  const list =
    raw?.alt_bah_zips ||
    raw?.bah_zip_list ||
    raw?.bahZips ||
    [];
  if (Array.isArray(list) && list.length) {
    const z = String(list[0] || "").trim();
    if (z) return { zip: z, zipSource: `cities/${cityObj.key}.json:bah_zip_list[0]` };
  }

  return { zip: "", zipSource: "none" };
}

// -----------------------------
// //#5 Deterministic pay math (ZIP now passed in)
// -----------------------------
function computePay(profile, payTables, zip) {
  const missing = [];

  const rank = normalizeRank(profile?.rank_paygrade || profile?.rank || "");
  const yos = toInt(profile?.yos ?? profile?.years_of_service ?? profile?.yearsOfService);
  const family = Boolean(profile?.family ?? profile?.dependents ?? profile?.has_dependents);

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
  if (!zip) {
    missing.push("zip");
  } else {
    // Current dataset uses BAH_TX (you can add BAH_NV, BAH_CA, etc later)
    const bahZip =
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
  }

  const totalPay = basePay + bas + bah;

  return {
    ok: missing.length === 0 && totalPay > 0,
    missing,
    pay: { basePay, bah, bas, totalPay },
  };
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
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    // Simple GET sanity check
    if (event.httpMethod === "GET") {
      return respond(200, {
        ok: true,
        note: "POST JSON to this endpoint: { email, cityKey, bedrooms, baseKey? }",
      });
    }

    if (event.httpMethod !== "POST") {
      return respond(405, { ok: false, error: "Method not allowed." });
    }

    const body = JSON.parse(event.body || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const bedrooms = toInt(body.bedrooms) ?? 4;

    // baseKey lets you override profile.base during testing if you want
    const baseKey = String(body.baseKey || "").trim();

    if (!email) return respond(400, { ok: false, error: "Missing email." });

    // Profile first (so we can default cityKey to profile.base if needed)
    const profile = await fetchProfileByEmail(email);

    // City selection priority:
    // 1) body.cityKey (explicit)
    // 2) body.baseKey (explicit base)
    // 3) profile.base
    // 4) "SanAntonio" fallback
    const cityKeyRaw =
      String(body.cityKey || "").trim() ||
      baseKey ||
      String(profile?.base || "").trim() ||
      "SanAntonio";

    const city = loadCity(cityKeyRaw);

    // Tables
    const payTables = loadPayTables();

    // Derive ZIP (from profile.zip OR city JSON mapping)
    const { zip, zipSource } = deriveZip(profile, city);

    // Compute pay
    const computed = computePay(profile, payTables, zip);

    return respond(200, {
      ok: computed.ok,
      input: { email, cityKey: cityKeyRaw, bedrooms, baseKey: baseKey || null },
      profile,
      derived: { zip: zip || null, zipSource, cityKeyUsed: city.key },
      pay: computed.pay,
      city,
      missing: computed.missing,
    });
  } catch (e) {
    return respond(500, { ok: false, error: String(e?.message || e) });
  }
}

// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.2) — Crash-proof file loading + CORS-safe
// - Fetch Supabase profile by email
// - Compute Base Pay + BAS + BAH + Total Pay (deterministic)
// - Load city JSON (targets + market averages)
// - Designed to be safe in Netlify's bundling/runtime
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
import path from "node:path";

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

// -----------------------------
// //#3 File loading (Netlify-safe)
// -----------------------------
// In Netlify Functions, process.cwd() is typically /var/task
// Your repo paths are: netlify/functions/data/* and netlify/functions/cities/*
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

  const out = { key, market, targets, raw: data };
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

  // ZIP may be missing now — we can derive it from profile.base using payTables.BAH.by_base
  const zipRaw = String(profile?.zip || profile?.postal_code || "").trim();

  const famRaw = profile?.family ?? profile?.dependents ?? profile?.has_dependents;
  const family = famRaw === true || String(famRaw).toLowerCase() === "true";

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

  // -----------------------------
  // //#4.1 BAH (derive ZIP from base when zip missing)
  // New preferred structure (your updated militaryPayTables.json):
  //   payTables.BAH.by_base[baseKey].preferred_zip
  //   payTables.BAH.by_zip[zip].with/without[rank]
  //
  // Legacy fallback:
  //   payTables.BAH_TX[zip]
  // -----------------------------
  let bah = 0;

  const bahRoot = payTables?.BAH || null;

  // derive baseKey from profile.base (or similar fields)
  const baseKey = safeKey(
    profile?.base ||
    profile?.duty_station ||
    profile?.dutyStation ||
    profile?.installation ||
    profile?.station ||
    ""
  );

  // decide which ZIP to use for BAH
  let zipForBah = zipRaw;

  if (!zipForBah) {
    const byBase = bahRoot?.by_base?.[baseKey] || null;
    const preferredZip = String(byBase?.preferred_zip || "").trim();
    if (preferredZip) {
      zipForBah = preferredZip;
    }
  }

  if (rank) {
    if (!zipForBah) {
      // we cannot compute BAH without either a zip or a base mapping to a zip
      if (!baseKey) missing.push("bah_zip_or_base_missing");
      else missing.push("bah_base_zip_missing");
    } else {
      // locate the BAH zip record
      const bahZip =
        bahRoot?.by_zip?.[zipForBah] ||
        payTables?.BAH_TX?.[zipForBah] ||
        bahRoot?.[zipForBah] ||
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
        note: "POST JSON to this endpoint: { email, cityKey, bedrooms }",
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

    return respond(event, 200, {
      ok: computed.ok,
      input: { email, cityKey, bedrooms },
      profile,
      pay: computed.pay,
      city,
      missing: computed.missing,
    });

  } catch (e) {
    return respond(event, 500, { ok: false, error: String(e?.message || e) });
  }
}

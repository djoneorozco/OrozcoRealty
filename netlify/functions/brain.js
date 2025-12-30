// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN (v1.2) — Netlify-safe JSON loading
// - Fetch Supabase profile by email
// - Compute Base Pay + BAS + BAH + Total Pay (deterministic)
// - Load city JSON (targets + market averages)
// - Designed for Webflow preview calling Netlify domain
//
// POST BODY: { email, cityKey, bedrooms }
//
// RETURNS:
// {
//   ok: true/false,
//   input: { email, cityKey, bedrooms },
//   profile,
//   pay: { basePay, bah, bas, totalPay },
//   city: { key, market, targets, raw },
//   missing: [...]
// }
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
// //#2 Response helper
// -----------------------------
function respond(statusCode, obj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(obj),
  };
}

// -----------------------------
// //#3 Path base (Netlify runtime-safe)
// -----------------------------
const __FNS_DIR__ = path.dirname(fileURLToPath(import.meta.url)); // .../netlify/functions

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
  const m = r.match(/^([EO]|W)\s*-?\s*(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  return r;
}

function pickNearestYos(tableForRank, yos) {
  const keys = Object.keys(tableForRank || {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return null;

  let chosen = keys[0];
  for (const k of keys) {
    if (k <= yos) chosen = k;
  }
  return tableForRank[String(chosen)] ?? null;
}

function readJsonFile(absPath) {
  if (!absPath || typeof absPath !== "string") {
    throw new Error("Internal error: invalid JSON path.");
  }
  if (!fs.existsSync(absPath)) {
    throw new Error(
      `File not found: ${absPath}. ` +
      `This usually means Netlify did not bundle your JSON. ` +
      `Fix: add [functions].included_files for netlify/functions/data/** and netlify/functions/cities/** in netlify.toml.`
    );
  }
  const raw = fs.readFileSync(absPath, "utf8");
  return JSON.parse(raw);
}

// -----------------------------
// //#4 Cached loads
// -----------------------------
let __PAY_TABLES_CACHE__ = null;

function loadPayTables() {
  if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;

  const p = path.join(__FNS_DIR__, "data", "militaryPayTables.json");
  __PAY_TABLES_CACHE__ = readJsonFile(p);
  return __PAY_TABLES_CACHE__;
}

function normalizeMarket(raw) {
  // try to standardize a few keys the UI will want
  const m = raw || {};
  const avgHomePrice =
    Number(m.avgHomePrice) ||
    Number(m.averageHomePrice) ||
    Number(m.avg_home_price) ||
    Number(m.homePriceAvg) ||
    0;

  const medianHomePrice =
    Number(m.medianHomePrice) ||
    Number(m.median_home_price) ||
    Number(m.homePriceMedian) ||
    0;

  const avgRent =
    Number(m.avgRent) ||
    Number(m.averageRent) ||
    Number(m.avg_rent) ||
    0;

  return {
    ...m,
    avgHomePrice: avgHomePrice || undefined,
    medianHomePrice: medianHomePrice || undefined,
    avgRent: avgRent || undefined,
  };
}

function loadCity(cityKey) {
  const key = safeKey(cityKey || "SanAntonio");
  const p = path.join(__FNS_DIR__, "cities", `${key}.json`);
  const data = readJsonFile(p);

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
    market: normalizeMarket(market),
    targets,
    raw: data,
  };
}

// -----------------------------
// //#5 Deterministic pay math
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

  // Base Pay
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

  // BAH (your dataset uses BAH_TX)
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
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

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

    // Load JSON assets
    const payTables = loadPayTables();
    const city = loadCity(cityKey);

    // Profile
    const profile = await fetchProfileByEmail(email);

    // Pay compute
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

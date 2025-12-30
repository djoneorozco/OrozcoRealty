// netlify/functions/brain.js
// ============================================================
// CENTRAL BRAIN — v1.0.2 (CORS + NO CRASH + PAY + CITY)
// What it does:
// 1) Reads email (from POST body OR querystring) to find user profile in Supabase.
// 2) Computes Base Pay + BAS + BAH using militaryPayTables.json
// 3) Loads city.json (e.g., cities/SanAntonio.json) to return market averages/targets.
// 4) Returns one clean JSON payload for ALL UIs to reuse.
//
// Fixes included:
// - ✅ Handles OPTIONS preflight correctly (CORS)
// - ✅ Never crashes on __filename redeclare (single ESM-safe definition)
// - ✅ Always returns CORS headers (even on errors)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ============================================================
// //#1 — CORS (always applied)
// ============================================================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Content-Type": "application/json"
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload ?? {})
  };
}

// ============================================================
// //#2 — Paths (ESM-safe __dirname)
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// //#3 — Load Pay Tables (local file)
//     File: netlify/functions/data/militaryPayTables.json
// ============================================================
function safeReadJson(absPath) {
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

const PAY_TABLES_PATH = path.resolve(__dirname, "data", "militaryPayTables.json");
const PAY = safeReadJson(PAY_TABLES_PATH);

// ============================================================
// //#4 — Helpers
// ============================================================
function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function normalizeRank(r) {
  // Accept: "E6" "E-6" "O3" "O-3" "W2" "W-2"
  const s = String(r || "").trim().toUpperCase();
  if (!s) return "";
  const m = s.match(/^([EOW])\s*-\s*(\d+)$/) || s.match(/^([EOW])\s*(\d+)$/);
  if (!m) return s;
  return `${m[1]}-${m[2]}`;
}

function isOfficer(rank) {
  const r = normalizeRank(rank);
  return r.startsWith("O-") || r.startsWith("W-");
}

function pickClosestYos(paygradeMap, yos) {
  // paygradeMap: { "0": 1234, "2": 1400, ... }
  // choose largest key <= yos, else smallest key
  const keys = Object.keys(paygradeMap || {})
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return null;

  const y = Number(yos);
  if (!Number.isFinite(y)) return String(keys[0]);

  let best = keys[0];
  for (const k of keys) {
    if (k <= y) best = k;
  }
  return String(best);
}

function computeBasePay(rank, yos) {
  if (!PAY?.BASEPAY) return { ok: false, value: 0, usedYos: null, note: "PAY.BASEPAY missing" };

  const r = normalizeRank(rank);
  const gradeMap = PAY.BASEPAY[r];
  if (!gradeMap) return { ok: false, value: 0, usedYos: null, note: `No BASEPAY table for ${r}` };

  const usedYos = pickClosestYos(gradeMap, yos);
  const val = usedYos != null ? toNum(gradeMap[usedYos], 0) : 0;

  return { ok: val > 0, value: val, usedYos, note: val > 0 ? null : "Base pay resolved to 0" };
}

function computeBAS(rank) {
  if (!PAY?.BAS) return { ok: false, value: 0, note: "PAY.BAS missing" };
  const bas = isOfficer(rank) ? PAY.BAS.officer : PAY.BAS.enlisted;
  const v = toNum(bas, 0);
  return { ok: v > 0, value: v, note: v > 0 ? null : "BAS resolved to 0" };
}

function computeBAH(rank, zip, family) {
  if (!PAY?.BAH_TX) return { ok: false, value: 0, note: "PAY.BAH_TX missing" };

  const r = normalizeRank(rank);
  const z = String(zip || "").trim();
  if (!z) return { ok: false, value: 0, note: "Missing zip for BAH lookup" };

  const rec = PAY.BAH_TX[z];
  if (!rec) return { ok: false, value: 0, note: `No BAH record for ZIP ${z}` };

  const depKey = family ? "with" : "without";
  const table = rec?.[depKey] || {};
  let v = table?.[r];

  // If rank key doesn’t exist exactly, try to match loose (rare but safe)
  if (v == null) {
    const keys = Object.keys(table);
    const alt = keys.find(k => normalizeRank(k) === r);
    if (alt) v = table[alt];
  }

  const num = toNum(v, 0);
  return {
    ok: num > 0,
    value: num,
    meta: { location: rec.location || rec.base || null, verified: !!rec.verified, dependents: depKey },
    note: num > 0 ? null : `BAH not found for ${r} at ZIP ${z} (${depKey})`
  };
}

function cityFileFromName(name) {
  // "San Antonio" -> "SanAntonio"
  const s = String(name || "").trim();
  if (!s) return "";
  return s.replace(/[^a-zA-Z0-9]/g, "");
}

function loadCityJson(cityName) {
  const fileBase = cityFileFromName(cityName);
  if (!fileBase) return { ok: false, cityFile: null, data: null, note: "No city provided" };

  const abs = path.resolve(__dirname, "cities", `${fileBase}.json`);
  const data = safeReadJson(abs);

  if (!data) {
    return { ok: false, cityFile: `${fileBase}.json`, data: null, note: `City file not found at cities/${fileBase}.json` };
  }
  return { ok: true, cityFile: `${fileBase}.json`, data, note: null };
}

// ============================================================
// //#5 — Supabase
// ============================================================
function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchProfileByEmail(email) {
  const supa = supabaseClient();
  if (!supa) return { ok: false, profile: null, note: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY" };

  const em = String(email || "").trim().toLowerCase();
  if (!em) return { ok: false, profile: null, note: "Missing email" };

  // Adjust select fields if needed; using * for now to be resilient
  const { data, error } = await supa
    .from("profiles")
    .select("*")
    .eq("email", em)
    .maybeSingle();

  if (error) return { ok: false, profile: null, note: error.message || "Supabase error" };
  if (!data) return { ok: false, profile: null, note: `No profile found for ${em}` };

  return { ok: true, profile: data, note: null };
}

// ============================================================
// //#6 — Handler
// ============================================================
export async function handler(event) {
  try {
    // ✅ Preflight
    if (event.httpMethod === "OPTIONS") {
      return respond(200, { ok: true, preflight: true });
    }

    // Simple GET health check
    if (event.httpMethod === "GET") {
      const health = String(event.queryStringParameters?.health || "");
      if (health) {
        return respond(200, {
          ok: true,
          service: "brain",
          payTablesLoaded: !!PAY,
          payTablesPath: "netlify/functions/data/militaryPayTables.json",
          hint: "POST { email } for full compute"
        });
      }
      return respond(405, { ok: false, error: "Use POST. (Or GET with ?health=1)" });
    }

    if (event.httpMethod !== "POST") {
      return respond(405, { ok: false, error: "Method not allowed" });
    }

    if (!PAY) {
      return respond(500, {
        ok: false,
        error: "Pay tables could not be loaded",
        hint: "Confirm file exists at netlify/functions/data/militaryPayTables.json"
      });
    }

    const body = (() => {
      try { return JSON.parse(event.body || "{}"); } catch { return {}; }
    })();

    const email = body.email || event.queryStringParameters?.email || "";
    const cityFromBody = body.city || body.market || "";

    // ============================================================
    // //#6.1 — Profile
    // ============================================================
    const profRes = await fetchProfileByEmail(email);

    // If Supabase fails, return a useful debug payload (still CORS-safe)
    if (!profRes.ok) {
      return respond(200, {
        ok: false,
        error: profRes.note || "Profile fetch failed",
        inputs: { email: String(email || "").toLowerCase() },
        needs: ["profile.email must exist in public.profiles", "SUPABASE_URL + SUPABASE_SERVICE_KEY env vars"]
      });
    }

    const p = profRes.profile || {};

    // ============================================================
    // //#6.2 — Extract inputs (profile first, then body overrides)
    // ============================================================
    const rank =
      body.rank ||
      p.rank_paygrade ||
      p.rank ||
      p.paygrade ||
      "";

    const yos =
      body.yos ??
      body.years_of_service ??
      p.yos ??
      p.years_of_service ??
      p.yearsOfService ??
      0;

    const zip =
      body.zip ||
      p.zip ||
      p.base_zip ||
      p.postal_code ||
      "";

    const family =
      (body.family != null)
        ? !!body.family
        : (p.family != null ? !!p.family : true);

    // City name: body > profile.base/city > empty
    const cityName =
      cityFromBody ||
      p.city ||
      p.market ||
      p.base_city ||
      p.base ||
      "";

    // ============================================================
    // //#6.3 — Compute Pay
    // ============================================================
    const basePay = computeBasePay(rank, yos);
    const bas = computeBAS(rank);
    const bah = computeBAH(rank, zip, family);

    const totalPay = (basePay.value || 0) + (bas.value || 0) + (bah.value || 0);

    // ============================================================
    // //#6.4 — City JSON
    // ============================================================
    const cityRes = loadCityJson(cityName);

    // Best-effort common fields (won’t break if structure differs)
    const city = cityRes.data || {};
    const cityAvgHome =
      toNum(city.avg_home_price, 0) ||
      toNum(city.avgHomePrice, 0) ||
      toNum(city.median_home_price, 0) ||
      toNum(city.medianHomePrice, 0) ||
      0;

    const cityTargetRent =
      toNum(city.target_rent, 0) ||
      toNum(city.targetRent, 0) ||
      toNum(city.rent_target, 0) ||
      0;

    const cityTargetHome =
      toNum(city.target_home_price, 0) ||
      toNum(city.targetHomePrice, 0) ||
      toNum(city.home_price_target, 0) ||
      0;

    // ============================================================
    // //#6.5 — Response (single “central brain” payload)
    // ============================================================
    const warnings = [];
    if (!normalizeRank(rank)) warnings.push("Missing rank in profile (rank_paygrade / rank).");
    if (!toNum(yos, 0)) warnings.push("Missing YOS in profile (yos / years_of_service).");
    if (!String(zip || "").trim()) warnings.push("Missing ZIP in profile (zip) — BAH cannot compute.");
    if (!cityRes.ok) warnings.push(cityRes.note);

    return respond(200, {
      ok: true,
      inputs: {
        email: String(email || "").trim().toLowerCase(),
        rank: normalizeRank(rank),
        yos: toNum(yos, 0),
        zip: String(zip || "").trim(),
        family: !!family,
        cityName: String(cityName || "").trim(),
        cityFile: cityRes.cityFile || null
      },
      profile: {
        // Minimal echo (safe + useful)
        full_name: p.full_name || p.name || null,
        base: p.base || null,
        rank_paygrade: p.rank_paygrade || p.rank || null,
        yos: p.yos ?? p.years_of_service ?? null,
        zip: p.zip || null
      },
      pay: {
        basePay: basePay.value,
        basePay_usedYos: basePay.usedYos,
        bas: bas.value,
        bah: bah.value,
        bah_meta: bah.meta || null,
        totalPay
      },
      city: {
        avgHomePrice: cityAvgHome,
        targetRent: cityTargetRent,
        targetHomePrice: cityTargetHome,
        raw: cityRes.ok ? city : null
      },
      warnings,
      debug: {
        basePay_note: basePay.note || null,
        bas_note: bas.note || null,
        bah_note: bah.note || null
      }
    });
  } catch (err) {
    // ✅ Always CORS-safe even on unexpected errors
    return respond(500, {
      ok: false,
      error: err?.message || "Unknown error",
      hint: "Open Netlify function logs for stack trace"
    });
  }
}

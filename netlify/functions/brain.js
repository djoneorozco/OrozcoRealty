// netlify/functions/brain.js
// =========================================================
// OrozcoRealty • CENTRAL BRAIN (v1.0)
// - Single source of truth for: profile + pay + city facts
// - Input: { email, cityKey?, bedrooms?, family? }
// - Output: { ok, profile, pay, city, errors }
// - ESM-safe (package.json has "type":"module")
// - Handles CORS + OPTIONS (preflight) properly
// =========================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

// //#1 — CORS (must reply to OPTIONS)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj || {})
  };
}

// //#2 — File helpers (ESM-safe paths)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readJsonSafe(absPath) {
  try {
    if (!fs.existsSync(absPath)) return { ok: false, error: "not_found" };
    const raw = fs.readFileSync(absPath, "utf8");
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: "read_failed", detail: String(e?.message || e) };
  }
}

function toInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toBool(v, fallback = null) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : fallback;
  return fallback;
}

function normalizeZip(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{5})/);
  return m ? m[1] : "";
}

// //#3 — Pay table computation (militaryPayTables.json)
function isOfficerRank(rank) {
  const r = String(rank || "").toUpperCase().trim();
  return r.startsWith("O") || r.startsWith("W");
}

function findNearestYosKey(rankObj, yos) {
  // rankObj is { "0": 3000, "1": 3100, ... } etc
  const keys = Object.keys(rankObj || {})
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return null;

  const y = Number(yos);
  if (!Number.isFinite(y)) return String(keys[0]);

  // choose the greatest key <= yos, else smallest
  let best = keys[0];
  for (const k of keys) {
    if (k <= y) best = k;
    else break;
  }
  return String(best);
}

function computePay(tables, { rank, yos, zip, family }) {
  const errors = {};
  const out = {
    rank: rank || null,
    yos: yos ?? null,
    zip: zip || null,
    family: !!family,
    basePay: 0,
    bah: 0,
    bas: 0,
    totalPay: 0,
    details: {}
  };

  if (!tables) {
    errors.payTables = "missing_pay_tables";
    return { out, errors };
  }

  const r = String(rank || "").toUpperCase().trim();
  const y = toInt(yos, null);
  const z = normalizeZip(zip);
  const fam = !!family;

  // Base Pay
  try {
    const byRank = tables?.BASEPAY?.[r];
    if (!byRank) {
      errors.basePay = `rank_not_found:${r || "null"}`;
    } else {
      const yosKey = findNearestYosKey(byRank, y ?? 0);
      if (!yosKey || byRank[yosKey] == null) {
        errors.basePay = `yos_not_found:${y ?? "null"}`;
      } else {
        out.basePay = Number(byRank[yosKey]) || 0;
        out.details.basePayYosKey = yosKey;
      }
    }
  } catch (e) {
    errors.basePay = "basepay_compute_failed";
  }

  // BAS
  try {
    const group = isOfficerRank(r) ? "officer" : "enlisted";
    const basVal = tables?.BAS?.[group];
    if (basVal == null) errors.bas = `bas_missing:${group}`;
    else out.bas = Number(basVal) || 0;
    out.details.basGroup = group;
  } catch (e) {
    errors.bas = "bas_compute_failed";
  }

  // BAH (ZIP-based)
  try {
    if (!z) {
      errors.bah = "zip_missing";
    } else {
      const zipObj = tables?.BAH_TX?.[z];
      if (!zipObj) {
        errors.bah = `bah_zip_not_found:${z}`;
      } else {
        const depKey = fam ? "with" : "without";
        const bahVal = zipObj?.[depKey]?.[r];
        if (bahVal == null) {
          errors.bah = `bah_rank_not_found:${r}|${depKey}`;
        } else {
          out.bah = Number(bahVal) || 0;
          out.details.bahDepKey = depKey;
          out.details.bahLocation = zipObj?.location || zipObj?.base || null;
          out.details.bahVerified = !!zipObj?.verified;
        }
      }
    }
  } catch (e) {
    errors.bah = "bah_compute_failed";
  }

  out.totalPay = (Number(out.basePay) || 0) + (Number(out.bah) || 0) + (Number(out.bas) || 0);
  return { out, errors };
}

// //#4 — City JSON loader (netlify/functions/cities/<CityKey>.json)
function extractCityMarket(cityData) {
  // We don’t assume schema; we try common fields and fall back to null.
  const pickNumber = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const market = cityData?.market || cityData?.targets || cityData || {};
  const avgHomePrice = pickNumber(
    market.avgHomePrice,
    market.medianHomePrice,
    market.median_home_price,
    market.homePrice,
    market.targetHomePrice,
    market.target_home_price,
    cityData?.avgHomePrice,
    cityData?.medianHomePrice,
    cityData?.median_home_price
  );

  const avgRent = pickNumber(
    market.avgRent,
    market.medianRent,
    market.median_rent,
    market.targetRent,
    market.target_rent,
    cityData?.avgRent,
    cityData?.medianRent,
    cityData?.median_rent
  );

  return { avgHomePrice, avgRent };
}

// //#5 — MAIN HANDLER
export async function handler(event) {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}") || {};
  } catch (e) {
    return respond(400, { ok: false, error: "Invalid JSON body." });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const cityKey = String(body.cityKey || "SanAntonio").trim();
  const bedrooms = toInt(body.bedrooms, 4) ?? 4;
  const familyFromBody = toBool(body.family, null);

  if (!email) {
    return respond(400, { ok: false, error: "Missing email." });
  }

  // //#5.1 — Supabase profile fetch
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return respond(500, { ok: false, error: "Server misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_KEY." });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  let profile = null;
  let profileError = null;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (error) profileError = error.message || String(error);
    profile = data || null;
  } catch (e) {
    profileError = String(e?.message || e);
  }

  // //#5.2 — Load pay tables + compute pay
  const tablesPath = path.resolve(__dirname, "data", "militaryPayTables.json");
  const tablesRes = readJsonSafe(tablesPath);

  const rank =
    String(profile?.rank_paygrade || profile?.rank || body.rank || "").trim() || null;

  const yos =
    toInt(profile?.yos, null) ??
    toInt(profile?.years_of_service, null) ??
    toInt(profile?.yearsOfService, null) ??
    toInt(body.yos, null);

  const zip =
    normalizeZip(profile?.zip || profile?.zipcode || profile?.bah_zip || body.zip);

  const family =
    toBool(profile?.family, null) ??
    toBool(profile?.has_dependents, null) ??
    (familyFromBody != null ? familyFromBody : false);

  const payRes = computePay(tablesRes.ok ? tablesRes.data : null, { rank, yos, zip, family });

  // //#5.3 — Load city JSON
  const cityPath = path.resolve(__dirname, "cities", `${cityKey}.json`);
  const cityRes = readJsonSafe(cityPath);
  const cityData = cityRes.ok ? cityRes.data : null;
  const cityMarket = cityData ? extractCityMarket(cityData) : { avgHomePrice: null, avgRent: null };

  // //#5.4 — Final response
  const errors = {
    ...(profileError ? { profile: profileError } : {}),
    ...(tablesRes.ok ? {} : { payTables: tablesRes.error || "pay_tables_load_failed" }),
    ...(cityRes.ok ? {} : { city: cityRes.error || `city_load_failed:${cityKey}` }),
    ...(payRes.errors || {})
  };

  return respond(200, {
    ok: !profileError, // profile is the "core"; pay/city can still be partial
    email,
    inputs: { cityKey, bedrooms },
    profile: profile || null,
    pay: payRes.out,
    city: {
      key: cityKey,
      market: cityMarket,
      raw: cityData // keep full city json for UI fill-in
    },
    errors
  });
}

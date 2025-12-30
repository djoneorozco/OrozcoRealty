// netlify/functions/brain.js
// ============================================================
// OrozcoRealty • CENTRAL BRAIN (v1.0)
// One call → pulls profile (Supabase) + computes pay (militaryPayTables.json)
// + loads city targets (cities/<CityKey>.json) + returns a single “truth payload”
// for Snapshot / FRS / BLUF / Ask Elena to consume.
//
// Endpoint:
//   POST /api/brain   (via your netlify.toml redirect)
//
// Body (example):
// {
//   "email": "user@email.com",
//   "cityKey": "SanAntonio",
//   "overrides": {
//     "zip": "78245",
//     "family": true,
//     "creditScore": 699,
//     "expenses": 3841,
//     "housing": 2350,
//     "savings": 591,
//     "addIncome": 0,
//     "bedrooms": 4
//   },
//   "itemizedRows": [ { "name":"Groceries", "monthly": 650, "cat":"Food", "monthKey":"2025-12" } ]
// }
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ============================================================
// //#0 – CORS + helpers
// ============================================================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(obj ?? {}),
  };
}

function safeParseJSON(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, a, b) {
  n = toNum(n, a);
  return Math.max(a, Math.min(b, n));
}

function normalizeZip(z) {
  const s = String(z ?? "").trim();
  const m = s.match(/^(\d{5})/);
  return m ? m[1] : "";
}

function normalizeRank(r) {
  // Accept "E-6", "E6", "O3", "O-3" -> normalize to "E-6", "O-3"
  const s = String(r ?? "").toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([EOW])\-?(\d{1,2})$/);
  if (!m) return "";
  return `${m[1]}-${Number(m[2])}`;
}

function pickClosestYOS(mapObj, yos) {
  // pay tables often keyed by "0","1","2"... choose exact or closest lower
  if (!isObj(mapObj)) return null;
  const keys = Object.keys(mapObj)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return null;

  const y = Math.max(0, Math.floor(toNum(yos, 0)));
  let chosen = keys[0];
  for (const k of keys) {
    if (k <= y) chosen = k;
    if (k > y) break;
  }
  return mapObj[String(chosen)] ?? null;
}

// ============================================================
// //#1 – Load pay tables once (module cache)
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let PAY_TABLES = null;
let PAY_TABLES_ERR = null;

async function loadPayTablesOnce() {
  if (PAY_TABLES || PAY_TABLES_ERR) return;
  try {
    const p = path.join(__dirname, "data", "militaryPayTables.json");
    const raw = await fs.readFile(p, "utf8");
    PAY_TABLES = JSON.parse(raw);
  } catch (e) {
    PAY_TABLES_ERR = e;
  }
}

// ============================================================
// //#2 – Load city JSON with simple cache
// ============================================================
const CITY_CACHE = new Map();

function safeCityKey(cityKey) {
  const s = String(cityKey ?? "").trim();
  if (!s) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return "";
  return s;
}

async function loadCity(cityKey) {
  const key = safeCityKey(cityKey);
  if (!key) return null;

  if (CITY_CACHE.has(key)) return CITY_CACHE.get(key);

  try {
    const p = path.join(__dirname, "cities", `${key}.json`);
    const raw = await fs.readFile(p, "utf8");
    const obj = JSON.parse(raw);
    CITY_CACHE.set(key, obj);
    return obj;
  } catch {
    CITY_CACHE.set(key, null);
    return null;
  }
}

function extractCityTargets(cityObj, bedroomsDefault = 4) {
  // Tries multiple shapes safely:
  //  A) city.targets.rentByBedrooms["4"], city.targets.homePriceByBedrooms["4"]
  //  B) city.cityTargets.targetRent / targetHomePrice
  //  C) city.benchmarks.rent / homePrice
  // Returns { bedrooms, targetRent, targetHomePrice } (numbers or 0)
  const bedrooms = Math.max(1, Math.round(toNum(bedroomsDefault, 4)));

  const getPath = (o, paths) => {
    for (const p of paths) {
      let cur = o;
      let ok = true;
      for (const k of p) {
        if (!isObj(cur) && typeof cur !== "object") {
          ok = false;
          break;
        }
        cur = cur?.[k];
      }
      if (ok && cur != null) return cur;
    }
    return null;
  };

  const rentCandidate =
    getPath(cityObj, [
      ["targets", "rentByBedrooms", String(bedrooms)],
      ["targets", "rent", String(bedrooms)],
      ["cityTargets", "targetRent"],
      ["benchmarks", "targetRent"],
      ["benchmarks", "rent"],
    ]) ?? 0;

  const homeCandidate =
    getPath(cityObj, [
      ["targets", "homePriceByBedrooms", String(bedrooms)],
      ["targets", "homePrice", String(bedrooms)],
      ["cityTargets", "targetHomePrice"],
      ["benchmarks", "targetHomePrice"],
      ["benchmarks", "homePrice"],
    ]) ?? 0;

  return {
    bedrooms,
    targetRent: Math.max(0, toNum(rentCandidate, 0)),
    targetHomePrice: Math.max(0, toNum(homeCandidate, 0)),
  };
}

// ============================================================
// //#3 – Pay math (deterministic)
// PAY_TABLES structure you told me you have:
//   BASEPAY[rank][yos] = monthly
//   BAS.enlisted / BAS.officer
//   BAH_TX[zip].with[rank] or without[rank]
//   DISABILITY, DISABILITY_FULL (optional for later)
// ============================================================
function computePay({ rank, yos, zip, family }) {
  const out = {
    rank,
    yos: Math.max(0, Math.floor(toNum(yos, 0))),
    zip: normalizeZip(zip),
    family: !!family,
    basePay: 0,
    bas: 0,
    bah: 0,
    totalPay: 0,
    notes: [],
  };

  if (!PAY_TABLES) {
    out.notes.push("pay_tables_missing");
    return out;
  }

  const r = normalizeRank(rank);
  out.rank = r;

  // Base Pay
  const baseRankMap = PAY_TABLES?.BASEPAY?.[r];
  if (isObj(baseRankMap)) {
    const picked = pickClosestYOS(baseRankMap, out.yos);
    out.basePay = Math.max(0, toNum(picked, 0));
  } else {
    out.notes.push("basepay_rank_not_found");
  }

  // BAS
  const isOfficer = /^O-/.test(r);
  const isWarrant = /^W-/.test(r);
  const basKey = isOfficer || isWarrant ? "officer" : "enlisted";
  out.bas = Math.max(0, toNum(PAY_TABLES?.BAS?.[basKey], 0));

  // BAH
  if (out.zip) {
    const bahZip = PAY_TABLES?.BAH_TX?.[out.zip];
    if (isObj(bahZip)) {
      const depKey = out.family ? "with" : "without";
      const table = bahZip?.[depKey];
      if (isObj(table)) {
        out.bah = Math.max(0, toNum(table?.[r], 0));
      } else {
        out.notes.push("bah_table_missing_for_family_flag");
      }
    } else {
      out.notes.push("bah_zip_not_found");
    }
  } else {
    out.notes.push("bah_zip_missing");
  }

  out.totalPay = out.basePay + out.bas + out.bah;
  return out;
}

// ============================================================
// //#4 – Snapshot defaults + grade inputs (pure numbers)
// ============================================================
function scoreAPR(score) {
  const s = clamp(score, 300, 850);
  if (s >= 780) return 6.5;
  if (s >= 760) return 6.75;
  if (s >= 720) return 7.0;
  if (s >= 700) return 7.2;
  if (s >= 680) return 7.35;
  if (s >= 660) return 7.85;
  if (s >= 640) return 8.25;
  if (s >= 620) return 9.25;
  return 9.95;
}

function pmt(P, r, n) {
  if (!P || !n) return 0;
  if (r === 0) return P / n;
  const x = Math.pow(1 + r, n);
  return P * ((r * x) / (x - 1));
}

function buildSnapshot({ pay, profile, overrides, cityTargets }) {
  const o = isObj(overrides) ? overrides : {};

  // Income strategy:
  // - For budgeting + charts: use TOTAL COMP by default
  // - Also provide basePay separately for UI display if you want
  const addIncome = Math.max(0, toNum(o.addIncome, 0));
  const income = Math.max(0, (pay?.totalPay ?? 0) + addIncome);

  // Core user-entered knobs (can be overridden later)
  const creditScore = clamp(o.creditScore ?? profile?.credit_score ?? 720, 300, 850);
  const apr = toNum(o.apr, 0) || scoreAPR(creditScore);

  // Basic defaults (if not provided yet, keep them 0 and let UI collect)
  const expenses = Math.max(0, toNum(o.expenses ?? profile?.monthly_expenses ?? 0, 0));
  const savings = Math.max(0, toNum(o.savings ?? profile?.total_savings ?? 0, 0));

  // Savings target (your earlier model uses % of income)
  const savingsRatePct = clamp(o.savingsRatePct ?? profile?.savings_rate_pct ?? 5, 0, 40);
  const savingsTargetAmount = income * (savingsRatePct / 100);

  // Housing model: only compute if we have price + dp inputs; otherwise use override or 0.
  const price = Math.max(0, toNum(o.price ?? 0, 0));
  const dpPct = clamp(o.dpPct ?? 0, 0, 100);
  const dpAmt = Math.max(0, toNum(o.dpAmt ?? (price * (dpPct / 100)), 0));
  const termYears = Math.max(1, Math.floor(toNum(o.termYears ?? 30, 30)));
  const tihoa = Math.max(0, toNum(o.tihoa ?? 0, 0));
  const pmi = Math.max(0, toNum(o.pmi ?? 0, 0));

  let pAndI = 0;
  let housing = Math.max(0, toNum(o.housing ?? 0, 0)); // user can override all-in housing

  if (!housing && price > 0) {
    const loan = Math.max(0, price - dpAmt);
    const mRate = (apr / 100) / 12;
    const n = termYears * 12;
    pAndI = loan > 0 ? pmt(loan, mRate, n) : 0;
    housing = pAndI + tihoa + pmi;
  }

  const freePost = income - expenses - housing - savingsTargetAmount;

  return {
    // “Bridge” keys your UI already uses
    income,
    expenses,
    savings,
    housing,
    creditScore,
    apr,
    termYears,
    tihoa,
    pmi,
    pAndI,
    price,
    dpPct,
    dpAmt,
    savingsRatePct,
    savingsTargetAmount,
    freePost,

    // For clean UI display + debugging
    __basePay: toNum(pay?.basePay, 0),
    __bah: toNum(pay?.bah, 0),
    __bas: toNum(pay?.bas, 0),
    __totalPay: toNum(pay?.totalPay, 0),
    __addIncome: addIncome,

    // City Targets
    bedrooms: cityTargets?.bedrooms ?? 4,
    targetRent: toNum(cityTargets?.targetRent, 0),
    targetHomePrice: toNum(cityTargets?.targetHomePrice, 0),
  };
}

// ============================================================
// //#5 – Supabase profile lookup (by email)
// ============================================================
async function fetchProfileByEmail(email) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { ok: false, error: "missing_supabase_env" };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Keep this selection conservative; expand anytime.
  const { data, error } = await supabase
    .from("profiles")
    .select(
      [
        "email",
        "full_name",
        "rank_paygrade",
        "rank",
        "yos",
        "base",
        "zip",
        "family",
        "credit_score",
        "monthly_expenses",
        "total_savings",
        "savings_rate_pct",
      ].join(",")
    )
    .eq("email", email)
    .maybeSingle();

  if (error) return { ok: false, error: error.message || "profile_lookup_failed" };
  if (!data) return { ok: false, error: "profile_not_found" };

  return { ok: true, profile: data };
}

// ============================================================
// //#6 – Main handler
// ============================================================
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  await loadPayTablesOnce();
  if (PAY_TABLES_ERR) {
    return json(500, {
      ok: false,
      error: "failed_to_load_pay_tables",
      detail: String(PAY_TABLES_ERR?.message || PAY_TABLES_ERR),
    });
  }

  const body = safeParseJSON(event.body || "{}", {});
  const email = String(body?.email || "").trim().toLowerCase();

  if (!email) return json(400, { ok: false, error: "email_required" });

  // 1) Profile
  const profRes = await fetchProfileByEmail(email);
  const profile = profRes.ok ? profRes.profile : null;

  // 2) Resolve inputs (profile + overrides)
  const overrides = isObj(body?.overrides) ? body.overrides : {};
  const rank = normalizeRank(overrides?.rank ?? profile?.rank_paygrade ?? profile?.rank ?? "");
  const yos = Math.max(0, Math.floor(toNum(overrides?.yos ?? profile?.yos ?? 0, 0)));
  const zip = normalizeZip(overrides?.zip ?? profile?.zip ?? "");
  const family = !!(overrides?.family ?? profile?.family ?? true);

  // 3) Pay compute
  const pay = computePay({ rank, yos, zip, family });

  // 4) City load + targets
  // Prefer explicit cityKey; otherwise try profile.base as a key; else none
  const cityKey = safeCityKey(body?.cityKey) || safeCityKey(profile?.base) || "";
  const cityObj = cityKey ? await loadCity(cityKey) : null;

  const bedrooms = Math.max(1, Math.round(toNum(overrides?.bedrooms ?? 4, 4)));
  const cityTargets = cityObj ? extractCityTargets(cityObj, bedrooms) : { bedrooms, targetRent: 0, targetHomePrice: 0 };

  // 5) Snapshot (the “bridge” payload your UI expects)
  const snapshot = buildSnapshot({ pay, profile, overrides, cityTargets });

  // 6) Optional itemizedRows passthrough (so bars can stack monthly)
  const itemizedRows = Array.isArray(body?.itemizedRows) ? body.itemizedRows : [];

  // 7) Response (single source of truth)
  return json(200, {
    ok: true,

    // profile status (don’t block the UI if missing)
    profile_ok: !!profile,
    profile_error: profRes.ok ? null : profRes.error,

    // resolved identity inputs (what the brain actually used)
    used: {
      email,
      rank: pay.rank,
      yos: pay.yos,
      zip: pay.zip,
      family: pay.family,
      cityKey: cityKey || null,
      bedrooms: snapshot.bedrooms,
    },

    pay,
    cityTargets,
    snapshot,

    // This is the exact shape your existing Snapshot UI already understands:
    // (you can store this into localStorage as `realtysass.bridge`)
    bridge: {
      ...snapshot,
      itemizedRows,
      // keep compatibility with earlier field names you used:
      targetRent: snapshot.targetRent,
      targetHomePrice: snapshot.targetHomePrice,
      bedrooms: snapshot.bedrooms,
    },
  });
};

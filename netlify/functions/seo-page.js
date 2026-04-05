// netlify/functions/seo-page.js
// ============================================================
// OrozcoRealty / PCSUnited PUBLIC SEO ENGINE
// v1.0.1-cjs
//
// GOAL
// - Public affordability endpoint for SEO pages and ads
// - NO login required
// - NO Supabase profile lookup
// - Supports San Antonio and McAllen first
// - Uses direct body inputs
// - Can optionally compute military income from rank + yos
// - Calls existing mortgage.js for payment math
//
// WHY THIS EXISTS
// - brain.js stays private/profile-driven
// - seo-page.js is public/indexable/lead-gen friendly
//
// POST JSON EXAMPLES
//
// Civilian / public buyer:
// {
//   "cityKey": "SanAntonio",
//   "monthlyIncome": 8500,
//   "price": 350000,
//   "down": 20000,
//   "creditScore": 700,
//   "termYears": 30,
//   "loanType": "conventional"
// }
//
// Military buyer:
// {
//   "cityKey": "SanAntonio",
//   "rank": "E6",
//   "yos": 10,
//   "family": true,
//   "price": 350000,
//   "down": 0,
//   "creditScore": 680,
//   "termYears": 30,
//   "loanType": "va"
// }
// ============================================================

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { handler: mortgageHandler } = require("./mortgage.js");

const SCHEMA_VERSION = "1.0.1";

const __RUNTIME_DIR = __dirname;
const __ROOT = process.cwd();

const __PAY_TABLES_PATHS = [
  path.join(__RUNTIME_DIR, "militaryPayTables.json"),
  path.join(__RUNTIME_DIR, "data", "militaryPayTables.json"),
  path.join(__ROOT, "netlify", "functions", "militaryPayTables.json"),
  path.join(__ROOT, "netlify", "functions", "data", "militaryPayTables.json"),
];

const __CITY_DIR_CANDIDATES = [
  path.join(__RUNTIME_DIR, "cities"),
  path.join(__ROOT, "netlify", "functions", "cities"),
  path.join(__ROOT, "cities"),
];

const ALLOWED_ORIGINS = new Set([
  "https://theorozcorealty.com",
  "https://www.theorozcorealty.com",
  "https://theorozcorealty.netlify.app",
  "https://luxury-re.webflow.io",
  "https://new-real-estate-purchase.webflow.io",
  "https://pcsunited.com",
  "https://www.pcsunited.com",
  "https://pcs-united.webflow.io",
  "https://pcsu.webflow.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8888",
  "http://127.0.0.1:8888"
]);

const SUPPORTED_CITIES = {
  sanantonio: "SanAntonio",
  "san antonio": "SanAntonio",
  san_antonio: "SanAntonio",
  "san-antonio": "SanAntonio",
  satx: "SanAntonio",
  sa: "SanAntonio",

  mcallen: "McAllen",
  "mc allen": "McAllen",
  mc_allen: "McAllen",
  "mc-allen": "McAllen",
  rgv: "McAllen"
};

let __PAY_TABLES_CACHE__ = null;
const __CITY_CACHE__ = new Map();

// ------------------------------------------------------------
// //#1) CORS / RESPONSE
// ------------------------------------------------------------
function buildCorsHeaders(event) {
  const origin =
    event?.headers?.origin ||
    event?.headers?.Origin ||
    "";

  const allowOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://theorozcorealty.com";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json"
  };
}

function respond(event, statusCode, obj) {
  return {
    statusCode,
    headers: buildCorsHeaders(event),
    body: JSON.stringify(obj)
  };
}

// ------------------------------------------------------------
// //#2) SMALL HELPERS
// ------------------------------------------------------------
function str(v) {
  return String(v == null ? "" : v).trim();
}

function lower(v) {
  return str(v).toLowerCase();
}

function safeKey(v) {
  return str(v).replace(/[^a-zA-Z0-9_-]/g, "");
}

function toNum(v) {
  const n = Number(str(v));
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) ? n : null;
}

function boolish(v, fallback = false) {
  if (typeof v === "boolean") return v;
  const x = lower(v);
  if (!x) return !!fallback;
  return ["1", "true", "yes", "y", "with", "family"].includes(x);
}

function positive(v, fallback = null) {
  const n = toNum(v);
  return n != null && n > 0 ? n : fallback;
}

function nonNegative(v, fallback = null) {
  const n = toNum(v);
  return n != null && n >= 0 ? n : fallback;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function normalizeRank(rank) {
  const r = String(rank || "").trim().toUpperCase();
  const m = r.match(/^([EO]|W)\s*-?\s*(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  return r;
}

function parseJsonFile(filePath, label) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} JSON parse failed at ${filePath}: ${String(e?.message || e)}`);
  }
}

function avg(nums) {
  const vals = nums.filter((n) => Number.isFinite(n) && n > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function findExistingPath(paths) {
  for (const p of paths || []) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

// ------------------------------------------------------------
// //#3) CITY RESOLUTION
// ------------------------------------------------------------
function resolveCityKey(input) {
  const raw = lower(input);

  if (!raw) return null;
  if (SUPPORTED_CITIES[raw]) return SUPPORTED_CITIES[raw];

  const compact = raw.replace(/[^a-z]/g, "");
  if (SUPPORTED_CITIES[compact]) return SUPPORTED_CITIES[compact];

  return null;
}

function loadCity(cityInput) {
  const canonical = resolveCityKey(cityInput);
  if (!canonical) {
    throw new Error("Unsupported city. Supported cities right now: SanAntonio, McAllen.");
  }

  if (__CITY_CACHE__.has(canonical)) {
    return __CITY_CACHE__.get(canonical);
  }

  const candidateFiles = __CITY_DIR_CANDIDATES.map((dir) =>
    path.join(dir, `${canonical}.json`)
  );

  const filePath = findExistingPath(candidateFiles);

  if (!filePath) {
    throw new Error(
      `City JSON not found for ${canonical}. Tried: ${candidateFiles.join(" | ")}`
    );
  }

  const data = parseJsonFile(filePath, `city:${canonical}`);

  const marketRaw = data.market || data?.housing?.market || data?.realEstate?.market || {};
  const targets = data.targets || data?.housing?.targets || data?.realEstate?.targets || {};

  const zillowAvg = toNum(marketRaw?.zillow_average_home_value);
  const medianSale = toNum(marketRaw?.median_sale_price_current);
  const medianList = toNum(marketRaw?.median_listing_price_realtor);
  const ownerOccMedian = toNum(data?.housing?.median_value_owner_occupied);

  const avgHome =
    zillowAvg ??
    medianSale ??
    medianList ??
    ownerOccMedian ??
    toNum(data?.avg_home_value ?? data?.average_home_value ?? data?.avgHome ?? data?.city_avg_home) ??
    null;

  const bedrooms =
    (data?.bedrooms && typeof data.bedrooms === "object" ? data.bedrooms : null) ||
    (data?.by_bedroom && typeof data.by_bedroom === "object" ? data.by_bedroom : null) ||
    (data?.byBedroom && typeof data.byBedroom === "object" ? data.byBedroom : null) ||
    null;

  const city = {
    ...data,
    key: canonical,
    canonical_city_key: canonical,
    market: {
      ...marketRaw,
      avg_home_value: avgHome
    },
    targets,
    bedrooms,
    avg_home_value: avgHome,
    average_home_value: avgHome,
    avgHome: avgHome,
    city_avg_home: avgHome,
    zip: str(data?.zip || data?.postal_code || ""),
    raw: data,
    _debug_file_path: filePath
  };

  __CITY_CACHE__.set(canonical, city);
  return city;
}

// ------------------------------------------------------------
// //#4) PAY TABLE LOADING (OPTIONAL FOR MILITARY MODE)
// ------------------------------------------------------------
function loadPayTables() {
  if (__PAY_TABLES_CACHE__) return __PAY_TABLES_CACHE__;

  const found = findExistingPath(__PAY_TABLES_PATHS);

  if (!found) {
    throw new Error(
      `militaryPayTables.json not found. Tried: ${__PAY_TABLES_PATHS.join(" | ")}`
    );
  }

  __PAY_TABLES_CACHE__ = parseJsonFile(found, "militaryPayTables");
  return __PAY_TABLES_CACHE__;
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

function computeBasePay(rank, yos, payTables) {
  const table = payTables?.BASEPAY?.[rank];
  if (!table) return 0;
  const picked = pickNearestYos(table, yos);
  return Number(picked) || 0;
}

function computeBAS(rank, payTables) {
  const isOfficer = /^O-/.test(rank);
  const basObj = payTables?.BAS || {};
  return Number(isOfficer ? basObj.officer : basObj.enlisted) || 0;
}

function computeBAH(rank, familyBool, zip, payTables) {
  if (!zip || !rank) return 0;

  const bahZip = payTables?.BAH?.by_zip?.[zip] || null;
  if (!bahZip) return 0;

  const bucket = familyBool ? bahZip.with : bahZip.without;
  if (!bucket) return 0;

  return Number(bucket?.[rank]) || 0;
}

function resolveMilitaryIncome(body, city) {
  const rank = normalizeRank(pickFirst(body, ["rank", "rank_paygrade", "rankPaygrade"]));
  const yos = toInt(pickFirst(body, ["yos", "years_of_service", "yearsOfService"]));
  const familyBool = boolish(pickFirst(body, ["family", "dependents", "has_dependents"]), true);

  if (!rank || yos == null) {
    return {
      ok: false,
      monthlyIncome: 0,
      source: "missing_rank_or_yos",
      pay: null
    };
  }

  const payTables = loadPayTables();
  const zip = str(city?.zip || "");

  const basePay = computeBasePay(rank, yos, payTables);
  const bas = computeBAS(rank, payTables);
  const bah = computeBAH(rank, familyBool, zip, payTables);
  const total = basePay + bas + bah;

  return {
    ok: total > 0,
    monthlyIncome: total,
    source: "military_pay_tables",
    pay: {
      rankUsed: rank,
      yosUsed: yos,
      familyUsed: familyBool,
      zipUsed: zip || null,
      basePay,
      bas,
      bah,
      totalPay: total,
      total
    }
  };
}

// ------------------------------------------------------------
// //#5) INCOME RESOLUTION
// ------------------------------------------------------------
function resolveIncome(body, city) {
  const monthlyIncomeDirect = positive(
    pickFirst(body, [
      "monthlyIncome",
      "monthly_income",
      "income",
      "totalMonthlyIncome",
      "total_monthly_income"
    ]),
    null
  );

  if (monthlyIncomeDirect != null) {
    return {
      ok: true,
      monthlyIncome: monthlyIncomeDirect,
      source: "body.monthlyIncome",
      pay: null
    };
  }

  const annualIncome = positive(
    pickFirst(body, [
      "annualIncome",
      "annual_income",
      "yearlyIncome",
      "yearly_income"
    ]),
    null
  );

  if (annualIncome != null) {
    return {
      ok: true,
      monthlyIncome: annualIncome / 12,
      source: "body.annualIncome",
      pay: null
    };
  }

  return resolveMilitaryIncome(body, city);
}

// ------------------------------------------------------------
// //#6) PRICE RESOLUTION
// ------------------------------------------------------------
function deriveBedroomPrice(city, bedrooms) {
  const bedsRoot = city?.bedrooms || city?.by_bedroom || city?.byBedroom || null;
  if (!bedsRoot || typeof bedsRoot !== "object") return null;

  const key = String(bedrooms || 3);
  const block = bedsRoot[key] || bedsRoot[Number(key)] || null;
  if (!block) return null;

  const homeBlock = block?.home_price ?? block?.homePrice ?? block?.price ?? block?.home_value;
  if (!homeBlock) return null;

  if (typeof homeBlock === "number") return homeBlock;

  const avgPrice = toNum(homeBlock?.avg ?? homeBlock?.value ?? homeBlock?.amount);
  if (avgPrice != null) return avgPrice;

  const low = toNum(homeBlock?.low);
  const high = toNum(homeBlock?.high);
  if (low != null && high != null) return Math.round((low + high) / 2);

  return null;
}

function resolvePrice(body, city) {
  const bedrooms = toInt(pickFirst(body, ["bedrooms", "beds"])) ?? 3;

  const directPrice = positive(
    pickFirst(body, [
      "price",
      "homePrice",
      "home_price",
      "purchasePrice",
      "purchase_price",
      "projected_home_price",
      "projectedHomePrice"
    ]),
    null
  );

  if (directPrice != null) {
    return {
      price: directPrice,
      bedrooms,
      source: "body.price"
    };
  }

  const bedPrice = deriveBedroomPrice(city, bedrooms);
  if (bedPrice != null) {
    return {
      price: bedPrice,
      bedrooms,
      source: "city.bedroom_price"
    };
  }

  const cityAvg = positive(
    city?.avg_home_value ??
    city?.average_home_value ??
    city?.avgHome ??
    city?.city_avg_home ??
    city?.market?.avg_home_value,
    null
  );

  return {
    price: cityAvg || 0,
    bedrooms,
    source: cityAvg != null ? "city.avg_home_value" : "none"
  };
}

// ------------------------------------------------------------
// //#7) MORTGAGE ENGINE
// ------------------------------------------------------------
function defaultPmiRatePct({ loanType, dpPct }) {
  const lt = lower(loanType || "");
  if (lt === "va") return 0;
  if (lt === "fha") return 0.55;
  if ((Number(dpPct) || 0) >= 20) return 0;
  return 0.5;
}

async function callMortgageEngine(payload) {
  if (typeof mortgageHandler !== "function") {
    return {
      res: {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "mortgage.js handler missing" })
      },
      out: null
    };
  }

  const evt = {
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify(payload || {})
  };

  const res = await mortgageHandler(evt);

  let out = null;
  try {
    out = res?.body ? JSON.parse(res.body) : null;
  } catch (e) {
    throw new Error(`mortgage.js response JSON parse failed: ${String(e?.message || e)}`);
  }

  return { res, out };
}

async function computeMortgageEstimate({ body, city, price }) {
  const dpAmount = nonNegative(
    pickFirst(body, ["down", "downPayment", "down_payment", "dpAmt"]),
    null
  );

  const dpPctBody = nonNegative(
    pickFirst(body, ["dpPct", "downPaymentPct", "down_payment_pct"]),
    null
  );

  const finalDpPct =
    dpPctBody != null
      ? dpPctBody
      : (dpAmount != null && price > 0 ? (dpAmount / price) * 100 : 5);

  const termYears =
    toInt(pickFirst(body, ["termYears", "term", "term_years"])) ?? 30;

  const creditScore =
    toInt(pickFirst(body, ["creditScore", "credit_score", "fico", "score"])) ?? undefined;

  const aprOverride =
    toNum(pickFirst(body, ["apr", "aprOverride"])) ?? undefined;

  const loanType =
    lower(pickFirst(body, ["loanType", "loan_type"])) || "conventional";

  const taxRatePct =
    toNum(pickFirst(body, ["taxRate"])) ??
    toNum(city?.tax_rate ?? city?.property_tax_rate ?? city?.raw?.property_tax_rate) ??
    1.2;

  const insRatePct =
    toNum(pickFirst(body, ["insRate"])) ??
    toNum(city?.insurance_rate ?? city?.raw?.insurance_rate) ??
    0.5;

  const hoaMonthly =
    toNum(pickFirst(body, ["hoa", "hoaMonthly", "hoa_monthly"])) ??
    toNum(city?.hoa_monthly ?? city?.raw?.hoa_monthly) ??
    0;

  const pmiRatePct =
    toNum(pickFirst(body, ["pmiRate"])) ??
    defaultPmiRatePct({ loanType, dpPct: finalDpPct });

  const mortgagePayload = {
    price: price,
    down: finalDpPct,
    creditScore: creditScore,
    termYears: termYears,
    taxRate: Number.isFinite(taxRatePct) ? taxRatePct / 100 : undefined,
    insuranceAnnual: Number.isFinite(insRatePct) ? price * (insRatePct / 100) : undefined,
    hoaMonthly: Number.isFinite(hoaMonthly) ? hoaMonthly : 0,
    loanType: loanType,
    aprOverride: Number.isFinite(aprOverride) ? aprOverride : undefined,
    pmiRate: Number.isFinite(pmiRatePct) ? pmiRatePct / 100 : undefined
  };

  const { res, out } = await callMortgageEngine(mortgagePayload);

  if (!res || res.statusCode !== 200 || !out || out.ok !== true) {
    throw new Error(out?.error || `mortgage.js failed (status=${res?.statusCode ?? "unknown"})`);
  }

  return {
    ok: true,
    raw: out,
    breakdown: {
      principalInterest: Number(out?.breakdown?.pi || 0) || 0,
      propertyTax: Number(out?.breakdown?.tax || 0) || 0,
      insurance: Number(out?.breakdown?.insurance || 0) || 0,
      hoa: Number(out?.breakdown?.hoa || 0) || 0,
      pmi: Number(out?.breakdown?.pmi || 0) || 0,
      totalMonthly: Number(out?.breakdown?.allIn || 0) || 0
    },
    assumptions: {
      price: Number(out?.price || price) || price,
      dpPct: Number(out?.downPercent || finalDpPct) || finalDpPct,
      dpAmt: Number(out?.downPayment || 0) || 0,
      loanAmount: Number(out?.loanAmount || 0) || 0,
      apr: Number(out?.apr || 0) || 0,
      termYears: Number(out?.termYears || termYears) || termYears,
      creditScore: creditScore ?? null,
      loanType,
      taxRate: taxRatePct,
      insRate: insRatePct,
      hoaMonthly,
      pmiRate: pmiRatePct
    },
    meta: {
      aprSource: out?.aprSource ?? null,
      warnings: out?.meta?.warnings ?? []
    }
  };
}

// ------------------------------------------------------------
// //#8) VERDICT ENGINE
// ------------------------------------------------------------
function buildVerdict({ monthlyIncome, monthlyHousing }) {
  const safeCap = monthlyIncome * 0.30;
  const cautionCap = monthlyIncome * 0.35;
  const residual = safeCap - monthlyHousing;
  const housingRatio = monthlyIncome > 0 ? (monthlyHousing / monthlyIncome) : null;

  let verdict = "CAUTION";
  let status = "tight";
  let recommendation = "";
  let bluf = "";

  if (monthlyHousing <= safeCap * 0.92) {
    verdict = "GREEN";
    status = "healthy";
    bluf = "This scenario appears to be inside a healthy affordability lane.";
    recommendation = "This price range looks workable if the buyer’s other monthly debt and expenses remain controlled.";
  } else if (monthlyHousing <= cautionCap) {
    verdict = "CAUTION";
    status = "tight";
    bluf = "This scenario looks tight and should be treated carefully.";
    recommendation = "Consider a lower price, stronger down payment, or improved financing terms before treating this as a comfortable move.";
  } else {
    verdict = "NO-GO";
    status = "overextended";
    bluf = "This scenario looks overextended based on the current income and financing assumptions.";
    recommendation = "Bring the purchase price down, increase the down payment, or improve financing terms before moving forward.";
  }

  return {
    verdict,
    status,
    bluf,
    recommendation,
    safeCap,
    cautionCap,
    residual,
    housingRatio
  };
}

// ------------------------------------------------------------
// //#9) SEO TEXT HELPERS
// ------------------------------------------------------------
function currency(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "$0";
  return x.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });
}

function percent(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.0%";
  return `${(x * 100).toFixed(1)}%`;
}

function buildSeoSummary({ city, price, monthlyIncome, mortgage, verdict }) {
  const cityName =
    str(city?.city || city?.place || city?.market_label || city?.canonical_city_key || "this market");

  return {
    headline: `Can you afford a ${currency(price)} home in ${cityName}?`,
    summary:
      `${verdict.bluf} Estimated monthly housing cost is ${currency(mortgage.breakdown.totalMonthly)} ` +
      `against a conservative housing cap of ${currency(verdict.safeCap)} based on monthly income of ${currency(monthlyIncome)}.`,
    recommendation: verdict.recommendation
  };
}

// ------------------------------------------------------------
// //#10) HANDLER
// ------------------------------------------------------------
exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: buildCorsHeaders(event),
        body: ""
      };
    }

    if (event.httpMethod === "GET") {
      return respond(event, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        note: "POST JSON with cityKey + direct income or military inputs. Supported cities right now: SanAntonio, McAllen.",
        examples: {
          civilian: {
            cityKey: "SanAntonio",
            monthlyIncome: 8500,
            price: 350000,
            down: 20000,
            creditScore: 700,
            termYears: 30,
            loanType: "conventional"
          },
          military: {
            cityKey: "SanAntonio",
            rank: "E6",
            yos: 10,
            family: true,
            price: 350000,
            down: 0,
            creditScore: 680,
            termYears: 30,
            loanType: "va"
          }
        },
        debug: {
          runtimeDir: __RUNTIME_DIR,
          cwd: __ROOT,
          payTableCandidates: __PAY_TABLES_PATHS,
          cityDirCandidates: __CITY_DIR_CANDIDATES
        }
      });
    }

    if (event.httpMethod !== "POST") {
      return respond(event, 405, {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        error: "Method not allowed."
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      return respond(event, 400, {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        error: "Invalid JSON body."
      });
    }

    const cityInput = pickFirst(body, ["cityKey", "city", "market", "location"]);
    if (!cityInput) {
      return respond(event, 400, {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        error: "Missing cityKey/city. Supported cities right now: SanAntonio, McAllen."
      });
    }

    const city = loadCity(cityInput);
    const priceInfo = resolvePrice(body, city);

    if (!priceInfo.price || priceInfo.price <= 0) {
      return respond(event, 400, {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        error: "Unable to resolve a valid home price from the request or city data."
      });
    }

    const incomeInfo = resolveIncome(body, city);
    if (!incomeInfo.ok || !incomeInfo.monthlyIncome || incomeInfo.monthlyIncome <= 0) {
      return respond(event, 400, {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        error:
          "Missing usable income. Provide monthlyIncome or annualIncome for public buyers, or provide rank + yos for military scenarios."
      });
    }

    const mortgage = await computeMortgageEstimate({
      body,
      city,
      price: priceInfo.price
    });

    const monthlyHousing = Number(mortgage?.breakdown?.totalMonthly || 0) || 0;
    if (monthlyHousing <= 0) {
      return respond(event, 500, {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        error: "Mortgage estimate did not return a usable monthly payment."
      });
    }

    const verdict = buildVerdict({
      monthlyIncome: incomeInfo.monthlyIncome,
      monthlyHousing
    });

    const seo = buildSeoSummary({
      city,
      price: priceInfo.price,
      monthlyIncome: incomeInfo.monthlyIncome,
      mortgage,
      verdict
    });

    return respond(event, 200, {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      publicEngine: true,
      supportedCities: ["SanAntonio", "McAllen"],

      input: {
        cityInput: str(cityInput),
        cityKeyResolved: city.canonical_city_key,
        monthlyIncomeInput:
          positive(pickFirst(body, ["monthlyIncome", "monthly_income", "income", "totalMonthlyIncome"]), null),
        annualIncomeInput:
          positive(pickFirst(body, ["annualIncome", "annual_income", "yearlyIncome"]), null),
        rank: normalizeRank(pickFirst(body, ["rank", "rank_paygrade", "rankPaygrade"])),
        yos: toInt(pickFirst(body, ["yos", "years_of_service", "yearsOfService"])),
        family: boolish(pickFirst(body, ["family", "dependents", "has_dependents"]), true),
        bedrooms: priceInfo.bedrooms,
        price: priceInfo.price,
        priceSource: priceInfo.source
      },

      income: {
        monthlyIncome: incomeInfo.monthlyIncome,
        annualIncome: incomeInfo.monthlyIncome * 12,
        source: incomeInfo.source,
        pay: incomeInfo.pay || null
      },

      city: {
        key: city.canonical_city_key,
        city: city.city || city.place || null,
        marketLabel: city.market_label || null,
        zip: city.zip || null,
        avgHomeValue: city.avg_home_value || null
      },

      mortgage: {
        ok: mortgage.ok,
        source: "seo-page->mortgage.js",
        breakdown: mortgage.breakdown,
        assumptions: mortgage.assumptions,
        meta: mortgage.meta,
        estimatedMonthlyMortgage: mortgage.breakdown.totalMonthly
      },

      verdict: {
        verdict: verdict.verdict,
        status: verdict.status,
        bluf: verdict.bluf,
        recommendation: verdict.recommendation,
        safeCap: verdict.safeCap,
        cautionCap: verdict.cautionCap,
        residual: verdict.residual,
        housingRatio: verdict.housingRatio,
        housingRatioDisplay: percent(verdict.housingRatio)
      },

      seo: {
        headline: seo.headline,
        summary: seo.summary,
        recommendation: seo.recommendation
      },

      debug: {
        runtimeDir: __RUNTIME_DIR,
        cwd: __ROOT,
        cityFilePath: city?._debug_file_path || null,
        cityDirCandidates: __CITY_DIR_CANDIDATES,
        payTableCandidates: __PAY_TABLES_PATHS
      }
    });
  } catch (e) {
    return respond(event, 500, {
      ok: false,
      schemaVersion: SCHEMA_VERSION,
      error: String(e?.message || e),
      debug: {
        runtimeDir: __RUNTIME_DIR,
        cwd: __ROOT,
        cityDirCandidates: __CITY_DIR_CANDIDATES,
        payTableCandidates: __PAY_TABLES_PATHS
      }
    });
  }
};

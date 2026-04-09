// netlify/functions/elena-agent.js
// ============================================================
// OrozcoRealty • Ask-Elena — elena-agent (Deterministic Orchestrator)
// v1.1.0 (2026-04-09)
//
// PURPOSE
// - Deterministic orchestration layer for OrozcoRealty Ask-Elena
// - Answers Texas real estate + finance + selected-market questions
// - Pulls from local JSON knowledge packs
// - Optionally verifies affordability / mortgage via your API
// - Returns a clean "truth packet" for Ask-Elena narration
//
// DESIGN PRINCIPLES
// - No AI math
// - JSON knowledge packs are the source of truth for market/domain context
// - Mortgage / affordability math stays deterministic
// - Safe fallbacks + explicit sources
//
// EXPECTED JSON FILES
// - netlify/functions/data/elena-core.json
// - netlify/functions/data/finance-rules.json
// - netlify/functions/data/real-estate-knowledge-texas.json
// - netlify/functions/data/markets-texas-index.json
// - netlify/functions/data/markets/texas/<market-slug>.json
//
// OPTIONAL MARKET FILE EXAMPLES
// - netlify/functions/data/markets/texas/san-antonio.json
// - netlify/functions/data/markets/texas/mcallen.json
// - netlify/functions/data/markets/texas/austin.json
// - netlify/functions/data/markets/texas/dallas.json
// - netlify/functions/data/markets/texas/houston.json
//
// INPUT (POST JSON)
// {
//   email?: "user@email.com",
//   question?: "Can I afford a $420k home in San Antonio with 8% down and 710 credit?",
//   overrides?: {
//     marketSlug?: "san-antonio",
//     city?: "San Antonio",
//     state?: "Texas",
//     income?: 9500,
//     monthlyExpenses?: 2600,
//     monthlyDebt?: 550,
//     price?: 420000,
//     downpayment?: 33600,
//     creditScore?: 710,
//     apr?: 6.875,
//     termYears?: 30,
//     taxRate?: 0.0225,
//     taxAnnual?: 9450,
//     insuranceAnnual?: 2400,
//     hoaMonthly?: 65,
//     pmiMonthly?: 0,
//     propertyType?: "single-family",
//     occupancy?: "primary",
//     strategy?: "buy"
//   },
//   scenario?: { ... },
//   debug?: true
// }
//
// OUTPUT (JSON)
// {
//   ok: true,
//   scenario_id: "elena_...",
//   ts: 1700000000,
//   email: "...",
//   intent: "...",
//   topic_tags: [...],
//   market: {...},
//   inputs_used: {...},
//   affordability: {...},
//   mortgage: {...},
//   knowledge: {...},
//   verdict: {...},
//   next_action: {...},
//   answer_packet: {...},
//   debug?: {...}
// }
// ============================================================

/* eslint-disable no-console */

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// ------------------------------------------------------------
// //#1 CORS + ORIGIN CONTROL
// ------------------------------------------------------------
const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://www.theorozcorealty.com",
  "https://orozcorealty.com",
  "https://www.orozcorealty.com",
  "https://theorozcorealty.webflow.io",
  "https://www.theorozcorealty.webflow.io",
  "https://orozcorealty.webflow.io",
  "https://www.orozcorealty.webflow.io",
  "https://theorozcorealty.netlify.app",
  "https://www.theorozcorealty.netlify.app",
  "https://orozcorealty.netlify.app",
  "https://www.orozcorealty.netlify.app",
  "https://pcsunited.netlify.app",
  "https://www.pcsunited.netlify.app"
];

function corsHeaders(origin) {
  const allowOrigin = ALLOW_ORIGINS.includes(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin"
  };
}

function respond(statusCode, payload, origin) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(payload)
  };
}

// ------------------------------------------------------------
// //#2 HELPERS
// ------------------------------------------------------------
function safeJsonParse(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return n;
  return Math.max(lo, Math.min(hi, n));
}

function roundTo(n, step) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n / step) * step;
}

function money(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
}

function pct(n, digits = 4) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function makeScenarioId(email, ts, question) {
  const h = crypto
    .createHash("sha256")
    .update(String(email || "") + ":" + String(ts) + ":" + String(question || ""))
    .digest("hex");
  return "elena_" + h.slice(0, 16);
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (
      v !== undefined &&
      v !== null &&
      v !== "" &&
      !(typeof v === "number" && !Number.isFinite(v))
    ) {
      return v;
    }
  }
  return null;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function normalizeEmail(emailRaw) {
  const e = String(emailRaw || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return "";
  return e;
}

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .join(" ");
}

function summarizeArray(arr, max = 5) {
  return Array.isArray(arr) ? arr.filter(Boolean).slice(0, max) : [];
}

async function postJSON(url, payload, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });

    const text = await res.text();
    const data = safeJsonParse(text);

    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e?.message || e) } };
  } finally {
    clearTimeout(t);
  }
}

function pickApiBase(event) {
  const env = process.env.OROZCO_API_BASE || process.env.API_BASE;
  if (env) return env.replace(/\/$/, "");

  const host =
    event?.headers?.host ||
    event?.headers?.Host ||
    event?.headers?.["x-forwarded-host"] ||
    "";

  if (host) {
    if (/webflow\.io$/i.test(host)) return "https://theorozcorealty.netlify.app";
    if (/netlify\.app$/i.test(host)) return `https://${host}`;
    if (/orozcorealty\.com$/i.test(host) || /theorozcorealty\.com$/i.test(host)) {
      return `https://${host}`;
    }
  }

  return "https://theorozcorealty.netlify.app";
}

// ------------------------------------------------------------
// //#3 FILE LOADERS
// ------------------------------------------------------------
const DATA_DIR = path.join(process.cwd(), "netlify", "functions", "data");

async function readJsonFile(absPath) {
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

function fileExists(absPath) {
  try {
    return fs.existsSync(absPath);
  } catch {
    return false;
  }
}

async function loadKnowledgePack(relPath) {
  const absPath = path.join(DATA_DIR, relPath);
  return readJsonFile(absPath);
}

async function loadCoreKnowledge() {
  const [core, financeRules, realtyKnowledge, marketIndex] = await Promise.all([
    loadKnowledgePack("elena-core.json"),
    loadKnowledgePack("finance-rules.json"),
    loadKnowledgePack("real-estate-knowledge-texas.json"),
    loadKnowledgePack("markets-texas-index.json")
  ]);

  return {
    core: core || {},
    financeRules: financeRules || {},
    realtyKnowledge: realtyKnowledge || {},
    marketIndex: marketIndex || {}
  };
}

async function loadMarketPackBySlug(slug) {
  if (!slug) return null;

  const candidates = [
    path.join(DATA_DIR, "markets", "texas", `${slug}.json`),
    path.join(DATA_DIR, "markets", `${slug}.json`),
    path.join(DATA_DIR, `${slug}.json`)
  ];

  for (const absPath of candidates) {
    if (fileExists(absPath)) {
      const data = await readJsonFile(absPath);
      if (data) return data;
    }
  }

  return null;
}

// ------------------------------------------------------------
// //#4 QUESTION + INTENT PARSERS
// ------------------------------------------------------------
function classifyQuestion(question) {
  const q = String(question || "").trim().toLowerCase();

  if (!q) {
    return {
      intent: "general_real_estate_guidance",
      topic_tags: ["general_guidance"]
    };
  }

  const tags = [];

  if (/\bmortgage\b|\bmonthly payment\b|\bpayment\b|\bapr\b|\binterest rate\b/.test(q)) {
    tags.push("mortgage");
  }
  if (/\bafford\b|\baffordability\b|\bcan i buy\b|\bbuying power\b|\bdti\b/.test(q)) {
    tags.push("affordability");
  }
  if (/\bmarket\b|\binventory\b|\bdays on market\b|\bdom\b|\bmedian\b|\bprice per sqft\b|\bappreciation\b/.test(q)) {
    tags.push("market_analysis");
  }
  if (/\binvestor\b|\brental\b|\brent\b|\bbrrrr\b|\bcash flow\b|\bcap rate\b|\barv\b/.test(q)) {
    tags.push("investor");
  }
  if (/\bproperty tax\b|\btaxes\b|\bhomestead\b|\binsurance\b|\bhoa\b/.test(q)) {
    tags.push("ownership_costs");
  }
  if (/\bbuyer\b|\bbuying\b|\boffer\b|\bpreapproval\b|\bclosing costs\b/.test(q)) {
    tags.push("buyer_guidance");
  }
  if (/\bseller\b|\blist\b|\blisting\b|\bstaging\b|\bpricing\b/.test(q)) {
    tags.push("seller_guidance");
  }
  if (/\bcondo\b|\btownhome\b|\bduplex\b|\bmultifamily\b|\bsingle[- ]family\b/.test(q)) {
    tags.push("property_type");
  }
  if (/\btexas\b|\bsan antonio\b|\bmcallen\b|\baustin\b|\bdallas\b|\bhouston\b|\bfort worth\b|\bel paso\b/.test(q)) {
    tags.push("texas_market");
  }

  let intent = "general_real_estate_guidance";

  if (tags.includes("affordability") || tags.includes("mortgage")) intent = "finance_affordability";
  if (tags.includes("market_analysis")) intent = "market_analysis";
  if (tags.includes("investor")) intent = "investor_analysis";
  if (tags.includes("seller_guidance")) intent = "seller_strategy";
  if (tags.includes("buyer_guidance") && intent === "general_real_estate_guidance") intent = "buyer_strategy";

  return {
    intent,
    topic_tags: uniq(tags.length ? tags : ["general_guidance"])
  };
}

function parseCreditScoreFromQuestion(question) {
  const t = String(question || "").toLowerCase();
  const m =
    t.match(/(?:credit\s*score|fico)\D{0,12}(\d{3})\b/) ||
    t.match(/\b(\d{3})\s*(?:credit|fico)\b/);

  if (!m) return null;

  const s = Number(m[1]);
  if (!Number.isFinite(s) || s < 300 || s > 850) return null;
  return Math.round(s);
}

function parsePriceFromQuestion(question) {
  const t = String(question || "").toLowerCase();

  const moneyMatch =
    t.match(/\$?\s*([1-9]\d{2,3}(?:,\d{3})+)\b/) ||
    t.match(/\$?\s*([1-9]\d{2,3})\s*k\b/) ||
    t.match(/\$?\s*([1-9]\d{5,6})\b/);

  if (!moneyMatch) return null;

  const raw = String(moneyMatch[1]).replace(/,/g, "");
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;

  if (/\bk\b/.test(moneyMatch[0])) n *= 1000;

  if (n < 25000) return null;
  return Math.round(n);
}

function parsePercentDownFromQuestion(question, price) {
  const t = String(question || "").toLowerCase();
  const m = t.match(/\b(\d{1,2}(?:\.\d+)?)\s*%\s*down\b/);
  if (!m) return null;

  const pctVal = Number(m[1]);
  if (!Number.isFinite(pctVal) || pctVal <= 0 || pctVal >= 100) return null;
  if (!Number.isFinite(price)) return { percent: pctVal, amount: null };

  return {
    percent: pctVal,
    amount: Math.round(price * (pctVal / 100))
  };
}

function parseLabeledMoney(question, labels) {
  const t = String(question || "").toLowerCase();
  if (!t || !Array.isArray(labels) || !labels.length) return null;

  const moneyPattern = "(\\$?\\s*[0-9][0-9,]*(?:\\.\\d{1,2})?)";
  const normalizedLabels = labels
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean);

  for (const label of normalizedLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const patterns = [
      new RegExp(`\\b${escaped}\\b\\D{0,20}${moneyPattern}`, "i"),
      new RegExp(`${moneyPattern}\\D{0,20}\\b${escaped}\\b`, "i")
    ];

    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const raw = String(m[1] || "").replace(/\$/g, "").replace(/,/g, "").trim();
        const n = Number(raw);
        if (Number.isFinite(n)) return Math.round(n);
      }
    }
  }

  return null;
}

function parseIncomeFromQuestion(question) {
  const t = String(question || "").toLowerCase();
  if (!t) return null;

  // Strong label-first parsing so we do NOT confuse debt/expenses with income.
  const labeled = parseLabeledMoney(t, [
    "monthly income",
    "income",
    "gross income",
    "household income",
    "monthly take home",
    "take home pay",
    "bring home",
    "bring in",
    "make",
    "earn"
  ]);

  if (Number.isFinite(labeled)) return labeled;

  // "I make $9,500 a month"
  let m = t.match(/\b(?:i\s+)?(?:make|earn|bring in|bring home)\s+\$?\s*([0-9][0-9,]*)\s*(?:a\s*month|per\s*month|monthly)\b/i);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) return Math.round(n);
  }

  // "$9,500 monthly income"
  m = t.match(/\$?\s*([0-9][0-9,]*)\s*(?:\/\s*month|per\s*month|monthly)\s+(?:income|take\s*home|take-home|pay)\b/i);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) return Math.round(n);
  }

  // "$114,000 per year income"
  m = t.match(/\b(?:income|gross income|household income)\D{0,20}\$?\s*([0-9][0-9,]*)\s*(?:a\s*year|per\s*year|annually|annual)\b/i);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) return Math.round(n / 12);
  }

  // "I make $114,000 a year"
  m = t.match(/\b(?:i\s+)?(?:make|earn|bring in|bring home)\s+\$?\s*([0-9][0-9,]*)\s*(?:a\s*year|per\s*year|annually|annual)\b/i);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) return Math.round(n / 12);
  }

  return null;
}

function parseMonthlyDebtFromQuestion(question) {
  const labeled = parseLabeledMoney(question, [
    "monthly debt",
    "debt",
    "debt payments",
    "monthly debt payments"
  ]);
  if (Number.isFinite(labeled)) return labeled;

  return null;
}

function parseMonthlyExpensesFromQuestion(question) {
  const labeled = parseLabeledMoney(question, [
    "monthly expenses",
    "expenses",
    "monthly bills",
    "monthly spending"
  ]);
  if (Number.isFinite(labeled)) return labeled;

  return null;
}

function parseQuestionFacts(question) {
  const price = parsePriceFromQuestion(question);
  const downObj = parsePercentDownFromQuestion(question, price);

  return {
    inferred_price: price,
    inferred_credit_score: parseCreditScoreFromQuestion(question),
    inferred_income_monthly: parseIncomeFromQuestion(question),
    inferred_monthly_debt: parseMonthlyDebtFromQuestion(question),
    inferred_monthly_expenses: parseMonthlyExpensesFromQuestion(question),
    inferred_downpayment:
      downObj && Number.isFinite(downObj.amount) ? downObj.amount : null,
    inferred_downpayment_pct:
      downObj && Number.isFinite(downObj.percent) ? downObj.percent : null
  };
}

// ------------------------------------------------------------
// //#5 MARKET RESOLUTION
// ------------------------------------------------------------
function flattenMarketIndex(indexJson) {
  if (!indexJson || typeof indexJson !== "object") return [];

  if (Array.isArray(indexJson.markets)) return indexJson.markets;
  if (Array.isArray(indexJson.cities)) return indexJson.cities;
  if (Array.isArray(indexJson.items)) return indexJson.items;

  const keys = Object.keys(indexJson);
  return keys.map((k) => {
    const v = indexJson[k];
    if (typeof v === "object" && v) {
      return {
        slug: v.slug || slugify(v.city || v.name || k),
        city: v.city || v.name || titleCase(k),
        aliases: v.aliases || [],
        ...v
      };
    }
    return null;
  }).filter(Boolean);
}

function resolveMarketSlug({ question, overrides, scenario, marketIndex }) {
  const explicit =
    pickFirst(
      overrides?.marketSlug,
      overrides?.city,
      scenario?.marketSlug,
      scenario?.city,
      overrides?.market,
      scenario?.market
    ) || null;

  const indexItems = flattenMarketIndex(marketIndex);
  const q = String(question || "").toLowerCase();

  if (explicit) {
    const s = slugify(explicit);
    const hit = indexItems.find((item) => {
      const candidates = uniq([
        item.slug,
        slugify(item.city),
        slugify(item.name),
        ...(Array.isArray(item.aliases) ? item.aliases.map(slugify) : [])
      ]);
      return candidates.includes(s);
    });

    return hit
      ? { slug: hit.slug || slugify(hit.city || hit.name), matched_by: "explicit_index", item: hit }
      : { slug: s, matched_by: "explicit_direct", item: null };
  }

  if (!q) return { slug: null, matched_by: "none", item: null };

  for (const item of indexItems) {
    const candidates = uniq([
      item.city,
      item.name,
      item.slug,
      ...(Array.isArray(item.aliases) ? item.aliases : [])
    ]).map((x) => String(x || "").toLowerCase());

    const found = candidates.find((term) => term && q.includes(term));
    if (found) {
      return {
        slug: item.slug || slugify(item.city || item.name || found),
        matched_by: "question_index",
        item
      };
    }
  }

  const cityRegexHits = [
    "san antonio",
    "mcallen",
    "austin",
    "dallas",
    "houston",
    "fort worth",
    "el paso",
    "corpus christi",
    "new braunfels",
    "laredo"
  ].find((city) => q.includes(city));

  if (cityRegexHits) {
    return {
      slug: slugify(cityRegexHits),
      matched_by: "question_fallback",
      item: null
    };
  }

  return { slug: null, matched_by: "none", item: null };
}

// ------------------------------------------------------------
// //#6 INPUT NORMALIZATION
// ------------------------------------------------------------
function buildScenario(body, questionFacts) {
  const scenario = body?.scenario && typeof body.scenario === "object" ? body.scenario : {};
  const overrides = body?.overrides && typeof body.overrides === "object" ? body.overrides : {};

  const price = num(
    pickFirst(
      overrides.price,
      scenario.price,
      scenario.homePrice,
      scenario.projected_home_price,
      questionFacts.inferred_price
    )
  );

  const income = num(
    pickFirst(
      overrides.income,
      overrides.monthlyIncome,
      scenario.income,
      scenario.monthlyIncome,
      scenario.monthly_income,
      questionFacts.inferred_income_monthly
    )
  );

  const monthlyExpenses = num(
    pickFirst(
      overrides.monthlyExpenses,
      overrides.expenses,
      scenario.monthlyExpenses,
      scenario.monthly_expenses,
      scenario.expenses,
      questionFacts.inferred_monthly_expenses
    )
  );

  const monthlyDebt = num(
    pickFirst(
      overrides.monthlyDebt,
      overrides.debt,
      scenario.monthlyDebt,
      scenario.monthly_debt,
      scenario.debt,
      questionFacts.inferred_monthly_debt
    )
  );

  const downpayment = num(
    pickFirst(
      overrides.downpayment,
      overrides.down,
      scenario.downpayment,
      scenario.down,
      scenario.dpAmt,
      questionFacts.inferred_downpayment
    )
  );

  const creditScore = num(
    pickFirst(
      overrides.creditScore,
      overrides.credit_score,
      scenario.creditScore,
      scenario.credit_score,
      questionFacts.inferred_credit_score
    )
  );

  const apr = num(pickFirst(overrides.apr, scenario.apr, scenario.rate));
  const termYearsRaw = num(pickFirst(overrides.termYears, scenario.termYears, scenario.term));
  const termYears = termYearsRaw ? clamp(Math.round(termYearsRaw), 10, 40) : 30;

  const propertyType = String(
    pickFirst(overrides.propertyType, scenario.propertyType, scenario.property_type, "single-family")
  ).toLowerCase();

  const occupancy = String(
    pickFirst(overrides.occupancy, scenario.occupancy, "primary")
  ).toLowerCase();

  const strategy = String(
    pickFirst(overrides.strategy, scenario.strategy, occupancy === "investment" ? "invest" : "buy")
  ).toLowerCase();

  const state = String(pickFirst(overrides.state, scenario.state, "Texas")).trim() || "Texas";

  const taxRate = num(pickFirst(overrides.taxRate, scenario.taxRate, scenario.tax_rate));
  const taxAnnual = num(pickFirst(overrides.taxAnnual, scenario.taxAnnual, scenario.tax_annual));
  const insuranceAnnual = num(
    pickFirst(overrides.insuranceAnnual, scenario.insuranceAnnual, scenario.insurance_annual)
  );
  const hoaMonthly = num(pickFirst(overrides.hoaMonthly, scenario.hoaMonthly, scenario.hoa_monthly));
  const pmiMonthly = num(pickFirst(overrides.pmiMonthly, scenario.pmiMonthly, scenario.pmi_monthly));

  return {
    question: String(body?.question || "").trim(),
    overrides,
    baseline: scenario,
    state,
    price,
    income,
    monthlyExpenses,
    monthlyDebt,
    downpayment,
    creditScore: creditScore ? clamp(Math.round(creditScore), 300, 850) : null,
    apr,
    termYears,
    propertyType,
    occupancy,
    strategy,
    taxRate,
    taxAnnual,
    insuranceAnnual,
    hoaMonthly,
    pmiMonthly,
    city: pickFirst(overrides.city, scenario.city) || null,
    marketSlug: pickFirst(overrides.marketSlug, scenario.marketSlug) || null
  };
}

// ------------------------------------------------------------
// //#7 FINANCE ENGINE
// ------------------------------------------------------------
function aprTierFromScore(score, financeRules) {
  const s = Number.isFinite(score) ? score : null;

  const custom = financeRules?.apr_tiers;
  if (Array.isArray(custom) && custom.length) {
    for (const row of custom) {
      const min = num(row?.min_score);
      const apr = num(row?.apr);
      if (Number.isFinite(min) && Number.isFinite(apr) && s !== null && s >= min) {
        return apr > 1 ? apr / 100 : apr;
      }
    }
  }

  if (!s) return 0.07;
  if (s >= 780) return 0.0625;
  if (s >= 740) return 0.0675;
  if (s >= 700) return 0.0725;
  if (s >= 660) return 0.08;
  return 0.09;
}

function pmtMonthly(principal, apr, termYears) {
  if (!Number.isFinite(principal) || principal <= 0) return null;
  const y = Number.isFinite(termYears) ? termYears : 30;
  const n = Math.round(y * 12);
  const r = (Number.isFinite(apr) ? apr : 0.07) / 12;
  if (n <= 0) return null;
  if (r <= 0) return principal / n;

  const pow = Math.pow(1 + r, n);
  const p = principal * (r * pow) / (pow - 1);
  return Number.isFinite(p) ? p : null;
}

function principalFromPmt(targetPI, apr, termYears) {
  if (!Number.isFinite(targetPI) || targetPI <= 0) return null;
  const y = Number.isFinite(termYears) ? termYears : 30;
  const n = Math.round(y * 12);
  const r = (Number.isFinite(apr) ? apr : 0.07) / 12;
  if (n <= 0) return null;
  if (r <= 0) return targetPI * n;

  const pow = Math.pow(1 + r, n);
  const principal = targetPI * (pow - 1) / (r * pow);
  return Number.isFinite(principal) ? principal : null;
}

function estimatePropertyTaxAnnual({ price, taxRate, marketPack }) {
  if (Number.isFinite(taxRate) && Number.isFinite(price)) {
    return price * taxRate;
  }

  const marketTaxRate = num(
    pickFirst(
      marketPack?.ownership_costs?.property_tax_rate,
      marketPack?.property_tax_rate,
      marketPack?.costs?.property_tax_rate
    )
  );

  if (Number.isFinite(marketTaxRate) && Number.isFinite(price)) {
    return price * marketTaxRate;
  }

  return null;
}

function estimateInsuranceAnnual({ insuranceAnnual, price, marketPack }) {
  if (Number.isFinite(insuranceAnnual)) return insuranceAnnual;

  const flat = num(
    pickFirst(
      marketPack?.ownership_costs?.insurance_annual_default,
      marketPack?.insurance_annual_default,
      marketPack?.costs?.insurance_annual_default
    )
  );
  if (Number.isFinite(flat)) return flat;

  const pctRate = num(
    pickFirst(
      marketPack?.ownership_costs?.insurance_rate_estimate,
      marketPack?.insurance_rate_estimate
    )
  );
  if (Number.isFinite(pctRate) && Number.isFinite(price)) {
    return price * pctRate;
  }

  return null;
}

function buildQuickAffordability({ income, monthlyDebt = 0, monthlyExpenses = 0, apr, termYears, financeRules }) {
  if (!Number.isFinite(income) || income <= 0) return null;

  const housingCapPct =
    num(financeRules?.housing_cap_pct) ||
    num(financeRules?.default_housing_cap_pct) ||
    0.30;

  const backEndDtiPct =
    num(financeRules?.back_end_dti_pct) ||
    num(financeRules?.max_total_dti_pct) ||
    0.43;

  const reservesBuffer =
    num(financeRules?.pi_buffer_factor) ||
    num(financeRules?.buffer_factor) ||
    1.28;

  const frontEndCap = income * housingCapPct;
  const totalCap = income * backEndDtiPct;

  const availableByTotalDti = totalCap - (Number.isFinite(monthlyDebt) ? monthlyDebt : 0);
  const allInCap = Math.max(0, Math.min(frontEndCap, availableByTotalDti));
  const piTarget = allInCap / reservesBuffer;

  const principal0 = principalFromPmt(piTarget, apr, termYears);
  const price0 = principal0 || null;
  const price5 = principal0 ? principal0 / 0.95 : null;
  const price10 = principal0 ? principal0 / 0.90 : null;
  const residualBeforeHousing = income - (monthlyExpenses || 0) - (monthlyDebt || 0);

  return {
    housing_cap_monthly: money(frontEndCap),
    total_dti_cap_monthly: money(totalCap),
    all_in_cap_monthly: money(allInCap),
    pi_target_monthly: money(piTarget),
    residual_before_housing: money(residualBeforeHousing),
    assumptions: {
      housing_cap_pct: housingCapPct,
      back_end_dti_pct: backEndDtiPct,
      buffer_factor: reservesBuffer,
      apr_assumed: pct(apr, 5),
      term_years: termYears
    },
    quick_max_price: {
      price_0_down: money(price0),
      price_5_down: money(price5),
      price_10_down: money(price10)
    }
  };
}

function computeFallbackMortgage({
  price,
  downpayment,
  creditScore,
  apr,
  termYears,
  taxRate,
  taxAnnual,
  insuranceAnnual,
  hoaMonthly,
  pmiMonthly,
  marketPack
}) {
  if (!Number.isFinite(price) || price <= 0) return null;

  const down = Number.isFinite(downpayment) ? downpayment : 0;
  const loanAmount = price - down;
  if (!Number.isFinite(loanAmount) || loanAmount <= 0) return null;

  const rate = Number.isFinite(apr) ? apr : aprTierFromScore(creditScore, {});
  const pi = pmtMonthly(loanAmount, rate, termYears);
  if (!Number.isFinite(pi)) return null;

  const estTaxAnnual = Number.isFinite(taxAnnual)
    ? taxAnnual
    : estimatePropertyTaxAnnual({ price, taxRate, marketPack });

  const estInsuranceAnnual = estimateInsuranceAnnual({ insuranceAnnual, price, marketPack });

  const hoa = Number.isFinite(hoaMonthly) ? hoaMonthly : 0;

  let pmi = Number.isFinite(pmiMonthly) ? pmiMonthly : 0;
  const ltv = price > 0 ? loanAmount / price : null;
  if (!Number.isFinite(pmi) || pmi < 0) pmi = 0;

  if (!pmi && Number.isFinite(ltv) && ltv > 0.80) {
    pmi = Math.round((loanAmount * 0.005) / 12);
  }

  const taxesMonthly = Number.isFinite(estTaxAnnual) ? estTaxAnnual / 12 : 0;
  const insuranceMonthly = Number.isFinite(estInsuranceAnnual) ? estInsuranceAnnual / 12 : 0;

  const allIn = pi + taxesMonthly + insuranceMonthly + hoa + pmi;

  return {
    source: "deterministic_fallback",
    all_in_monthly: money(allIn),
    loan_amount: money(loanAmount),
    ltv: Number.isFinite(ltv) ? pct(ltv, 4) : null,
    apr_used: pct(rate, 5),
    term_years: termYears,
    breakdown: {
      principal_interest: money(pi),
      taxes: money(taxesMonthly),
      insurance: money(insuranceMonthly),
      hoa: money(hoa),
      pmi: money(pmi)
    },
    assumptions: {
      tax_annual_used: money(estTaxAnnual),
      insurance_annual_used: money(estInsuranceAnnual)
    }
  };
}

function computeAffordabilityVerdict({
  income,
  monthlyExpenses,
  monthlyDebt,
  housingAllIn,
  financeRules
}) {
  if (!Number.isFinite(income) || income <= 0) {
    return {
      status: "INSUFFICIENT",
      grade: "N/A",
      residual: null,
      ratios: {
        housing_ratio: null,
        debt_ratio: null,
        total_fixed_ratio: null
      },
      notes: ["Missing income; cannot compute a finance-grade affordability verdict."]
    };
  }

  const expenses = Number.isFinite(monthlyExpenses) ? monthlyExpenses : 0;
  const debt = Number.isFinite(monthlyDebt) ? monthlyDebt : 0;
  const housing = Number.isFinite(housingAllIn) && housingAllIn > 0 ? housingAllIn : null;

  const housingCapPct =
    num(financeRules?.housing_cap_pct) ||
    num(financeRules?.default_housing_cap_pct) ||
    0.30;

  const cautionHousingPct =
    num(financeRules?.housing_caution_pct) ||
    0.33;

  const backEndDtiPct =
    num(financeRules?.back_end_dti_pct) ||
    num(financeRules?.max_total_dti_pct) ||
    0.43;

  const cautionBackEndPct =
    num(financeRules?.back_end_dti_caution_pct) ||
    0.47;

  if (!housing) {
    return {
      status: "INSUFFICIENT",
      grade: "N/A",
      residual: null,
      ratios: {
        housing_ratio: null,
        debt_ratio: Number.isFinite(debt) ? pct(debt / income, 4) : null,
        total_fixed_ratio: Number.isFinite(expenses + debt) ? pct((expenses + debt) / income, 4) : null
      },
      notes: ["Mortgage estimate is missing; quick affordability rails are available but not a full verdict."]
    };
  }

  const housingRatio = housing / income;
  const debtRatio = debt / income;
  const totalFixedRatio = (housing + debt) / income;
  const residual = income - expenses - debt - housing;

  let status = "GREEN";
  let grade = "B+";
  const notes = [];

  if (residual < 0) {
    status = "NO-GO";
    grade = "D";
    notes.push("Residual income turns negative after housing, debt, and monthly expenses.");
  } else if (housingRatio > cautionHousingPct || totalFixedRatio > cautionBackEndPct) {
    status = "NO-GO";
    grade = "D+";
    notes.push("This scenario pushes beyond the safer front-end or back-end affordability rails.");
  } else if (housingRatio > housingCapPct || totalFixedRatio > backEndDtiPct) {
    status = "CAUTION";
    grade = "C+";
    notes.push("This scenario is technically possible, but the monthly cushion is thinner than ideal.");
  } else if (residual < income * 0.08) {
    status = "CAUTION";
    grade = "B-";
    notes.push("The scenario fits, but leaves a shallow post-housing buffer.");
  } else if (housingRatio <= 0.25 && totalFixedRatio <= 0.36 && residual >= income * 0.15) {
    status = "GREEN";
    grade = "A";
    notes.push("Strong buffer and healthy ratios.");
  } else {
    status = "GREEN";
    grade = "B+";
    notes.push("This scenario appears workable within standard affordability rails.");
  }

  return {
    status,
    grade,
    residual: money(residual),
    ratios: {
      housing_ratio: pct(housingRatio, 4),
      debt_ratio: pct(debtRatio, 4),
      total_fixed_ratio: pct(totalFixedRatio, 4)
    },
    rails: {
      housing_cap_pct: housingCapPct,
      back_end_dti_pct: backEndDtiPct
    },
    notes
  };
}

// ------------------------------------------------------------
// //#8 KNOWLEDGE EXTRACTION
// ------------------------------------------------------------
function pickKnowledgeByIntent({ intent, topic_tags, realtyKnowledge, financeRules }) {
  const out = {
    finance_points: [],
    realty_points: [],
    guardrails: []
  };

  const financeFaq = realtyKnowledge?.finance_faq || financeRules?.faq || [];
  const buyerGuide = realtyKnowledge?.buyer_guidance || [];
  const sellerGuide = realtyKnowledge?.seller_guidance || [];
  const investorGuide = realtyKnowledge?.investor_guidance || [];
  const texasSpecific = realtyKnowledge?.texas_specific || [];
  const guardrails = uniq([
    ...(Array.isArray(financeRules?.guardrails) ? financeRules.guardrails : []),
    ...(Array.isArray(realtyKnowledge?.guardrails) ? realtyKnowledge.guardrails : [])
  ]);

  if (intent === "finance_affordability") {
    out.finance_points = summarizeArray(financeFaq, 6);
    out.realty_points = summarizeArray(buyerGuide, 4);
  } else if (intent === "market_analysis") {
    out.finance_points = summarizeArray(financeFaq, 3);
    out.realty_points = summarizeArray(texasSpecific, 6);
  } else if (intent === "seller_strategy") {
    out.realty_points = summarizeArray(sellerGuide, 6);
  } else if (intent === "investor_analysis") {
    out.realty_points = summarizeArray(investorGuide, 6);
    out.finance_points = summarizeArray(financeFaq, 4);
  } else if (intent === "buyer_strategy") {
    out.realty_points = summarizeArray(buyerGuide, 6);
    out.finance_points = summarizeArray(financeFaq, 4);
  } else {
    out.realty_points = summarizeArray(texasSpecific, 4);
    out.finance_points = summarizeArray(financeFaq, 3);
  }

  if (topic_tags.includes("ownership_costs")) {
    const ownership = realtyKnowledge?.ownership_costs || [];
    out.realty_points = uniq([...out.realty_points, ...summarizeArray(ownership, 4)]);
  }

  out.guardrails = summarizeArray(guardrails, 6);
  return out;
}

function buildMarketSummary(marketPack) {
  if (!marketPack || typeof marketPack !== "object") {
    return {
      available: false,
      city: null,
      summary_points: [],
      metrics: {},
      neighborhoods: [],
      risks: [],
      opportunities: []
    };
  }

  const metrics = {
    median_list_price: num(
      pickFirst(
        marketPack?.market_metrics?.median_list_price,
        marketPack?.metrics?.median_list_price,
        marketPack?.median_list_price
      )
    ),
    median_sold_price: num(
      pickFirst(
        marketPack?.market_metrics?.median_sold_price,
        marketPack?.metrics?.median_sold_price,
        marketPack?.median_sold_price
      )
    ),
    median_rent: num(
      pickFirst(
        marketPack?.rental_metrics?.median_rent,
        marketPack?.metrics?.median_rent,
        marketPack?.median_rent
      )
    ),
    days_on_market: num(
      pickFirst(
        marketPack?.market_metrics?.days_on_market,
        marketPack?.metrics?.days_on_market,
        marketPack?.days_on_market
      )
    ),
    inventory_months: num(
      pickFirst(
        marketPack?.market_metrics?.inventory_months,
        marketPack?.metrics?.inventory_months,
        marketPack?.inventory_months
      )
    ),
    price_per_sqft: num(
      pickFirst(
        marketPack?.market_metrics?.price_per_sqft,
        marketPack?.metrics?.price_per_sqft,
        marketPack?.price_per_sqft
      )
    ),
    property_tax_rate: num(
      pickFirst(
        marketPack?.ownership_costs?.property_tax_rate,
        marketPack?.property_tax_rate
      )
    )
  };

  return {
    available: true,
    slug: marketPack?.slug || null,
    city: marketPack?.city || marketPack?.name || null,
    state: marketPack?.state || "Texas",
    profile: marketPack?.profile || null,
    summary_points: summarizeArray(
      pickFirst(
        marketPack?.summary_points,
        marketPack?.summary,
        marketPack?.overview,
        []
      ),
      8
    ),
    metrics,
    neighborhoods: summarizeArray(
      pickFirst(
        marketPack?.neighborhoods,
        marketPack?.target_neighborhoods,
        []
      ),
      8
    ),
    risks: summarizeArray(
      pickFirst(
        marketPack?.risk_flags,
        marketPack?.risks,
        []
      ),
      6
    ),
    opportunities: summarizeArray(
      pickFirst(
        marketPack?.opportunities,
        marketPack?.investor_angles,
        []
      ),
      6
    ),
    landlords: summarizeArray(
      pickFirst(
        marketPack?.landlord_notes,
        marketPack?.rental_notes,
        []
      ),
      5
    ),
    buyers: summarizeArray(
      pickFirst(
        marketPack?.buyer_notes,
        marketPack?.buyer_guidance,
        []
      ),
      5
    ),
    sellers: summarizeArray(
      pickFirst(
        marketPack?.seller_notes,
        marketPack?.seller_guidance,
        []
      ),
      5
    )
  };
}

// ------------------------------------------------------------
// //#9 NEXT ACTION ENGINE
// ------------------------------------------------------------
function buildMissingInputs({ income, price, downpayment, creditScore, monthlyExpenses }) {
  const missing = [];
  if (!Number.isFinite(income)) missing.push("income");
  if (!Number.isFinite(monthlyExpenses)) missing.push("monthlyExpenses");
  if (!Number.isFinite(price)) missing.push("price");
  if (!Number.isFinite(downpayment)) missing.push("downpayment");
  if (!Number.isFinite(creditScore)) missing.push("creditScore");
  return missing;
}

function pickNextAction({ intent, verdict, quick, marketSummary, inputs }) {
  if (!verdict || verdict.status === "INSUFFICIENT") {
    return {
      type: "collect_missing_inputs",
      why: "I can tighten this answer as soon as the missing finance inputs are provided.",
      target: {
        missing: buildMissingInputs(inputs)
      }
    };
  }

  if (intent === "market_analysis" && marketSummary?.available) {
    return {
      type: "market_positioning",
      why: "Use the local market metrics and risks to decide whether timing, neighborhood, or budget should move first.",
      target: {
        city: marketSummary.city,
        next_review: ["inventory", "days_on_market", "property_tax", "price_band"]
      }
    };
  }

  if (intent === "seller_strategy") {
    return {
      type: "prepare_listing_plan",
      why: "Next move is a pricing, prep, and positioning plan tailored to the market pack.",
      target: {
        focus: ["pricing_band", "prep_items", "days_on_market", "buyer_pool"]
      }
    };
  }

  if (intent === "investor_analysis") {
    return {
      type: verdict.status === "GREEN" ? "underwrite_deal" : "reshape_deal",
      why:
        verdict.status === "GREEN"
          ? "Run the full investor underwriting next."
          : "The deal needs a stronger entry point, lower basis, or higher rent spread.",
      target: null
    };
  }

  if (verdict.status === "NO-GO") {
    const currentPrice = num(inputs.price);
    const cap = num(quick?.quick_max_price?.price_5_down || quick?.quick_max_price?.price_10_down);

    return {
      type: "lower_price_or_raise_cash",
      why: "This scenario is stretching beyond healthy rails.",
      target: {
        current_price: money(currentPrice),
        rough_target_price: money(cap)
      }
    };
  }

  if (verdict.status === "CAUTION") {
    return {
      type: "build_more_buffer",
      why: "A modest reduction in housing payment, debt, or monthly expenses should materially strengthen the scenario.",
      target: null
    };
  }

  return {
    type: "move_to_execution",
    why: "The scenario looks workable. Next step is tightening assumptions and turning this into a transaction plan.",
    target: null
  };
}

// ------------------------------------------------------------
// //#10 OPTIONAL PROFILE FETCH
// ------------------------------------------------------------
async function fetchProfileIfPossible({ API_BASE, email }) {
  if (!email) return { ok: false, source: "none", profile: null };

  const r = await postJSON(`${API_BASE}/api/profile-by-email`, { email });
  if (r.ok && r.data) {
    return {
      ok: true,
      source: "api/profile-by-email",
      profile: r.data?.profile || r.data || null
    };
  }

  return {
    ok: false,
    source: "api/profile-by-email:failed",
    profile: null
  };
}

// ------------------------------------------------------------
// //#11 MAIN HANDLER
// ------------------------------------------------------------
exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true }, origin);
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed. Use POST." }, origin);
  }

  const body = safeJsonParse(event.body);
  const email = normalizeEmail(body.email);
  const question = String(body?.question || "").trim();

  const API_BASE = pickApiBase(event);
  const ts = nowTs();
  const scenario_id = makeScenarioId(email, ts, question);

  const [packs, profileResult] = await Promise.all([
    loadCoreKnowledge(),
    fetchProfileIfPossible({ API_BASE, email })
  ]);

  const questionInfo = classifyQuestion(question);
  const questionFacts = parseQuestionFacts(question);
  const sc = buildScenario(body, questionFacts);

  const marketResolution = resolveMarketSlug({
    question,
    overrides: body?.overrides || {},
    scenario: body?.scenario || {},
    marketIndex: packs.marketIndex
  });

  const marketSlug = sc.marketSlug || marketResolution.slug || null;
  const marketPack = marketSlug ? await loadMarketPackBySlug(marketSlug) : null;
  const marketSummary = buildMarketSummary(marketPack);

  const profile = profileResult.profile || null;

  const profileIncome = num(
    pickFirst(
      profile?.monthly_income,
      profile?.income,
      profile?.monthlyIncome
    )
  );

  const income = num(pickFirst(sc.income, profileIncome));
  const monthlyExpenses = num(
    pickFirst(
      sc.monthlyExpenses,
      profile?.monthly_expenses,
      profile?.expenses
    )
  );

  const monthlyDebt = num(
    pickFirst(
      sc.monthlyDebt,
      profile?.monthly_debt,
      profile?.debt
    )
  );

  const downpayment = sc.downpayment;
  const price = sc.price;
  const creditScore = sc.creditScore;
  const aprUsed = Number.isFinite(sc.apr)
    ? (sc.apr > 1 ? sc.apr / 100 : sc.apr)
    : aprTierFromScore(creditScore, packs.financeRules);

  // ----------------------------------------------------------
  // //#11A Mortgage Verification
  // ----------------------------------------------------------
  let mortgage = null;
  let mortgageSource = "missing";
  let mortgageApiStatus = null;

  const mortgagePayload = {
    price: Number.isFinite(price) ? price : undefined,
    down: Number.isFinite(downpayment) ? downpayment : undefined,
    creditScore: Number.isFinite(creditScore) ? creditScore : undefined,
    apr: pct(aprUsed, 5),
    termYears: sc.termYears,
    taxRate: Number.isFinite(sc.taxRate) ? sc.taxRate : undefined,
    taxAnnual: Number.isFinite(sc.taxAnnual) ? sc.taxAnnual : undefined,
    insuranceAnnual: Number.isFinite(sc.insuranceAnnual) ? sc.insuranceAnnual : undefined,
    hoaMonthly: Number.isFinite(sc.hoaMonthly) ? sc.hoaMonthly : undefined,
    pmi: Number.isFinite(sc.pmiMonthly) ? sc.pmiMonthly : undefined,
    occupancy: sc.occupancy,
    propertyType: sc.propertyType
  };

  const hasMortgageInputs =
    Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(downpayment) &&
    downpayment >= 0 &&
    Number.isFinite(creditScore);

  if (hasMortgageInputs) {
    const mortgageRes = await postJSON(`${API_BASE}/api/mortgage-calculator`, mortgagePayload);

    mortgageApiStatus = mortgageRes.status;

    const apiAllIn = num(
      pickFirst(
        mortgageRes?.data?.allIn,
        mortgageRes?.data?.all_in_monthly,
        mortgageRes?.data?.allInMonthly,
        mortgageRes?.data?.monthlyAllIn,
        mortgageRes?.data?.totalMonthly
      )
    );

    if (mortgageRes.ok && Number.isFinite(apiAllIn) && apiAllIn > 0) {
      mortgage = {
        source: "api/mortgage-calculator",
        all_in_monthly: money(apiAllIn),
        loan_amount: money(
          pickFirst(
            num(mortgageRes?.data?.loan),
            num(mortgageRes?.data?.loan_amount),
            num(price) - num(downpayment)
          )
        ),
        apr_used: pct(
          pickFirst(
            num(mortgageRes?.data?.apr),
            aprUsed
          ),
          5
        ),
        term_years: sc.termYears,
        ltv: Number.isFinite(price - downpayment) && price > 0
          ? pct((price - downpayment) / price, 4)
          : null,
        breakdown: {
          principal_interest: money(
            pickFirst(
              num(mortgageRes?.data?.pi),
              num(mortgageRes?.data?.principal_interest)
            )
          ),
          taxes: money(
            pickFirst(
              num(mortgageRes?.data?.taxes),
              num(mortgageRes?.data?.tax)
            )
          ),
          insurance: money(num(mortgageRes?.data?.ins)),
          hoa: money(num(mortgageRes?.data?.hoa)),
          pmi: money(num(mortgageRes?.data?.pmi))
        },
        assumptions: {
          raw_api: undefined
        }
      };
      mortgageSource = "api/mortgage-calculator";
    } else {
      mortgage = computeFallbackMortgage({
        price,
        downpayment,
        creditScore,
        apr: aprUsed,
        termYears: sc.termYears,
        taxRate: sc.taxRate,
        taxAnnual: sc.taxAnnual,
        insuranceAnnual: sc.insuranceAnnual,
        hoaMonthly: sc.hoaMonthly,
        pmiMonthly: sc.pmiMonthly,
        marketPack
      });
      mortgageSource = mortgage ? "deterministic_fallback" : "missing";
    }
  } else {
    mortgage = computeFallbackMortgage({
      price,
      downpayment,
      creditScore,
      apr: aprUsed,
      termYears: sc.termYears,
      taxRate: sc.taxRate,
      taxAnnual: sc.taxAnnual,
      insuranceAnnual: sc.insuranceAnnual,
      hoaMonthly: sc.hoaMonthly,
      pmiMonthly: sc.pmiMonthly,
      marketPack
    });
    mortgageSource = mortgage ? "deterministic_fallback_partial" : "insufficient_inputs_for_mortgage";
  }

  const quick = buildQuickAffordability({
    income,
    monthlyDebt,
    monthlyExpenses,
    apr: aprUsed,
    termYears: sc.termYears,
    financeRules: packs.financeRules
  });

  const verdict = computeAffordabilityVerdict({
    income,
    monthlyExpenses,
    monthlyDebt,
    housingAllIn: mortgage?.all_in_monthly || null,
    financeRules: packs.financeRules
  });

  const knowledge = pickKnowledgeByIntent({
    intent: questionInfo.intent,
    topic_tags: questionInfo.topic_tags,
    realtyKnowledge: packs.realtyKnowledge,
    financeRules: packs.financeRules
  });

  const next_action = pickNextAction({
    intent: questionInfo.intent,
    verdict,
    quick,
    marketSummary,
    inputs: {
      income,
      monthlyExpenses,
      price,
      downpayment,
      creditScore
    }
  });

  const answer_packet = {
    persona: {
      name: pickFirst(packs.core?.name, "Elena"),
      role: pickFirst(
        packs.core?.role,
        "OrozcoRealty real estate and financial guidance specialist"
      ),
      market_scope: "Texas"
    },
    user_question: question || null,
    answer_mode: questionInfo.intent,
    bottom_line: {
      verdict: verdict?.status || "INSUFFICIENT",
      grade: verdict?.grade || "N/A",
      next_move: next_action?.type || null
    },
    market_context: marketSummary?.available
      ? {
          city: marketSummary.city,
          metrics: marketSummary.metrics,
          opportunities: marketSummary.opportunities,
          risks: marketSummary.risks
        }
      : null,
    finance_context: {
      income: money(income),
      monthly_expenses: money(monthlyExpenses),
      monthly_debt: money(monthlyDebt),
      estimated_housing_payment: money(mortgage?.all_in_monthly),
      residual: money(verdict?.residual),
      quick_buying_power: quick?.quick_max_price || null
    },
    teaching_points: uniq([
      ...knowledge.finance_points,
      ...knowledge.realty_points
    ]).slice(0, 8),
    guardrails: knowledge.guardrails
  };

  const payload = {
    ok: true,
    scenario_id,
    ts,
    email: email || null,
    intent: questionInfo.intent,
    topic_tags: questionInfo.topic_tags,
    profile_used: profile
      ? {
          email,
          first_name: pickFirst(profile?.first_name, profile?.firstName) || null,
          last_name: pickFirst(profile?.last_name, profile?.lastName) || null,
          full_name: pickFirst(profile?.full_name, profile?.fullName) || null
        }
      : null,
    market: {
      requested_slug: marketSlug,
      matched_by: marketResolution.matched_by,
      loaded: !!marketPack,
      summary: marketSummary
    },
    inputs_used: {
      income: money(income),
      monthlyExpenses: money(monthlyExpenses),
      monthlyDebt: money(monthlyDebt),
      price: money(price),
      downpayment: money(downpayment),
      creditScore: Number.isFinite(creditScore) ? creditScore : null,
      apr_used: pct(aprUsed, 5),
      termYears: sc.termYears,
      propertyType: sc.propertyType,
      occupancy: sc.occupancy,
      strategy: sc.strategy,
      sources: {
        profile: profileResult.source,
        income: Number.isFinite(sc.income) ? "request" : Number.isFinite(profileIncome) ? "profile" : "missing",
        monthlyExpenses: Number.isFinite(sc.monthlyExpenses) ? "request" : "missing",
        monthlyDebt: Number.isFinite(sc.monthlyDebt) ? "request" : "missing",
        price: Number.isFinite(sc.price) ? "request/question" : "missing",
        downpayment: Number.isFinite(sc.downpayment) ? "request/question" : "missing",
        creditScore: Number.isFinite(sc.creditScore) ? "request/question" : "missing",
        market: marketPack ? "local_json" : "not_found",
        mortgage: mortgageSource
      }
    },
    affordability: quick || null,
    mortgage: mortgage || {
      source: mortgageSource,
      all_in_monthly: null,
      breakdown: null
    },
    knowledge,
    verdict,
    next_action,
    answer_packet
  };

  const debugEnabled =
    body?.debug === true ||
    (event.queryStringParameters &&
      (event.queryStringParameters.debug === "1" ||
        event.queryStringParameters.debug === "true"));

  if (debugEnabled) {
    payload.debug = {
      API_BASE,
      profile_found: !!profile,
      question_facts: questionFacts,
      market_resolution: marketResolution,
      market_slug: marketSlug,
      market_file_loaded: !!marketPack,
      mortgage_api_status: mortgageApiStatus,
      mortgage_payload_sent: mortgagePayload,
      finance_rule_keys: Object.keys(packs.financeRules || {}),
      core_keys: Object.keys(packs.core || {}),
      realty_knowledge_keys: Object.keys(packs.realtyKnowledge || {})
    };
  }

  return respond(200, payload, origin);
};

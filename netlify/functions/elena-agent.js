// netlify/functions/elena-agent.js
// ============================================================
// OrozcoRealty • Ask-Elena — elena-agent (Deterministic Orchestrator)
// v2.3.0 (2026-04-09)
//
// PURPOSE
// - Deterministic orchestration layer for OrozcoRealty Ask-Elena
// - Handles broader housing question coverage for Texas real estate + finance
// - Pulls from local JSON knowledge packs
// - Uses deterministic math for affordability, payment, and price-range logic
// - Optionally verifies mortgage via your API when inputs are available
//
// CORE QUESTION LANES
// - affordability_check            -> "Can I afford a $425k home?"
// - payment_to_price               -> "What home price can I get with a $2400 payment?"
// - mortgage_payment_estimate      -> "What would my payment be on a $380k home with 5% down?"
// - price_range_guidance           -> "What price range should I shop in?"
// - market_analysis                -> "How is San Antonio for buyers right now?"
// - seller_strategy                -> "How should I price my home in McAllen?"
// - investor_analysis              -> "Is San Antonio a good rental market?"
// - general_real_estate_guidance   -> catch-all / educational questions
//
// DESIGN PRINCIPLES
// - No AI math
// - JSON packs are source of truth for knowledge/market framing
// - Deterministic formulas for numbers
// - Graceful degradation when inputs are missing
//
// EXPECTED JSON FILES
// - netlify/functions/data/elena-core.json
// - netlify/functions/data/finance-rules.json
// - netlify/functions/data/real-estate-knowledge-texas.json
// - netlify/functions/data/markets-texas-index.json
// - netlify/functions/data/markets/texas/<market-slug>.json
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
  if (!Number.isFinite(n) || !Number.isFinite(step) || step <= 0) return n;
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

function hasPositiveMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
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
function fileExists(absPath) {
  try {
    return fs.existsSync(absPath);
  } catch {
    return false;
  }
}

function resolveDataDir() {
  const candidates = [
    path.join(__dirname, "data"),
    path.join(__dirname, "netlify", "functions", "data"),
    path.join(process.cwd(), "netlify", "functions", "data"),
    path.join(process.cwd(), "data")
  ];

  for (const p of candidates) {
    if (fileExists(p)) return p;
  }

  return candidates[0];
}

const DATA_DIR = resolveDataDir();

async function readJsonFile(absPath) {
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    return safeJsonParse(raw);
  } catch {
    return null;
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

function buildMarketFileCandidates(slug) {
  if (!slug) return [];
  return [
    path.join(DATA_DIR, "markets", "texas", `${slug}.json`),
    path.join(DATA_DIR, "markets", `${slug}.json`),
    path.join(DATA_DIR, `${slug}.json`)
  ];
}

async function loadMarketPackBySlug(slug) {
  if (!slug) return null;

  const candidates = buildMarketFileCandidates(slug);

  for (const absPath of candidates) {
    if (fileExists(absPath)) {
      const data = await readJsonFile(absPath);
      if (data) return data;
    }
  }

  return null;
}

// ------------------------------------------------------------
// //#4 QUESTION CLASSIFICATION + PARSERS
// ------------------------------------------------------------
function parseMoneyToken(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\$/g, "").replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
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
      new RegExp(`\\b${escaped}\\b\\D{0,24}${moneyPattern}`, "i"),
      new RegExp(`${moneyPattern}\\D{0,24}\\b${escaped}\\b`, "i")
    ];

    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const n = parseMoneyToken(m[1]);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  return null;
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

  const m =
    t.match(/\$?\s*([1-9]\d{2,3}(?:,\d{3})+)\b/) ||
    t.match(/\$?\s*([1-9]\d{2,3})\s*k\b/) ||
    t.match(/\$?\s*([1-9]\d{5,6})\b/);

  if (!m) return null;

  let n = parseMoneyToken(m[1]);
  if (!Number.isFinite(n)) return null;
  if (/\bk\b/.test(m[0])) n *= 1000;
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

function parseBedroomsFromQuestion(question) {
  const t = String(question || "").toLowerCase();

  const m =
    t.match(/\b([1-9])\s*bed(?:room)?s?\b/) ||
    t.match(/\b([1-9])br\b/) ||
    t.match(/\b([1-9])\s*bd\b/);

  if (!m) return null;

  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseIncomeFromQuestion(question) {
  const t = String(question || "").toLowerCase();
  if (!t) return null;

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

  let m = t.match(/\b(?:i\s+)?(?:make|earn|bring in|bring home)\s+\$?\s*([0-9][0-9,]*)\s*(?:a\s*month|per\s*month|monthly)\b/i);
  if (m) {
    const n = parseMoneyToken(m[1]);
    if (Number.isFinite(n)) return n;
  }

  m = t.match(/\$?\s*([0-9][0-9,]*)\s*(?:\/\s*month|per\s*month|monthly)\s+(?:income|take\s*home|take-home|pay)\b/i);
  if (m) {
    const n = parseMoneyToken(m[1]);
    if (Number.isFinite(n)) return n;
  }

  m = t.match(/\b(?:income|gross income|household income)\D{0,20}\$?\s*([0-9][0-9,]*)\s*(?:a\s*year|per\s*year|annually|annual)\b/i);
  if (m) {
    const n = parseMoneyToken(m[1]);
    if (Number.isFinite(n)) return Math.round(n / 12);
  }

  m = t.match(/\b(?:i\s+)?(?:make|earn|bring in|bring home)\s+\$?\s*([0-9][0-9,]*)\s*(?:a\s*year|per\s*year|annually|annual)\b/i);
  if (m) {
    const n = parseMoneyToken(m[1]);
    if (Number.isFinite(n)) return Math.round(n / 12);
  }

  return null;
}

function parseMonthlyDebtFromQuestion(question) {
  return parseLabeledMoney(question, [
    "monthly debt",
    "debt",
    "debt payments",
    "monthly debt payments"
  ]);
}

function parseMonthlyExpensesFromQuestion(question) {
  return parseLabeledMoney(question, [
    "monthly expenses",
    "expenses",
    "monthly bills",
    "monthly spending"
  ]);
}

function parseTargetMonthlyPaymentFromQuestion(question) {
  const t = String(question || "").toLowerCase();
  if (!t) return null;

  const labeled = parseLabeledMoney(t, [
    "monthly payment",
    "payment",
    "per month",
    "a month",
    "monthly budget",
    "max payment",
    "payment budget",
    "all-in payment",
    "all in payment",
    "housing payment",
    "monthly housing payment",
    "payment ceiling",
    "target payment"
  ]);
  if (Number.isFinite(labeled)) return labeled;

  let m = t.match(/\bwith\s+a?\s*\$?\s*([0-9][0-9,]*)\s*(?:monthly\s*)?payment\b/i);
  if (m) {
    const n = parseMoneyToken(m[1]);
    if (Number.isFinite(n)) return n;
  }

  m = t.match(/\bunder\s+\$?\s*([0-9][0-9,]*)\s*(?:\/\s*month|per\s*month|monthly)\b/i);
  if (m) {
    const n = parseMoneyToken(m[1]);
    if (Number.isFinite(n)) return n;
  }

  m = t.match(/\b(?:at|around|about)\s+\$?\s*([0-9][0-9,]*)\s*(?:\/\s*month|per\s*month|monthly)\b/i);
  if (m) {
    const n = parseMoneyToken(m[1]);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function parseTermYearsFromQuestion(question) {
  const t = String(question || "").toLowerCase();
  const m = t.match(/\b(10|15|20|25|30|40)\s*[- ]?year\b/);
  if (!m) return null;
  return Math.round(Number(m[1]));
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
    inferred_target_monthly_payment: parseTargetMonthlyPaymentFromQuestion(question),
    inferred_term_years: parseTermYearsFromQuestion(question),
    inferred_bedrooms: parseBedroomsFromQuestion(question),
    inferred_downpayment:
      downObj && Number.isFinite(downObj.amount) ? downObj.amount : null,
    inferred_downpayment_pct:
      downObj && Number.isFinite(downObj.percent) ? downObj.percent : null
  };
}

function detectCoverageLane(question, facts) {
  const q = String(question || "").trim().toLowerCase();

  const asksPaymentToPrice =
    (
      /\bwhat\b.*\bhome price\b/.test(q) ||
      /\bhow much house\b/.test(q) ||
      /\bwhat price\b/.test(q) ||
      /\bmax home price\b/.test(q) ||
      /\bprice range\b/.test(q)
    ) &&
    hasPositiveMoney(facts.inferred_target_monthly_payment);

  const asksMortgagePayment =
    (
      /\bwhat would\b.*\bpayment\b/.test(q) ||
      /\bwhat is\b.*\bpayment\b/.test(q) ||
      /\bmonthly payment\b/.test(q) ||
      /\bmortgage payment\b/.test(q)
    ) &&
    hasPositiveMoney(facts.inferred_price);

  const asksAffordability =
    /\bcan i afford\b|\bafford\b|\bbuying power\b|\bcan i buy\b|\bdti\b/.test(q);

  const asksSeller =
    /\bseller\b|\blist\b|\blisting\b|\bstaging\b|\bpricing my home\b|\bsell my home\b/.test(q);

  const asksInvestor =
    /\binvestor\b|\brental\b|\brent\b|\bcash flow\b|\bcap rate\b|\barv\b|\bbrrrr\b/.test(q);

  const asksMarket =
    /\bmarket\b|\binventory\b|\bdays on market\b|\bdom\b|\bmedian\b|\baverage home price\b|\bavg home price\b|\bhome value\b|\baverage home value\b|\bmedian home price\b|\bmedian price\b|\bprice per sqft\b|\bappreciation\b|\bbedroom\b|\bbedrooms\b|\b2br\b|\b3br\b|\b4br\b|\b5br\b/.test(q);

  if (asksPaymentToPrice) return "payment_to_price";
  if (asksMortgagePayment) return "mortgage_payment_estimate";
  if (asksAffordability) return "affordability_check";
  if (asksSeller) return "seller_strategy";
  if (asksInvestor) return "investor_analysis";
  if (asksMarket) return "market_analysis";

  if (hasPositiveMoney(facts.inferred_target_monthly_payment) && !hasPositiveMoney(facts.inferred_price)) {
    return "payment_to_price";
  }

  if (hasPositiveMoney(facts.inferred_price) && (/\bpayment\b|\bmortgage\b/.test(q))) {
    return "mortgage_payment_estimate";
  }

  return "general_real_estate_guidance";
}

function classifyQuestion(question, facts) {
  const q = String(question || "").trim().toLowerCase();

  if (!q) {
    return {
      intent: "general_real_estate_guidance",
      coverage_lane: "general_real_estate_guidance",
      topic_tags: ["general_guidance"]
    };
  }

  const tags = [];

  if (/\bmortgage\b|\bmonthly payment\b|\bpayment\b|\bapr\b|\binterest rate\b/.test(q)) tags.push("mortgage");
  if (/\bafford\b|\baffordability\b|\bcan i buy\b|\bbuying power\b|\bdti\b/.test(q)) tags.push("affordability");
  if (/\bmarket\b|\binventory\b|\bdays on market\b|\bdom\b|\bmedian\b|\baverage home price\b|\bavg home price\b|\bhome value\b|\baverage home value\b|\bmedian home price\b|\bmedian price\b|\bprice per sqft\b|\bappreciation\b|\bbedroom\b|\bbedrooms\b|\b2br\b|\b3br\b|\b4br\b|\b5br\b/.test(q)) tags.push("market_analysis");
  if (/\binvestor\b|\brental\b|\brent\b|\bbrrrr\b|\bcash flow\b|\bcap rate\b|\barv\b/.test(q)) tags.push("investor");
  if (/\bproperty tax\b|\btaxes\b|\bhomestead\b|\binsurance\b|\bhoa\b/.test(q)) tags.push("ownership_costs");
  if (/\bbuyer\b|\bbuying\b|\boffer\b|\bpreapproval\b|\bclosing costs\b/.test(q)) tags.push("buyer_guidance");
  if (/\bseller\b|\blist\b|\blisting\b|\bstaging\b|\bpricing\b/.test(q)) tags.push("seller_guidance");
  if (/\bcondo\b|\btownhome\b|\bduplex\b|\bmultifamily\b|\bsingle[- ]family\b/.test(q)) tags.push("property_type");
  if (/\btexas\b|\bsan antonio\b|\bmcallen\b|\baustin\b|\bdallas\b|\bhouston\b|\bfort worth\b|\bel paso\b/.test(q)) tags.push("texas_market");
  if (hasPositiveMoney(facts?.inferred_target_monthly_payment)) tags.push("payment_target");
  if (Number.isFinite(facts?.inferred_bedrooms)) tags.push("bedroom_specific");

  const coverage_lane = detectCoverageLane(question, facts);

  let intent = "general_real_estate_guidance";
  if (coverage_lane === "affordability_check") intent = "finance_affordability";
  else if (coverage_lane === "payment_to_price") intent = "finance_payment_to_price";
  else if (coverage_lane === "mortgage_payment_estimate") intent = "finance_mortgage_payment";
  else if (coverage_lane === "market_analysis") intent = "market_analysis";
  else if (coverage_lane === "investor_analysis") intent = "investor_analysis";
  else if (coverage_lane === "seller_strategy") intent = "seller_strategy";
  else if (tags.includes("buyer_guidance")) intent = "buyer_strategy";

  return {
    intent,
    coverage_lane,
    topic_tags: uniq(tags.length ? tags : ["general_guidance"])
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

  const targetMonthlyPayment = num(
    pickFirst(
      overrides.targetMonthlyPayment,
      overrides.monthlyPaymentTarget,
      overrides.paymentTarget,
      scenario.targetMonthlyPayment,
      scenario.monthlyPaymentTarget,
      scenario.paymentTarget,
      questionFacts.inferred_target_monthly_payment
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
  const termYearsRaw = num(
    pickFirst(
      overrides.termYears,
      scenario.termYears,
      scenario.term,
      questionFacts.inferred_term_years
    )
  );
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
  const bedrooms = num(
    pickFirst(
      overrides.bedrooms,
      overrides.beds,
      scenario.bedrooms,
      scenario.beds,
      questionFacts.inferred_bedrooms
    )
  );

  return {
    question: String(body?.question || "").trim(),
    overrides,
    baseline: scenario,
    state,
    price,
    income,
    monthlyExpenses,
    monthlyDebt,
    targetMonthlyPayment,
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
    bedrooms: Number.isFinite(bedrooms) ? Math.round(bedrooms) : null,
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

function buildPaymentToPriceEstimate({
  targetMonthlyPayment,
  apr,
  termYears,
  taxRate,
  taxAnnual,
  insuranceAnnual,
  hoaMonthly,
  pmiMonthly,
  marketPack,
  downpayment,
  downpaymentPct
}) {
  if (!hasPositiveMoney(targetMonthlyPayment)) return null;

  const hoa = Number.isFinite(hoaMonthly) ? hoaMonthly : 0;
  const flatPmi = Number.isFinite(pmiMonthly) ? pmiMonthly : 0;
  const defaultTaxRate = Number.isFinite(taxRate)
    ? taxRate
    : num(pickFirst(
        marketPack?.ownership_costs?.property_tax_rate,
        marketPack?.property_tax_rate
      ));

  const defaultInsuranceAnnual = Number.isFinite(insuranceAnnual)
    ? insuranceAnnual
    : estimateInsuranceAnnual({ insuranceAnnual: null, price: 300000, marketPack });

  const dpPctFromAmount =
    Number.isFinite(downpayment) && hasPositiveMoney(downpayment)
      ? null
      : Number.isFinite(downpaymentPct)
        ? clamp(downpaymentPct / 100, 0, 0.95)
        : 0.10;

  let lo = 50000;
  let hi = 3000000;
  let best = null;

  for (let i = 0; i < 50; i++) {
    const price = (lo + hi) / 2;
    const appliedDown =
      Number.isFinite(downpayment) && downpayment >= 0
        ? downpayment
        : price * (Number.isFinite(dpPctFromAmount) ? dpPctFromAmount : 0.10);

    const mortgage = computeFallbackMortgage({
      price,
      downpayment: appliedDown,
      creditScore: null,
      apr,
      termYears,
      taxRate: defaultTaxRate,
      taxAnnual,
      insuranceAnnual: defaultInsuranceAnnual,
      hoaMonthly: hoa,
      pmiMonthly: flatPmi,
      marketPack
    });

    const allIn = num(mortgage?.all_in_monthly);
    if (!Number.isFinite(allIn)) break;

    if (allIn <= targetMonthlyPayment) {
      best = {
        price,
        allIn,
        downpayment: appliedDown,
        mortgage
      };
      lo = price;
    } else {
      hi = price;
    }
  }

  if (!best) return null;

  const conservative = roundTo(best.price * 0.93, 1000);
  const target = roundTo(best.price, 1000);
  const upper = roundTo(best.price * 1.03, 1000);

  return {
    target_monthly_payment: money(targetMonthlyPayment),
    estimated_price_range: {
      conservative: money(conservative),
      target: money(target),
      upper: money(upper)
    },
    assumptions: {
      apr_used: pct(apr, 5),
      term_years: termYears,
      tax_rate_used: Number.isFinite(defaultTaxRate) ? pct(defaultTaxRate, 5) : null,
      insurance_annual_used: money(defaultInsuranceAnnual),
      hoa_monthly_used: money(hoa),
      pmi_monthly_used: money(flatPmi),
      downpayment_used: money(best.downpayment)
    },
    estimated_mortgage: best.mortgage || null
  };
}

// ------------------------------------------------------------
// //#8 KNOWLEDGE EXTRACTION
// ------------------------------------------------------------
function pickKnowledgeByIntent({ intent, coverage_lane, topic_tags, realtyKnowledge, financeRules }) {
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
  const ownership = realtyKnowledge?.ownership_costs || [];
  const guardrails = uniq([
    ...(Array.isArray(financeRules?.guardrails) ? financeRules.guardrails : []),
    ...(Array.isArray(realtyKnowledge?.guardrails) ? realtyKnowledge.guardrails : [])
  ]);

  if (intent === "finance_affordability") {
    out.finance_points = summarizeArray(financeFaq, 6);
    out.realty_points = summarizeArray(buyerGuide, 4);
  } else if (intent === "finance_payment_to_price") {
    out.finance_points = summarizeArray(financeFaq, 6);
    out.realty_points = uniq([
      ...summarizeArray(buyerGuide, 3),
      ...summarizeArray(ownership, 3)
    ]).slice(0, 6);
  } else if (intent === "finance_mortgage_payment") {
    out.finance_points = summarizeArray(financeFaq, 6);
    out.realty_points = summarizeArray(ownership, 4);
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

  if (topic_tags.includes("ownership_costs") || coverage_lane === "payment_to_price" || coverage_lane === "mortgage_payment_estimate") {
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
      opportunities: [],
      by_bedroom: {}
    };
  }

  const metrics = {
    average_home_value: num(
      pickFirst(
        marketPack?.avg_home_value,
        marketPack?.average_home_value,
        marketPack?.avgHome,
        marketPack?.city_avg_home,
        marketPack?.snapshot?.median_home_price,
        marketPack?.housing?.median_value_owner_occupied
      )
    ),
    median_list_price: num(
      pickFirst(
        marketPack?.market_metrics?.median_list_price,
        marketPack?.metrics?.median_list_price,
        marketPack?.median_list_price,
        marketPack?.housing?.market?.median_listing_price_realtor
      )
    ),
    median_sold_price: num(
      pickFirst(
        marketPack?.market_metrics?.median_sold_price,
        marketPack?.metrics?.median_sold_price,
        marketPack?.median_sold_price,
        marketPack?.housing?.market?.median_sale_price_current,
        marketPack?.housing?.market?.q1_2026?.median_sale_price
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
        marketPack?.days_on_market,
        marketPack?.housing?.market?.average_days_on_market
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
        marketPack?.price_per_sqft,
        marketPack?.housing?.market?.median_listing_price_per_sqft
      )
    ),
    property_tax_rate: num(
      pickFirst(
        marketPack?.ownership_costs?.property_tax_rate,
        marketPack?.property_tax_rate
      )
    )
  };

  const byBedroom =
    marketPack?.by_bedroom && typeof marketPack.by_bedroom === "object"
      ? marketPack.by_bedroom
      : {};

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
    ),
    by_bedroom: byBedroom
  };
}

// ------------------------------------------------------------
// //#9 NEXT ACTION ENGINE
// ------------------------------------------------------------
function buildMissingInputs({ coverage_lane, income, price, downpayment, creditScore, monthlyExpenses, targetMonthlyPayment }) {
  const missing = [];

  if (coverage_lane === "payment_to_price") {
    if (!Number.isFinite(targetMonthlyPayment)) missing.push("targetMonthlyPayment");
    return missing;
  }

  if (coverage_lane === "mortgage_payment_estimate") {
    if (!Number.isFinite(price)) missing.push("price");
    if (!Number.isFinite(downpayment)) missing.push("downpayment");
    if (!Number.isFinite(creditScore)) missing.push("creditScore");
    return missing;
  }

  if (!Number.isFinite(income)) missing.push("income");
  if (!Number.isFinite(monthlyExpenses)) missing.push("monthlyExpenses");
  if (!Number.isFinite(price)) missing.push("price");
  if (!Number.isFinite(downpayment)) missing.push("downpayment");
  if (!Number.isFinite(creditScore)) missing.push("creditScore");

  return missing;
}

function pickNextAction({ intent, coverage_lane, verdict, quick, paymentToPrice, marketSummary, inputs }) {
  if (coverage_lane === "payment_to_price") {
    if (!paymentToPrice) {
      return {
        type: "collect_missing_inputs",
        why: "I need the target monthly payment to convert payment into an estimated home-price range.",
        target: { missing: buildMissingInputs({ coverage_lane, ...inputs }) }
      };
    }

    return {
      type: "shop_in_price_band",
      why: "Use the target band, then tighten taxes, insurance, HOA, and down payment so the payment stays inside your comfort zone.",
      target: {
        price_band: paymentToPrice.estimated_price_range
      }
    };
  }

  if (!verdict || verdict.status === "INSUFFICIENT") {
    return {
      type: "collect_missing_inputs",
      why: "I can tighten this answer as soon as the missing finance inputs are provided.",
      target: { missing: buildMissingInputs({ coverage_lane, ...inputs }) }
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

  const questionFacts = parseQuestionFacts(question);
  const questionInfo = classifyQuestion(question, questionFacts);
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
  // //#11A Mortgage Verification / Estimate
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
  } else if (Number.isFinite(price) && price > 0) {
    mortgage = computeFallbackMortgage({
      price,
      downpayment: Number.isFinite(downpayment) ? downpayment : Math.round(price * 0.10),
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

  // ----------------------------------------------------------
  // //#11B Quick affordability / Payment-to-price
  // ----------------------------------------------------------
  const quick = buildQuickAffordability({
    income,
    monthlyDebt,
    monthlyExpenses,
    apr: aprUsed,
    termYears: sc.termYears,
    financeRules: packs.financeRules
  });

  const paymentToPrice = buildPaymentToPriceEstimate({
    targetMonthlyPayment: sc.targetMonthlyPayment,
    apr: aprUsed,
    termYears: sc.termYears,
    taxRate: sc.taxRate,
    taxAnnual: sc.taxAnnual,
    insuranceAnnual: sc.insuranceAnnual,
    hoaMonthly: sc.hoaMonthly,
    pmiMonthly: sc.pmiMonthly,
    marketPack,
    downpayment: sc.downpayment,
    downpaymentPct: questionFacts.inferred_downpayment_pct
  });

  // ----------------------------------------------------------
  // //#11C Coverage-lane-specific verdict
  // ----------------------------------------------------------
  let verdict = null;

  if (questionInfo.coverage_lane === "payment_to_price") {
    if (!paymentToPrice) {
      verdict = {
        status: "INSUFFICIENT",
        grade: "N/A",
        residual: null,
        ratios: {
          housing_ratio: null,
          debt_ratio: null,
          total_fixed_ratio: null
        },
        notes: ["Missing target monthly payment; cannot convert payment into an estimated home-price range."]
      };
    } else {
      verdict = {
        status: "GREEN",
        grade: "B",
        residual: null,
        ratios: {
          housing_ratio: null,
          debt_ratio: null,
          total_fixed_ratio: null
        },
        notes: ["This estimate converts your target monthly payment into an approximate purchase-price band using current assumptions for rate, taxes, insurance, and monthly carrying costs."]
      };
    }
  } else {
    verdict = computeAffordabilityVerdict({
      income,
      monthlyExpenses,
      monthlyDebt,
      housingAllIn: mortgage?.all_in_monthly || null,
      financeRules: packs.financeRules
    });
  }

  // ----------------------------------------------------------
  // //#11D Knowledge + action
  // ----------------------------------------------------------
  const knowledge = pickKnowledgeByIntent({
    intent: questionInfo.intent,
    coverage_lane: questionInfo.coverage_lane,
    topic_tags: questionInfo.topic_tags,
    realtyKnowledge: packs.realtyKnowledge,
    financeRules: packs.financeRules
  });

  const next_action = pickNextAction({
    intent: questionInfo.intent,
    coverage_lane: questionInfo.coverage_lane,
    verdict,
    quick,
    paymentToPrice,
    marketSummary,
    inputs: {
      income,
      monthlyExpenses,
      monthlyDebt,
      price,
      downpayment,
      creditScore,
      targetMonthlyPayment: sc.targetMonthlyPayment
    }
  });

  // ----------------------------------------------------------
  // //#11E Bedroom context
  // ----------------------------------------------------------
  const requestedBedrooms = Number.isFinite(sc.bedrooms)
    ? sc.bedrooms
    : Number.isFinite(questionFacts?.inferred_bedrooms)
      ? questionFacts.inferred_bedrooms
      : null;

  const bedroomContext = Number.isFinite(requestedBedrooms)
    ? {
        requested_bedrooms: requestedBedrooms,
        market_slice:
          marketSummary?.by_bedroom?.[String(requestedBedrooms)] || null
      }
    : null;

  // ----------------------------------------------------------
  // //#11F Answer packet
  // ----------------------------------------------------------
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
    coverage_lane: questionInfo.coverage_lane,
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
          risks: marketSummary.risks,
          by_bedroom: marketSummary.by_bedroom || {}
        }
      : null,
    bedroom_context: bedroomContext,
    finance_context: {
      income: money(income),
      monthly_expenses: money(monthlyExpenses),
      monthly_debt: money(monthlyDebt),
      target_monthly_payment: money(sc.targetMonthlyPayment),
      estimated_housing_payment: money(mortgage?.all_in_monthly),
      residual: money(verdict?.residual),
      quick_buying_power: quick?.quick_max_price || null,
      payment_to_price_range: paymentToPrice?.estimated_price_range || null
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
    coverage_lane: questionInfo.coverage_lane,
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
      targetMonthlyPayment: money(sc.targetMonthlyPayment),
      price: money(price),
      downpayment: money(downpayment),
      creditScore: Number.isFinite(creditScore) ? creditScore : null,
      apr_used: pct(aprUsed, 5),
      termYears: sc.termYears,
      bedrooms: Number.isFinite(requestedBedrooms) ? requestedBedrooms : null,
      propertyType: sc.propertyType,
      occupancy: sc.occupancy,
      strategy: sc.strategy,
      sources: {
        profile: profileResult.source,
        income: Number.isFinite(sc.income) ? "request/question" : Number.isFinite(profileIncome) ? "profile" : "missing",
        monthlyExpenses: Number.isFinite(sc.monthlyExpenses) ? "request/question" : "missing",
        monthlyDebt: Number.isFinite(sc.monthlyDebt) ? "request/question" : "missing",
        targetMonthlyPayment: Number.isFinite(sc.targetMonthlyPayment) ? "request/question" : "missing",
        price: Number.isFinite(sc.price) ? "request/question" : "missing",
        downpayment: Number.isFinite(sc.downpayment) ? "request/question" : "missing",
        creditScore: Number.isFinite(sc.creditScore) ? "request/question" : "missing",
        bedrooms: Number.isFinite(requestedBedrooms) ? "request/question" : "missing",
        market: marketPack ? "local_json" : "not_found",
        mortgage: mortgageSource
      }
    },
    affordability: quick || null,
    payment_to_price: paymentToPrice || null,
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
    const marketFileCandidates = marketSlug ? buildMarketFileCandidates(marketSlug) : [];
    payload.debug = {
      API_BASE,
      cwd: process.cwd(),
      dirname: __dirname,
      data_dir: DATA_DIR,
      profile_found: !!profile,
      question_facts: questionFacts,
      market_resolution: marketResolution,
      market_slug: marketSlug,
      market_file_loaded: !!marketPack,
      market_file_candidates: marketFileCandidates,
      market_file_exists_checks: marketSlug ? {
        texas: fileExists(path.join(DATA_DIR, "markets", "texas", `${marketSlug}.json`)),
        markets_root: fileExists(path.join(DATA_DIR, "markets", `${marketSlug}.json`)),
        data_root: fileExists(path.join(DATA_DIR, `${marketSlug}.json`))
      } : null,
      requested_bedrooms: requestedBedrooms,
      bedroom_slice_found: !!(bedroomContext && bedroomContext.market_slice),
      mortgage_api_status: mortgageApiStatus,
      mortgage_payload_sent: mortgagePayload,
      finance_rule_keys: Object.keys(packs.financeRules || {}),
      core_keys: Object.keys(packs.core || {}),
      realty_knowledge_keys: Object.keys(packs.realtyKnowledge || {})
    };
  }

  return respond(200, payload, origin);
};

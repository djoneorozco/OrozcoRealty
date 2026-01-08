// netlify/functions/mortgage.js
// ============================================================
// OrozcoRealty.ai • Mortgage Engine (Standalone) v1.0.0
// PURPOSE:
// - Deterministic mortgage breakdown for dashboards (Webflow-safe)
// - Central source of truth for: APR, P&I, Tax, Insurance, HOA, PMI, All-in
//
// ENDPOINT:
//   POST /.netlify/functions/mortgage
//   POST /api/mortgage   (if using your netlify.toml redirect)
//
// INPUT (POST JSON) examples:
// {
//   "price": 275000,
//   "down": 25000,                // amount OR percent (if <=1 treated as fraction, if <=100 treated as percent)
//   "creditScore": 720,
//   "termYears": 30,
//
//   "taxRate": 0.021,             // optional (fraction). If omitted, can use taxAnnual.
//   "taxAnnual": 0,               // optional alternative
//
//   "insuranceAnnual": 1800,      // optional
//   "hoaMonthly": 0,              // optional
//
//   "loanType": "conventional",   // conventional | fha | va
//   "aprOverride": null,          // optional (e.g., 6.5)
//   "pmiRate": 0.0075,            // optional (annual fraction)
//   "pmiMonthlyOverride": null    // optional
// }
//
// OUTPUT:
// {
//   ok: true,
//   inputs: {...normalized},
//   apr: 6.50,
//   termYears: 30,
//   price: 275000,
//   downPayment: 25000,
//   downPercent: 9.09,
//   loanAmount: 250000,
//   breakdown: { pi, tax, insurance, hoa, pmi, allIn },
//   meta: { aprSource, pmiApplied, warnings: [...] }
// }
// ============================================================

// ============================================================
// //#1 — CORS + helpers
// ============================================================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

function j(statusCode, obj){
  return {
    statusCode,
    headers: { "Content-Type":"application/json; charset=utf-8", ...corsHeaders },
    body: JSON.stringify(obj, null, 2)
  };
}

function num(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function clamp(n, lo, hi){
  return Math.max(lo, Math.min(hi, n));
}

function round2(n){
  return Math.round(n * 100) / 100;
}

// ============================================================
// //#2 — APR model (deterministic tiers)
// You can tune these later; keep it stable for identical inputs.
// ============================================================
function aprFromCreditScore(score){
  const s = clamp(Math.floor(num(score) || 0), 300, 850);

  // TIERED APR (example defaults — tune as you like)
  // Returned as percent (e.g., 6.5 means 6.5%)
  if (s >= 780) return 6.25;
  if (s >= 760) return 6.35;
  if (s >= 740) return 6.50;
  if (s >= 720) return 6.65;
  if (s >= 700) return 6.85;
  if (s >= 680) return 7.10;
  if (s >= 660) return 7.35;
  if (s >= 640) return 7.75;
  return 8.25;
}

// ============================================================
// //#3 — Core math
// ============================================================
function mortgagePI(loanAmount, aprPercent, termYears){
  const P = num(loanAmount);
  const apr = num(aprPercent);
  const years = num(termYears);

  if (!Number.isFinite(P) || P <= 0) return 0;
  if (!Number.isFinite(apr) || apr <= 0) return 0;
  if (!Number.isFinite(years) || years <= 0) return 0;

  const r = (apr / 100) / 12;     // monthly interest rate
  const n = Math.round(years * 12);

  // Amortization formula: P * r * (1+r)^n / ((1+r)^n - 1)
  const pow = Math.pow(1 + r, n);
  const payment = P * r * pow / (pow - 1);

  return Number.isFinite(payment) ? payment : 0;
}

function normalizeDown(price, downRaw){
  const p = num(price);
  const d = num(downRaw);

  if (!Number.isFinite(p) || p <= 0) return { downPayment: 0, downPercent: 0, downSource: "none" };
  if (!Number.isFinite(d) || d <= 0) return { downPayment: 0, downPercent: 0, downSource: "none" };

  // If user passes <=1 => treat as fraction (0.1 = 10%)
  if (d > 0 && d <= 1){
    const downPayment = p * d;
    return { downPayment, downPercent: d * 100, downSource: "fraction" };
  }

  // If user passes <=100 => treat as percent
  if (d > 1 && d <= 100){
    const frac = d / 100;
    const downPayment = p * frac;
    return { downPayment, downPercent: d, downSource: "percent" };
  }

  // Else treat as dollar amount
  const downPayment = d;
  const downPercent = (d / p) * 100;
  return { downPayment, downPercent, downSource: "amount" };
}

function computePMI({
  loanType,
  downPercent,
  loanAmount,
  pmiRate,
  pmiMonthlyOverride
}){
  const warnings = [];

  const lt = String(loanType || "conventional").toLowerCase();
  const dp = num(downPercent);
  const LA = num(loanAmount);

  // Explicit override wins
  const override = num(pmiMonthlyOverride);
  if (Number.isFinite(override) && override >= 0){
    return { pmiMonthly: override, pmiApplied: override > 0, warnings };
  }

  // VA typically no PMI (funding fee is separate; not modeled here)
  if (lt === "va"){
    return { pmiMonthly: 0, pmiApplied: false, warnings };
  }

  // If down >= 20% => no PMI
  if (Number.isFinite(dp) && dp >= 20){
    return { pmiMonthly: 0, pmiApplied: false, warnings };
  }

  // Otherwise compute PMI with annual rate
  const pr = num(pmiRate);
  const rate = Number.isFinite(pr) && pr >= 0 ? pr : 0.0075; // default 0.75% annual
  if (!Number.isFinite(LA) || LA <= 0){
    warnings.push("PMI: loanAmount invalid, PMI forced to 0.");
    return { pmiMonthly: 0, pmiApplied: false, warnings };
  }

  const pmiMonthly = (LA * rate) / 12;
  return { pmiMonthly, pmiApplied: pmiMonthly > 0, warnings };
}

// ============================================================
// //#4 — Netlify handler
// ============================================================
export async function handler(event) {
  try{
    if (event.httpMethod === "OPTIONS"){
      return { statusCode: 204, headers: corsHeaders, body: "" };
    }

    if (event.httpMethod !== "POST"){
      return j(405, { ok:false, error:"Method not allowed. Use POST." });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const warnings = [];

    const price = num(body.price);
    if (!Number.isFinite(price) || price <= 0){
      return j(400, { ok:false, error:"Missing/invalid 'price' (must be > 0)." });
    }

    const termYears = Number.isFinite(num(body.termYears)) ? clamp(num(body.termYears), 5, 40) : 30;

    const { downPayment, downPercent, downSource } = normalizeDown(price, body.down);
    const dp = clamp(downPayment, 0, price);
    const dpct = clamp(downPercent, 0, 100);

    const loanAmount = Math.max(0, price - dp);

    // APR: override > model by credit score
    const aprOverride = num(body.aprOverride);
    const creditScore = Number.isFinite(num(body.creditScore)) ? clamp(num(body.creditScore), 300, 850) : NaN;

    let apr = 0;
    let aprSource = "unknown";

    if (Number.isFinite(aprOverride) && aprOverride > 0){
      apr = aprOverride;
      aprSource = "override";
    } else if (Number.isFinite(creditScore)){
      apr = aprFromCreditScore(creditScore);
      aprSource = "creditScoreTiers";
    } else {
      apr = 6.75; // deterministic fallback
      aprSource = "defaultFallback";
      warnings.push("APR: creditScore missing; used defaultFallback.");
    }

    // Monthly components
    const pi = mortgagePI(loanAmount, apr, termYears);

    // Tax: taxRate (fraction) OR taxAnnual
    const taxRate = num(body.taxRate);
    const taxAnnual = num(body.taxAnnual);
    let taxMonthly = 0;

    if (Number.isFinite(taxAnnual) && taxAnnual >= 0){
      taxMonthly = taxAnnual / 12;
    } else if (Number.isFinite(taxRate) && taxRate >= 0){
      taxMonthly = (price * taxRate) / 12;
    } else {
      // Safe default if nothing provided
      taxMonthly = (price * 0.02) / 12; // 2% default placeholder
      warnings.push("Tax: taxRate/taxAnnual missing; used default 2%/yr.");
    }

    const insuranceAnnual = num(body.insuranceAnnual);
    const insuranceMonthly = (Number.isFinite(insuranceAnnual) && insuranceAnnual >= 0)
      ? (insuranceAnnual / 12)
      : (1500 / 12); // default $1500/yr
    if (!Number.isFinite(insuranceAnnual)) warnings.push("Insurance: insuranceAnnual missing; used default $1500/yr.");

    const hoaMonthly = Number.isFinite(num(body.hoaMonthly)) ? Math.max(0, num(body.hoaMonthly)) : 0;

    const { pmiMonthly, pmiApplied, warnings: pmiWarnings } = computePMI({
      loanType: body.loanType,
      downPercent: dpct,
      loanAmount,
      pmiRate: body.pmiRate,
      pmiMonthlyOverride: body.pmiMonthlyOverride
    });
    warnings.push(...pmiWarnings);

    const allIn = pi + taxMonthly + insuranceMonthly + hoaMonthly + pmiMonthly;

    // Output
    return j(200, {
      ok: true,
      version: "1.0.0",
      inputs: {
        price: round2(price),
        downRaw: body.down ?? null,
        downSource,
        creditScore: Number.isFinite(creditScore) ? creditScore : null,
        termYears,
        loanType: String(body.loanType || "conventional").toLowerCase(),
        taxRate: Number.isFinite(taxRate) ? taxRate : null,
        taxAnnual: Number.isFinite(taxAnnual) ? taxAnnual : null,
        insuranceAnnual: Number.isFinite(insuranceAnnual) ? insuranceAnnual : null,
        hoaMonthly: round2(hoaMonthly),
        aprOverride: Number.isFinite(aprOverride) ? aprOverride : null,
        pmiRate: Number.isFinite(num(body.pmiRate)) ? num(body.pmiRate) : null,
        pmiMonthlyOverride: Number.isFinite(num(body.pmiMonthlyOverride)) ? num(body.pmiMonthlyOverride) : null
      },
      apr: round2(apr),
      aprSource,
      termYears,
      price: round2(price),
      downPayment: round2(dp),
      downPercent: round2(dpct),
      loanAmount: round2(loanAmount),
      breakdown: {
        pi: round2(pi),
        tax: round2(taxMonthly),
        insurance: round2(insuranceMonthly),
        hoa: round2(hoaMonthly),
        pmi: round2(pmiMonthly),
        allIn: round2(allIn)
      },
      meta: {
        pmiApplied,
        warnings
      }
    });

  } catch (e){
    return j(500, { ok:false, error:"Server error", detail: String(e?.message || e) });
  }
}

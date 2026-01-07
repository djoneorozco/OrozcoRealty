// netlify/functions/bluf.js
// ============================================================
// OrozcoRealty.ai • BLUF Engine (Deterministic) v1.0.0
// PURPOSE:
// - Produce an authoritative, analyst-style BLUF (NO OpenAI)
// - Deterministic verdict + metrics + drivers + actions
// - Accounts for:
//   ✅ Mortgage vs BAH gap
//   ✅ Disposable buffer ($ and %)
//   ✅ Housing burden ratio
//   ✅ Optional DTI (if debt provided)
//   ✅ Optional reserves (if savings provided)
//
// CLIENT (recommended):
//   POST https://theorozcorealty.netlify.app/api/bluf
//   body: {
//     income, expenses, housingMonthly,
//     bah?, debt?, savings?, rank_paygrade?, creditScore?,
//     price?, downpayment?, aprPercent?, termYears?
//   }
//
// RETURNS:
//   { verdict, grade, bluf, metrics, drivers, actions, thresholds, inputs_used }
//
// NOTE:
// - This function DOES NOT compute mortgage. It consumes housingMonthly.
//   (Your UI / brain can compute mortgageMonthly; BLUF consumes it.)
// ============================================================

/* ============================================================
   //#1 — CORS (matches your environment)
============================================================ */
const ALLOW_ORIGINS = [
  "https://theorozcorealty.com",
  "https://www.theorozcorealty.com",
  "https://new-real-estate-purchase.webflow.io",
  "https://www.new-real-estate-purchase.webflow.io",
  "https://theorozcorealty.netlify.app",
  "http://localhost:8888",
];

function corsHeaders(origin) {
  const o = String(origin || "").trim();
  const allow = ALLOW_ORIGINS.includes(o) ? o : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Content-Type": "application/json",
  };
}

function respond(statusCode, headers, payload) {
  return { statusCode, headers, body: JSON.stringify(payload || {}) };
}

/* ============================================================
   //#2 — Utilities
============================================================ */
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function money(val) {
  const x = n(val);
  return x.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function pct(val, digits = 0) {
  const x = n(val) * 100;
  if (!Number.isFinite(x)) return "—";
  return `${x.toFixed(digits)}%`;
}
function safeStr(x) {
  const s = String(x ?? "").trim();
  return s || "";
}
function round0(x) {
  const v = n(x);
  return Math.round(v);
}

/* ============================================================
   //#3 — Threshold model (scales with income)
   Goal: higher income = slightly more flexibility on ratios,
   but still enforces a minimum absolute buffer.
============================================================ */
function computeThresholds(income) {
  const inc = n(income);

  // Buffer % target scales with income:
  // - Lower income needs a bigger cushion (unexpected costs hit harder)
  // - Higher income can tolerate slightly lower % cushion
  const minBufferPct =
    inc <= 0 ? 0.08 :
    inc < 6000 ? 0.10 :
    inc < 10000 ? 0.08 :
    0.06;

  // Minimum buffer dollars: never below $600
  const minBufferAbs = Math.max(600, inc * minBufferPct);

  // Housing ratio guardrails (PITI/Income):
  // Keep it conservative; widen slightly for higher income
  const housingGreenMax =
    inc <= 0 ? 0.30 :
    inc < 6000 ? 0.28 :
    inc < 10000 ? 0.30 :
    0.32;

  const housingNoGoMin =
    inc <= 0 ? 0.35 :
    inc < 6000 ? 0.33 :
    inc < 10000 ? 0.35 :
    0.36;

  // BAH coverage thresholds (if BAH provided)
  const bahGreenMin = 0.90;
  const bahCautionMin = 0.75;

  // BAH gap as % of income (if BAH provided)
  // If mortgage exceeds BAH by too much, it strains cash flow.
  const bahGapCautionPct = 0.06; // 6% of income
  const bahGapNoGoPct = 0.12;    // 12% of income

  // DTI thresholds (if debt provided): (housing + debt) / income
  // QM-ish guardrail: >43% is typically "no-go" territory.
  const dtiCautionMin = 0.36;
  const dtiNoGoMin = 0.43;

  // Reserves (months) thresholds (if savings provided)
  const reservesCautionMin = 1.0;  // <1 month = caution
  const reservesNoGoMin = 0.5;     // <0.5 month = no-go

  return {
    minBufferPct,
    minBufferAbs,
    housingGreenMax,
    housingNoGoMin,
    bahGreenMin,
    bahCautionMin,
    bahGapCautionPct,
    bahGapNoGoPct,
    dtiCautionMin,
    dtiNoGoMin,
    reservesCautionMin,
    reservesNoGoMin,
  };
}

/* ============================================================
   //#4 — Driver builder (explains verdict)
============================================================ */
function addDriver(drivers, code, label, severity, detail) {
  drivers.push({
    code,
    label,
    severity, // "no_go" | "caution" | "info"
    ...detail,
  });
}

function sortDrivers(drivers) {
  const w = { no_go: 3, caution: 2, info: 1 };
  return drivers.sort((a, b) => (w[b.severity] || 0) - (w[a.severity] || 0));
}

/* ============================================================
   //#5 — Template engine (deterministic)
   NOTE: We pick the BLUF based on the top driver + verdict.
============================================================ */
function buildBLUF({ verdict, metrics, topDriver }) {
  const m = metrics;
  const d = topDriver?.code || "general";

  const head =
    verdict === "NO_GO" ? "NO-GO" :
    verdict === "CAUTION" ? "CAUTION" :
    "GREEN LIGHT";

  // Micro-phrases (keep it sharp and analyst-like)
  const gapLine = (m.hasBAH)
    ? `Your payment is ${money(m.bahGap)} ${m.bahGap >= 0 ? "above" : "below"} BAH.`
    : "";

  const bufferLine = `Projected buffer: ${money(m.bufferAfterHousing)} / mo (${pct(m.bufferPct, 0)} of income).`;

  // Deterministic templates keyed by driver
  const templates = {
    NO_GO: {
      over_housing_ratio: `${head}: Payment-to-income is ${pct(m.housingRatio, 0)} which exceeds the affordability band. ${bufferLine}`,
      negative_buffer: `${head}: This deal runs cash-flow negative after housing. ${bufferLine}`,
      over_bah_gap: `${head}: The payment overshoots BAH by ${money(m.bahGap)} and squeezes your monthly buffer. ${gapLine} ${bufferLine}`,
      high_dti: `${head}: Your total debt load is too high for safe approval and stability. DTI is ${pct(m.dti, 0)}. ${bufferLine}`,
      low_reserves: `${head}: Your cash reserves are too thin to absorb surprises. Reserves are ~${m.reservesMonths.toFixed(1)} months. ${bufferLine}`,
      general: `${head}: Based on the cash-flow and ratio checks, this purchase is not financially safe as structured. ${bufferLine} ${gapLine}`.trim(),
    },
    CAUTION: {
      thin_buffer: `${head}: This is technically possible, but the buffer is tight. ${bufferLine} Keep at least ${money(m.minBufferAbs)} in monthly margin.`,
      close_housing_ratio: `${head}: You’re near the top of the safe range. Payment-to-income is ${pct(m.housingRatio, 0)}. ${bufferLine}`,
      moderate_bah_gap: `${head}: The payment is outpacing BAH enough to warrant caution. ${gapLine} ${bufferLine}`,
      dti_watch: `${head}: Debt-to-income is getting crowded. DTI is ${pct(m.dti, 0)}. ${bufferLine}`,
      reserves_watch: `${head}: Reserves are light for a purchase of this size (~${m.reservesMonths.toFixed(1)} months). ${bufferLine}`,
      general: `${head}: Numbers say “proceed carefully.” ${bufferLine} ${gapLine}`.trim(),
    },
    GREEN: {
      strong_buffer: `${head}: Your cash-flow supports this payment with room to breathe. ${bufferLine} Payment-to-income: ${pct(m.housingRatio, 0)}.`,
      bah_supported: `${head}: This payment is well-supported by your BAH and cash-flow. ${gapLine} ${bufferLine}`,
      balanced: `${head}: This is within the safe affordability bands. ${bufferLine} Payment-to-income: ${pct(m.housingRatio, 0)}.`,
      general: `${head}: This looks financially viable under the current assumptions. ${bufferLine} ${gapLine}`.trim(),
    }
  };

  // Deterministic routing
  if (verdict === "NO_GO") {
    if (d === "over_housing_ratio") return templates.NO_GO.over_housing_ratio;
    if (d === "negative_buffer") return templates.NO_GO.negative_buffer;
    if (d === "over_bah_gap") return templates.NO_GO.over_bah_gap;
    if (d === "high_dti") return templates.NO_GO.high_dti;
    if (d === "low_reserves") return templates.NO_GO.low_reserves;
    return templates.NO_GO.general;
  }

  if (verdict === "CAUTION") {
    if (d === "thin_buffer") return templates.CAUTION.thin_buffer;
    if (d === "close_housing_ratio") return templates.CAUTION.close_housing_ratio;
    if (d === "moderate_bah_gap") return templates.CAUTION.moderate_bah_gap;
    if (d === "dti_watch") return templates.CAUTION.dti_watch;
    if (d === "reserves_watch") return templates.CAUTION.reserves_watch;
    return templates.CAUTION.general;
  }

  // GREEN
  if (d === "strong_buffer") return templates.GREEN.strong_buffer;
  if (d === "bah_supported") return templates.GREEN.bah_supported;
  if (d === "balanced") return templates.GREEN.balanced;
  return templates.GREEN.general;
}

/* ============================================================
   //#6 — Action generator (deterministic)
============================================================ */
function buildActions(verdict, metrics) {
  const m = metrics;
  const actions = [];

  // Always useful
  actions.push("Validate the mortgage payment includes taxes + insurance + HOA (all-in).");

  if (verdict === "NO_GO" || verdict === "CAUTION") {
    // Biggest levers
    actions.push(`Reduce payment by targeting ${money(Math.max(0, m.housingMonthly - m.housingTarget))}/mo (price, rate, HOA, or buy-down).`);
    actions.push(`Raise monthly buffer to at least ${money(m.minBufferAbs)} (reduce expenses or increase income).`);
  }

  if (m.hasBAH) {
    if (m.bahGap > 0) actions.push(`Close the BAH gap: aim for payment at or below BAH (${money(m.bah)}).`);
    else actions.push("BAH already covers the payment; focus on keeping buffer healthy after all non-housing expenses.");
  } else {
    actions.push("Add BAH (or location ZIP) to tighten the military-specific affordability view.");
  }

  if (m.hasDebt) {
    if (m.dti >= m.dtiCautionMin) actions.push("Pay down or restructure monthly debts to reduce DTI before locking a home payment.");
  }

  if (m.hasSavings) {
    if (m.reservesMonths < 1.0) actions.push("Build at least 1–2 months of reserves after closing costs.");
  } else {
    actions.push("Include savings to estimate reserves and improve risk scoring.");
  }

  return actions.slice(0, 6);
}

/* ============================================================
   //#7 — Core evaluator (verdict + drivers)
============================================================ */
function evaluate(payload) {
  // Inputs (required)
  const income = n(payload.income);
  const expenses = n(payload.expenses);
  const housingMonthly = n(payload.housingMonthly);

  // Optional inputs
  const bah = n(payload.bah);
  const debt = n(payload.debt);
  const savings = n(payload.savings);

  const thresholds = computeThresholds(income);

  // Guardrails
  const missing = [];
  if (income <= 0) missing.push("income");
  if (housingMonthly <= 0) missing.push("housingMonthly");
  if (expenses < 0) missing.push("expenses");
  if (missing.length) {
    return {
      ok: false,
      error: `Missing/invalid required fields: ${missing.join(", ")}`,
      needed: ["income", "expenses", "housingMonthly"],
    };
  }

  // Core metrics
  const bufferAfterHousing = income - expenses - housingMonthly;
  const bufferPct = income > 0 ? (bufferAfterHousing / income) : 0;

  const housingRatio = income > 0 ? (housingMonthly / income) : 0;

  const hasBAH = bah > 0;
  const bahGap = hasBAH ? (housingMonthly - bah) : 0;
  const bahCoverage = hasBAH ? (bah / housingMonthly) : 0; // 0..1+

  const hasDebt = debt > 0;
  const dti = (income > 0) ? ((housingMonthly + debt) / income) : 0;

  const hasSavings = savings > 0;
  const monthlyBurn = Math.max(1, expenses + housingMonthly + debt);
  const reservesMonths = hasSavings ? (savings / monthlyBurn) : 0;

  // Targets
  const housingTarget = income * thresholds.housingGreenMax; // "green band" target payment
  const minBufferAbs = thresholds.minBufferAbs;

  // Driver scoring
  const drivers = [];

  // NO-GO conditions
  if (bufferAfterHousing < 0) {
    addDriver(drivers, "negative_buffer", "Negative cash-flow after housing", "no_go", {
      value: round0(bufferAfterHousing),
      threshold: 0,
      unit: "usd_per_month",
    });
  }

  if (housingRatio > thresholds.housingNoGoMin) {
    addDriver(drivers, "over_housing_ratio", "Payment-to-income exceeds safe ceiling", "no_go", {
      value: housingRatio,
      threshold: thresholds.housingNoGoMin,
      unit: "ratio",
    });
  }

  if (hasBAH) {
    const gapPctIncome = income > 0 ? (bahGap / income) : 0;
    if (gapPctIncome > thresholds.bahGapNoGoPct) {
      addDriver(drivers, "over_bah_gap", "Mortgage-to-BAH gap is too large", "no_go", {
        value: gapPctIncome,
        threshold: thresholds.bahGapNoGoPct,
        unit: "ratio_of_income",
      });
    }
    if (bahCoverage > 0 && bahCoverage < thresholds.bahCautionMin) {
      // Treat as NO-GO if BAH coverage is very low and gap is meaningful
      addDriver(drivers, "over_bah_gap", "BAH covers too little of the payment", "no_go", {
        value: bahCoverage,
        threshold: thresholds.bahCautionMin,
        unit: "bah_coverage",
      });
    }
  }

  if (hasDebt && dti > thresholds.dtiNoGoMin) {
    addDriver(drivers, "high_dti", "DTI exceeds safe approval band", "no_go", {
      value: dti,
      threshold: thresholds.dtiNoGoMin,
      unit: "ratio",
    });
  }

  if (hasSavings && reservesMonths < thresholds.reservesNoGoMin) {
    addDriver(drivers, "low_reserves", "Reserves are dangerously thin", "no_go", {
      value: reservesMonths,
      threshold: thresholds.reservesNoGoMin,
      unit: "months",
    });
  }

  // CAUTION conditions (only if not already no-go)
  const anyNoGo = drivers.some((d) => d.severity === "no_go");
  if (!anyNoGo) {
    if (bufferAfterHousing < minBufferAbs) {
      addDriver(drivers, "thin_buffer", "Monthly buffer is below target", "caution", {
        value: round0(bufferAfterHousing),
        threshold: round0(minBufferAbs),
        unit: "usd_per_month",
      });
    }

    if (housingRatio > thresholds.housingGreenMax) {
      addDriver(drivers, "close_housing_ratio", "Payment-to-income is near the top of the safe range", "caution", {
        value: housingRatio,
        threshold: thresholds.housingGreenMax,
        unit: "ratio",
      });
    }

    if (hasBAH) {
      const gapPctIncome = income > 0 ? (bahGap / income) : 0;
      if (gapPctIncome > thresholds.bahGapCautionPct) {
        addDriver(drivers, "moderate_bah_gap", "Mortgage-to-BAH gap is meaningful", "caution", {
          value: gapPctIncome,
          threshold: thresholds.bahGapCautionPct,
          unit: "ratio_of_income",
        });
      }
      if (bahCoverage > 0 && bahCoverage < thresholds.bahGreenMin) {
        addDriver(drivers, "moderate_bah_gap", "BAH coverage is below preferred support", "caution", {
          value: bahCoverage,
          threshold: thresholds.bahGreenMin,
          unit: "bah_coverage",
        });
      }
    }

    if (hasDebt && dti >= thresholds.dtiCautionMin) {
      addDriver(drivers, "dti_watch", "DTI is elevated", "caution", {
        value: dti,
        threshold: thresholds.dtiCautionMin,
        unit: "ratio",
      });
    }

    if (hasSavings && reservesMonths < thresholds.reservesCautionMin) {
      addDriver(drivers, "reserves_watch", "Reserves are light", "caution", {
        value: reservesMonths,
        threshold: thresholds.reservesCautionMin,
        unit: "months",
      });
    }
  }

  // Verdict
  let verdict = "GREEN";
  if (drivers.some((d) => d.severity === "no_go")) verdict = "NO_GO";
  else if (drivers.some((d) => d.severity === "caution")) verdict = "CAUTION";

  // Grade (simple + clear)
  const grade =
    verdict === "GREEN" ? (bufferAfterHousing >= (minBufferAbs * 1.5) ? "A" : "B") :
    verdict === "CAUTION" ? "C" :
    "D";

  const ordered = sortDrivers(drivers);
  const topDriver = ordered[0] || { code: "balanced", severity: "info" };

  const metrics = {
    income,
    expenses,
    housingMonthly,
    housingRatio,
    housingTarget,
    bufferAfterHousing,
    bufferPct,
    minBufferAbs,
    hasBAH,
    bah,
    bahGap,
    bahCoverage,
    hasDebt,
    debt,
    dti,
    hasSavings,
    savings,
    reservesMonths,
    // include thresholds for transparency
    ...thresholds,
  };

  const bluf = buildBLUF({ verdict, metrics, topDriver });
  const actions = buildActions(verdict, metrics);

  // Light “facts” summary (used by UI if desired)
  const driversSlim = ordered.slice(0, 4).map((d) => ({
    code: d.code,
    label: d.label,
    severity: d.severity,
    value: d.unit === "usd_per_month" ? money(d.value) :
           d.unit === "months" ? `${n(d.value).toFixed(1)} mo` :
           (d.unit === "bah_coverage" || d.unit === "ratio" || d.unit === "ratio_of_income") ? pct(d.value, 0) :
           String(d.value),
    threshold: d.unit === "usd_per_month" ? money(d.threshold) :
               d.unit === "months" ? `${n(d.threshold).toFixed(1)} mo` :
               (d.unit === "bah_coverage" || d.unit === "ratio" || d.unit === "ratio_of_income") ? pct(d.threshold, 0) :
               String(d.threshold),
  }));

  return {
    ok: true,
    verdict,
    grade,
    bluf,
    metrics,
    drivers: driversSlim,
    actions,
    thresholds,
    inputs_used: {
      income,
      expenses,
      housingMonthly,
      bah: hasBAH ? bah : null,
      debt: hasDebt ? debt : null,
      savings: hasSavings ? savings : null,
      rank_paygrade: safeStr(payload.rank_paygrade) || null,
      creditScore: n(payload.creditScore) || null,
    },
  };
}

/* ============================================================
   //#8 — Netlify handler (ESM)
============================================================ */
export const handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return respond(204, headers, {});
  if (event.httpMethod !== "POST") return respond(405, headers, { error: "Method Not Allowed" });

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, headers, { error: "Invalid JSON body" });
  }

  const out = evaluate(payload);
  if (!out.ok) {
    return respond(200, headers, {
      ok: false,
      error: out.error || "Invalid inputs",
      needed: out.needed || ["income", "expenses", "housingMonthly"],
      example_body: {
        income: 9500,
        expenses: 4200,
        housingMonthly: 3100,
        bah: 2600,
        debt: 450,
        savings: 18000,
        rank_paygrade: "E-6",
        creditScore: 720,
      },
    });
  }

  return respond(200, headers, out);
};

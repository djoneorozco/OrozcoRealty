// netlify/functions/right-model.js
// ============================================================
// OrozcoRealty.ai • "The Right Model" (Option A) — v1.0
// PURPOSE:
// - Deterministic model that combines:
//   (1) Military Pay (Base Pay + BAS + BAH) from militaryPayTables.json
//   (2) Family Size -> Required Bedrooms (rule-based)
//   (3) City Bedroom Cost targets (rent/price) from cityBedroomCosts.json
// - Returns a clean, reusable payload for PCS Snapshot / Mortgage / FRS.
//
// INPUT (POST JSON):
// {
//   "rank": "E-6",              // required (or rank_paygrade)
//   "rank_paygrade": "E-6",     // optional alias
//   "yos": 8,                   // required (years of service)
//   "zip": "78245",             // optional (for BAH)
//   "family": true,             // optional (BAH with dependents) default true
//   "familySize": 5,            // required for bedroom rule (or dependents + 1)
//   "dependents": 4,            // optional (if you prefer dependents count)
//   "cityKey": "SanAntonioTX",  // required (must exist in cityBedroomCosts.json)
//   "mode": "rent",             // optional: "rent" | "buy" (default "rent")
//   "additionalIncome": 0,      // optional (monthly) adds to total pay for ratios
//   "monthlyDebt": 0            // optional (monthly) for affordability gate
// }
//
// OUTPUT (JSON):
// - ok, pay breakdown, rightModel (bedrooms + city targets), verdict + ratios
// ============================================================

const fs = require("fs");
const path = require("path");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(obj)
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normalizePaygrade(raw) {
  const s = String(raw || "").toUpperCase().trim();
  // Accept: "E6", "E-6", "O1", "O-1", "W2", "W-2"
  const m = s.match(/^([EOW])\s*-?\s*(\d{1,2})$/);
  if (!m) return s;
  return `${m[1]}-${m[2]}`;
}

function yosToKey(yos) {
  // Pay tables are usually keyed by whole years. We clamp to 0..40 and floor.
  const y = Math.floor(num(yos, 0));
  return clamp(y, 0, 40);
}

function isOfficer(paygrade) {
  return String(paygrade || "").toUpperCase().startsWith("O-");
}

function loadJson(relPath) {
  const abs = path.join(process.cwd(), relPath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

/** ============================================================
 *  //#1 PAY TABLE ACCESS (authoritative)
 *  File: netlify/functions/data/militaryPayTables.json
 *  Expected keys:
 *   - BASEPAY: { "E-6": { "0": 0, "2": 0, ... } } (or similar)
 *   - BAS: { "enlisted": number, "officer": number }
 *   - BAH_TX: { "78245": { with: { "E-6": 0 }, without: { "E-6": 0 } } }
 * ============================================================ */
function getBasePay(payTables, paygrade, yos) {
  const pg = normalizePaygrade(paygrade);
  const yKey = String(yosToKey(yos));

  const base = payTables?.BASEPAY?.[pg];
  if (!base) return { ok: false, value: 0, note: `Unknown paygrade in BASEPAY: ${pg}` };

  // Direct match if exists
  if (base[yKey] != null) return { ok: true, value: num(base[yKey], 0), note: null };

  // Otherwise choose closest <= yos
  const keys = Object.keys(base)
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return { ok: false, value: 0, note: `No YOS keys found for ${pg}` };

  let pick = keys[0];
  for (const k of keys) {
    if (k <= Number(yKey)) pick = k;
    else break;
  }
  return { ok: true, value: num(base[String(pick)], 0), note: `Used nearest YOS ${pick}` };
}

function getBAS(payTables, paygrade) {
  const officer = isOfficer(normalizePaygrade(paygrade));
  const bas = officer ? payTables?.BAS?.officer : payTables?.BAS?.enlisted;
  const v = num(bas, 0);
  return { ok: v > 0, value: v, note: officer ? "Officer BAS" : "Enlisted BAS" };
}

function getBAH(payTables, zip, paygrade, family = true) {
  const pg = normalizePaygrade(paygrade);
  const z = String(zip || "").trim();
  if (!z) return { ok: false, value: 0, note: "No ZIP provided (BAH skipped)" };

  const rec = payTables?.BAH_TX?.[z];
  if (!rec) return { ok: false, value: 0, note: `ZIP not found in BAH table: ${z}` };

  const bucket = family ? rec?.with : rec?.without;
  if (!bucket) return { ok: false, value: 0, note: `BAH bucket missing for ZIP ${z}` };

  const v = bucket?.[pg];
  if (v == null) {
    // Some tables may key without hyphen, try fallback
    const alt = pg.replace("-", "");
    const v2 = bucket?.[alt];
    if (v2 == null) return { ok: false, value: 0, note: `Paygrade ${pg} not found in BAH for ZIP ${z}` };
    return { ok: true, value: num(v2, 0), note: `Used alt paygrade key: ${alt}` };
  }
  return { ok: true, value: num(v, 0), note: family ? "BAH (with dependents)" : "BAH (without dependents)" };
}

/** ============================================================
 *  //#2 FAMILY -> BEDROOM RULE (deterministic)
 *  - You can tune this later without touching pay tables.
 *  - Default rule:
 *     1–2 people  => 2BR
 *     3–4 people  => 3BR
 *     5–6 people  => 4BR
 *     7–8 people  => 5BR
 *     9+ people   => 6BR
 * ============================================================ */
function requiredBedroomsFromFamilySize(familySize) {
  const fs = clamp(Math.floor(num(familySize, 0)), 1, 20);

  if (fs <= 2) return 2;
  if (fs <= 4) return 3;
  if (fs <= 6) return 4;
  if (fs <= 8) return 5;
  return 6;
}

/** ============================================================
 *  //#3 CITY BEDROOM COST TARGETS
 *  File: netlify/functions/data/cityBedroomCosts.json
 *  Expected structure:
 *  {
 *    "SanAntonioTX": {
 *      "rent":  { "2": 1550, "3": 1950, "4": 2400, "5": 3000 },
 *      "price": { "3": 315000, "4": 389000, "5": 460000 }
 *    }
 *  }
 * ============================================================ */
function pickCityTarget(cityData, cityKey, mode, bedrooms) {
  const ck = String(cityKey || "").trim();
  const rec = cityData?.[ck];
  if (!rec) {
    return {
      ok: false,
      targetMonthly: 0,
      targetPrice: 0,
      note: `cityKey not found: ${ck}`
    };
  }

  const brKey = String(bedrooms);
  const rentMap = rec?.rent || {};
  const priceMap = rec?.price || {};

  const rent = num(rentMap?.[brKey], 0);
  const price = num(priceMap?.[brKey], 0);

  if (String(mode).toLowerCase() === "buy") {
    // For buy mode, prefer price if available; still return rent if present
    return {
      ok: (price > 0) || (rent > 0),
      targetMonthly: rent,
      targetPrice: price,
      note: price > 0 ? null : "No price target for this bedroom count (rent provided if available)"
    };
  }

  // rent mode
  return {
    ok: rent > 0,
    targetMonthly: rent,
    targetPrice: price,
    note: rent > 0 ? null : "No rent target for this bedroom count"
  };
}

/** ============================================================
 *  //#4 VERDICT LOGIC (simple + deterministic)
 *  - This is NOT your full FRS model.
 *  - It’s the "Right Model" quick gate:
 *    * Compare city bedroom cost to pay and BAH
 *    * Produce a clean status + gaps + ratios
 * ============================================================ */
function buildVerdict({ pay, targetMonthlyHousing, monthlyDebt }) {
  const totalGross = num(pay.totalMonthly, 0);
  const debt = Math.max(0, num(monthlyDebt, 0));
  const housing = Math.max(0, num(targetMonthlyHousing, 0));

  // Ratios
  const housingShare = totalGross > 0 ? (housing / totalGross) : 1;
  const dtiShare = totalGross > 0 ? (debt / totalGross) : 1;
  const combinedShare = totalGross > 0 ? ((housing + debt) / totalGross) : 1;

  // Thresholds (tunable):
  const HOUSING_OK = 0.30;      // 30% of gross
  const HOUSING_WARN = 0.38;    // warn zone
  const COMBINED_OK = 0.45;     // housing + debt

  let status = "unknown";
  let band = "—";
  let notes = [];

  if (totalGross <= 0) {
    status = "blocked";
    band = "Missing pay";
    notes.push("Total monthly pay is 0 — cannot score.");
  } else {
    if (housingShare <= HOUSING_OK && combinedShare <= COMBINED_OK) {
      status = "green";
      band = "On Track";
    } else if (housingShare <= HOUSING_WARN && combinedShare <= 0.55) {
      status = "yellow";
      band = "Tight";
      notes.push("Affordability is possible but margin is thin.");
    } else {
      status = "red";
      band = "Overextended";
      notes.push("Housing target is too high for current income/debt.");
    }
  }

  // BAH comparison (if present)
  const bah = num(pay.bah, 0);
  if (bah > 0 && housing > 0) {
    const gap = housing - bah;
    if (gap <= 0) notes.push("Target housing is within BAH.");
    else notes.push(`Target housing exceeds BAH by ~$${Math.round(gap)} / mo.`);
  }

  return {
    status,
    band,
    ratios: {
      housingShare: Number(housingShare.toFixed(4)),
      dtiShare: Number(dtiShare.toFixed(4)),
      combinedShare: Number(combinedShare.toFixed(4))
    },
    notes
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });

    if (event.httpMethod !== "POST") {
      return respond(405, { ok: false, error: "Method not allowed" });
    }

    const body = safeJsonParse(event.body);

    const rank = body.rank_paygrade || body.rank;
    const yos = body.yos;
    const zip = body.zip;

    const family = (body.family == null) ? true : !!body.family;

    // Family inputs (support either familySize OR dependents)
    // If dependents provided, assume familySize = dependents + 1 (service member)
    const familySize =
      body.familySize != null ? num(body.familySize, 0)
      : (body.dependents != null ? (num(body.dependents, 0) + 1) : 0);

    const cityKey = body.cityKey;
    const mode = String(body.mode || "rent").toLowerCase();
    const additionalIncome = Math.max(0, num(body.additionalIncome, 0));
    const monthlyDebt = Math.max(0, num(body.monthlyDebt, 0));

    if (!rank) return respond(400, { ok: false, error: "Missing rank (rank or rank_paygrade)" });
    if (yos == null) return respond(400, { ok: false, error: "Missing yos" });
    if (!cityKey) return respond(400, { ok: false, error: "Missing cityKey" });
    if (!familySize || familySize < 1) {
      return respond(400, { ok: false, error: "Missing familySize (or dependents)" });
    }

    // Load authoritative datasets
    const payTables = loadJson("netlify/functions/data/militaryPayTables.json");

    // City bedroom costs
    let cityBedroomCosts = null;
    try {
      cityBedroomCosts = loadJson("netlify/functions/data/cityBedroomCosts.json");
    } catch (e) {
      return respond(500, {
        ok: false,
        error: "Missing city bedroom dataset",
        hint: "Create netlify/functions/data/cityBedroomCosts.json (see expected structure in file header)."
      });
    }

    // Pay breakdown
    const paygrade = normalizePaygrade(rank);
    const base = getBasePay(payTables, paygrade, yos);
    const bas = getBAS(payTables, paygrade);
    const bah = getBAH(payTables, zip, paygrade, family);

    const basePay = num(base.value, 0);
    const basPay = num(bas.value, 0);
    const bahPay = num(bah.value, 0);

    const totalPay = basePay + basPay + bahPay + additionalIncome;

    // Bedroom rule
    const bedrooms = requiredBedroomsFromFamilySize(familySize);

    // City targets
    const cityTarget = pickCityTarget(cityBedroomCosts, cityKey, mode, bedrooms);

    // Choose which housing target we score against:
    // - rent mode: targetMonthly = cityTarget.targetMonthly
    // - buy mode: if a monthly rent proxy exists, we still score monthly; price returned for UI
    const targetMonthlyHousing = num(cityTarget.targetMonthly, 0);

    // Verdict
    const verdict = buildVerdict({
      pay: { totalMonthly: totalPay, bah: bahPay },
      targetMonthlyHousing,
      monthlyDebt
    });

    return respond(200, {
      ok: true,
      version: "right-model.v1.0",
      inputs: {
        paygrade,
        yos: yosToKey(yos),
        zip: zip ? String(zip) : null,
        family,
        familySize,
        cityKey: String(cityKey),
        mode,
        additionalIncome,
        monthlyDebt
      },
      pay: {
        basePay: basePay,
        bas: basPay,
        bah: bahPay,
        additionalIncome,
        totalMonthly: totalPay,
        notes: {
          basePay: base.note,
          bas: bas.note,
          bah: bah.note
        }
      },
      rightModel: {
        requiredBedrooms: bedrooms,
        cityTargets: {
          targetRentMonthly: num(cityTarget.targetMonthly, 0),
          targetHomePrice: num(cityTarget.targetPrice, 0),
          note: cityTarget.note
        }
      },
      verdict
    });
  } catch (err) {
    return respond(500, {
      ok: false,
      error: "Server error",
      detail: String(err && err.message ? err.message : err)
    });
  }
};

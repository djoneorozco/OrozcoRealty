// netlify/functions/brain.js
// ============================================================
// OrozcoRealty • Central Brain (v1.0.1 - CJS SAFE)
// FIX:
// - Netlify is executing this function as CommonJS
// - import.meta.url becomes undefined in the compiled runtime
// - So we use __dirname for file paths (CJS-native)
// Also:
// - Handles OPTIONS preflight (CORS)
// - Returns friendly message on GET (browser open)
// ============================================================

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// //#1 — CORS
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Content-Type": "application/json",
};

// //#2 — Local file paths (CJS-safe)
const PAY_TABLE_PATH = path.join(__dirname, "data", "militaryPayTables.json");
const CITIES_DIR = path.join(__dirname, "cities");

// //#3 — Helpers
function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj),
  };
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizePaygrade(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";

  // Accept: "E6", "E-6", "E 6", "O3", "O-3"
  const m = s.match(/^([EO])\s*[-]?\s*(\d{1,2})$/);
  if (m) return `${m[1]}-${Number(m[2])}`;

  // Accept: "E-06" etc
  const m2 = s.match(/^([EO])\s*[-]?\s*0*(\d{1,2})$/);
  if (m2) return `${m2[1]}-${Number(m2[2])}`;

  return s;
}

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return obj[k];
    }
  }
  return null;
}

function pickBoolean(obj, keys) {
  const v = pickFirst(obj, keys);
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

// //#4 — Pay logic
function getBasePay(payTables, rank, yos) {
  const table = payTables?.BASEPAY || {};
  const r = table[rank];
  if (!r) return { value: 0, note: `BASEPAY missing rank ${rank}` };

  const y = Number(yos);
  if (!Number.isFinite(y)) return { value: 0, note: `Invalid YOS ${yos}` };

  if (r[String(y)] !== undefined) return { value: Number(r[String(y)]) || 0, note: "exact" };
  if (r[y] !== undefined) return { value: Number(r[y]) || 0, note: "exact" };

  const keys = Object.keys(r)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!keys.length) return { value: 0, note: `No YOS keys for ${rank}` };

  let chosen = keys[0];
  for (const k of keys) {
    if (k <= y) chosen = k;
  }
  return { value: Number(r[String(chosen)]) || 0, note: `closest<= (${chosen})` };
}

function getBAS(payTables, rank) {
  const isOfficer = String(rank || "").toUpperCase().startsWith("O-");
  const basTable = payTables?.BAS || {};
  const v = isOfficer ? basTable.officer : basTable.enlisted;
  return { value: Number(v) || 0, note: isOfficer ? "officer" : "enlisted" };
}

function getBAH(payTables, zip, rank, hasFamily) {
  const bahTable = payTables?.BAH_TX || {};
  const z = String(zip || "").trim();

  const row = bahTable[z];
  if (!row) return { value: 0, note: `BAH missing ZIP ${z}` };

  const depKey = hasFamily ? "with" : "without";
  const depBlock = row?.[depKey];
  if (!depBlock) return { value: 0, note: `BAH missing dependents block (${depKey}) for ${z}` };

  const v = depBlock?.[rank];
  if (v === undefined) return { value: 0, note: `BAH missing rank ${rank} in ZIP ${z} (${depKey})` };

  return { value: Number(v) || 0, note: depKey };
}

// //#5 — City loader
function loadCity(cityKey) {
  const safe = String(cityKey || "").trim();
  if (!safe) return { ok: false, error: "Missing cityKey" };

  // allow letters/numbers/hyphen only
  if (!/^[a-z0-9\-]+$/i.test(safe)) {
    return { ok: false, error: "Invalid cityKey format" };
  }

  const file = path.join(CITIES_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) return { ok: false, error: `City file not found: ${safe}.json` };

  const raw = fs.readFileSync(file, "utf8");
  const json = safeJsonParse(raw);
  if (!json) return { ok: false, error: `City JSON parse failed: ${safe}.json` };

  return { ok: true, data: json };
}

// //#6 — Handler
exports.handler = async (event) => {
  try {
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return respond(200, { ok: true });
    }

    // Friendly browser open
    if (event.httpMethod === "GET") {
      return respond(200, {
        ok: true,
        message: "Brain is online. Use POST with JSON body: { email, cityKey, bedrooms }",
        example: { email: "you@email.com", cityKey: "SanAntonio", bedrooms: 4 },
      });
    }

    if (event.httpMethod !== "POST") {
      return respond(405, { ok: false, error: "Method not allowed" });
    }

    const body = safeJsonParse(event.body || "{}") || {};
    const email = String(body.email || "").trim().toLowerCase();
    const cityKey = String(body.cityKey || "SanAntonio").trim();
    const bedrooms = toInt(body.bedrooms ?? 4) ?? 4;

    if (!email) return respond(400, { ok: false, error: "Missing email" });

    // Env check
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return respond(500, { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars" });
    }

    // Load pay tables
    if (!fs.existsSync(PAY_TABLE_PATH)) {
      return respond(500, { ok: false, error: "militaryPayTables.json not found at netlify/functions/data/" });
    }

    const payTables = safeJsonParse(fs.readFileSync(PAY_TABLE_PATH, "utf8"));
    if (!payTables) return respond(500, { ok: false, error: "militaryPayTables.json parse failed" });

    // Supabase profile
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (profErr) {
      return respond(500, { ok: false, error: "Supabase error", details: String(profErr.message || profErr) });
    }
    if (!profile) {
      return respond(404, { ok: false, error: "Profile not found for email" });
    }

    // Extract inputs from profile (robust mapping)
    const rankRaw = pickFirst(profile, ["rank_paygrade", "rank", "rankPaygrade", "rank_pay_grade"]);
    const yosRaw = pickFirst(profile, ["yos", "years_of_service", "yearsOfService", "years_service"]);
    const zipRaw = pickFirst(profile, ["zip", "zipcode", "postal", "bah_zip"]);
    const famRaw = pickBoolean(profile, ["family", "has_family", "dependents", "with_dependents"]);

    const rank = normalizePaygrade(rankRaw);
    const yos = toInt(yosRaw);
    const zip = String(zipRaw || "").trim();
    const family = famRaw === null ? false : famRaw;

    const missing = [];
    if (!rank) missing.push("rank_paygrade");
    if (yos === null) missing.push("yos");
    if (!zip) missing.push("zip");

    // Compute pay
    let basePay = 0, bas = 0, bah = 0;
    const notes = {};

    if (rank && yos !== null) {
      const bp = getBasePay(payTables, rank, yos);
      basePay = bp.value;
      notes.basePay = bp.note;
    } else {
      notes.basePay = "missing rank/yos";
    }

    if (rank) {
      const b = getBAS(payTables, rank);
      bas = b.value;
      notes.bas = b.note;
    } else {
      notes.bas = "missing rank";
    }

    if (rank && zip) {
      const b = getBAH(payTables, zip, rank, !!family);
      bah = b.value;
      notes.bah = b.note;
    } else {
      notes.bah = "missing rank/zip";
    }

    const totalPay = Number(basePay || 0) + Number(bas || 0) + Number(bah || 0);

    // Load city
    const cityRes = loadCity(cityKey);
    const city = cityRes.ok ? cityRes.data : { key: cityKey, error: cityRes.error };

    const market = city?.market || {};
    const targets = city?.targets || {};

    return respond(200, {
      ok: missing.length === 0,
      email,
      profile: {
        email: profile.email || email,
        name: pickFirst(profile, ["full_name", "name"]) || null,
        rank_paygrade: rank || null,
        yos: yos !== null ? yos : null,
        zip: zip || null,
        family: !!family,
        base: pickFirst(profile, ["base", "duty_station", "installation"]) || null,
      },
      missing,
      pay: { basePay, bah, bas, totalPay, notes },
      city: { key: cityKey, bedrooms, market, targets },
    });
  } catch (e) {
    return respond(500, { ok: false, error: "Brain crashed", details: String(e?.message || e) });
  }
};

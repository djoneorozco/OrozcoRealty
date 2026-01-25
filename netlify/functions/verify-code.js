// netlify/functions/verify-code.js
//
// PURPOSE:
//  - Accept POST { email, code }
//  - Hash the code the user typed
//  - Look up the latest row in Supabase email_codes
//  - Confirm: same email, hashes match, not expired, not over attempt limit
//  - Increment attempts if wrong
//  - On success: return { ok:true, profile:{...from profiles} }
//
// ✅ FIX:
//  - Removes dependency on email_codes.context (since send-code.js doesn't write it)

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(obj || {}),
  };
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

exports.handler = async function (event) {
  // //#1 CORS
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  if (event.httpMethod !== "POST") return respond(405, { ok: false, error: "Method not allowed" });

  // //#2 Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, { ok: false, error: "Invalid JSON body" });
  }

  const email = (body.email || "").trim().toLowerCase();
  const codeRaw = String(body.code || "").trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return respond(400, { ok: false, error: "Valid email required." });
  }
  if (!codeRaw || codeRaw.replace(/\D/g, "").length !== 6) {
    return respond(400, { ok: false, error: "Email and 6-digit code required." });
  }

  const codeDigits = codeRaw.replace(/\D/g, "");

  // //#3 Supabase client (service key)
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { ok: false, error: "Supabase env not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // //#4 Load latest code row for email
  const { data: rows, error: fetchErr } = await supabase
    .from("email_codes")
    .select("email, code_hash, attempts, expires_at, created_at")
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fetchErr) {
    console.error("Supabase fetch error:", fetchErr);
    return respond(500, { ok: false, error: "Lookup failed." });
  }

  if (!rows || rows.length === 0) {
    return respond(400, { ok: false, error: "Invalid or expired code." });
  }

  const record = rows[0];

  // //#5 Attempt lockout
  const MAX_ATTEMPTS = 5;
  const attempts = Number(record.attempts || 0);

  if (attempts >= MAX_ATTEMPTS) {
    return respond(400, { ok: false, error: "Too many attempts. Request new code." });
  }

  // //#6 Expiration check
  const now = Date.now();
  const exp = new Date(record.expires_at).getTime();
  if (isNaN(exp) || now > exp) {
    return respond(400, { ok: false, error: "Code expired. Request new code." });
  }

  // //#7 Compare hash
  const submittedHash = hashCode(codeDigits);

  if (submittedHash !== record.code_hash) {
    // wrong code -> bump attempts
    const { error: attemptErr } = await supabase
      .from("email_codes")
      .update({ attempts: attempts + 1 })
      .eq("email", email)
      .eq("created_at", record.created_at);

    if (attemptErr) console.error("Supabase attempt update error:", attemptErr);

    return respond(400, { ok: false, error: "Invalid code." });
  }

  // //#8 Pull canonical profile from profiles (source of truth)
  let profile = { email };

  const { data: profRows, error: profErr } = await supabase
    .from("profiles")
    .select("email, full_name, last_name, phone, mode, rank, rank_paygrade, va_disability, yos, family, base, notes")
    .eq("email", email)
    .limit(1);

  if (profErr) {
    console.error("Supabase profiles lookup error:", profErr);
    // Still return ok true since code was valid
    return respond(200, { ok: true, message: "Code verified.", profile });
  }

  if (profRows && profRows.length > 0) {
    profile = { ...profile, ...profRows[0] };
  }

  return respond(200, {
    ok: true,
    message: "Code verified.",
    profile,
  });
};

// netlify/functions/verify-code.js
//
// PURPOSE:
//  - Accept POST { email, code }
//  - Hash the code the user typed
//  - Look up the row in Supabase (email_codes table)
//  - Confirm: same email, hashes match, not expired, not over attempt limit
//  - Increment attempts if wrong
//  - Return { ok:true, profile:{...} } on success
//
// REQUIREMENTS (match send-code.js):
//  - SUPABASE_URL
//  - SUPABASE_SERVICE_KEY
//
// TABLE: public.email_codes
//   email          text
//   code_hash      text
//   attempts       int4
//   expires_at     timestamptz
//   created_at     timestamptz
//   context        jsonb   <-- { rank, lastName, phone, ... }
//
// NOTE:
//  - We’re *not* deleting the row yet. You can — but for now we’ll just
//    return success and let you redirect the user.
//  - We *are* limiting attempts (max 5 tries).
//

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

// helper: standard response
function respond(statusCode, obj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(obj || {})
  };
}

// hash helper (must match send-code.js logic)
function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

exports.handler = async function (event, context) {
  // 0. preflight
  if (event.httpMethod === "OPTIONS") {
    return respond(200, {});
  }

  // 1. must be POST
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // 2. parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return respond(400, { error: "Invalid JSON body" });
  }

  const email = (body.email || "").trim().toLowerCase();
  const codeRaw = (body.code || "").trim();

  if (!email || !codeRaw || codeRaw.length !== 6) {
    return respond(400, { error: "Email and 6-digit code required." });
  }

  // 3. env + supabase client
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // same var used in send-code.js

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { error: "Supabase env not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });

  // 4. load row for this email
  const { data: rows, error: fetchErr } = await supabase
    .from("email_codes")
    .select("*")
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fetchErr) {
    console.error("Supabase fetch error:", fetchErr);
    return respond(500, { error: "Lookup failed." });
  }

  if (!rows || rows.length === 0) {
    // no code on record for this email
    return respond(400, { error: "Invalid or expired code." });
  }

  const record = rows[0];

  // 5. simple attempt lockout
  const MAX_ATTEMPTS = 5;
  if (record.attempts >= MAX_ATTEMPTS) {
    return respond(400, { error: "Too many attempts. Request new code." });
  }

  // 6. check expiration
  const now = Date.now();
  const exp = new Date(record.expires_at).getTime();
  if (isNaN(exp) || now > exp) {
    return respond(400, { error: "Code expired. Request new code." });
  }

  // 7. compare hash
  const submittedHash = hashCode(codeRaw);

  if (submittedHash !== record.code_hash) {
    // wrong code → bump attempts
    const { error: attemptErr } = await supabase
      .from("email_codes")
      .update({ attempts: record.attempts + 1 })
      .eq("email", email)
      .eq("created_at", record.created_at);

    if (attemptErr) {
      console.error("Supabase attempt update error:", attemptErr);
    }

    return respond(400, { error: "Invalid code." });
  }

  // 8. SUCCESS 🎉 – base profile from email_codes.context
  let profile = {
    email: record.email,
    ...record.context // pulls rank / lastName / phone etc.
  };

  // 9. OPTIONAL ENRICH: pull matching row from profiles table (if it exists)
  try {
    const { data: profRows, error: profErr } = await supabase
      .from("profiles")
      .select(
        "email, full_name, last_name, phone, mode, rank, va_disability, yos, family, base, notes"
      )
      .eq("email", email)
      .limit(1);

    if (!profErr && profRows && profRows.length > 0) {
      profile = { ...profile, ...profRows[0] };
    } else if (profErr) {
      console.error("Supabase profiles lookup error:", profErr);
    }
  } catch (e) {
    console.error("Profiles enrichment error:", e);
  }

  // OPTIONAL CLEANUP:
  // await supabase
  //   .from("email_codes")
  //   .delete()
  //   .eq("email", email)
  //   .eq("created_at", record.created_at);

  return respond(200, {
    ok: true,
    message: "Code verified.",
    profile
  });
};

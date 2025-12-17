// netlify/functions/register.js
//
// Creates a Supabase Auth user (email + password)
// + inserts a row in public.profiles
//
// EXPECTS ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service role key, NOT anon)
//
// BODY:
//   {
//     fullName, email, password, phone,
//     mode, rank, va_disability, yos, family, base, notes
//   }

const { createClient } = require("@supabase/supabase-js");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload || {})
  };
}

exports.handler = async function (event) {
  // --- 0) CORS ---
  if (event.httpMethod === "OPTIONS") {
    return respond(200, {});
  }

  // --- 1) Enforce POST ---
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // --- 2) Parse body ---
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return respond(400, { error: "Invalid JSON body" });
  }

  const {
    fullName,
    email,
    password,
    phone,
    mode,
    rank,
    va_disability,
    yos,
    family,
    base,
    notes
  } = body;

  const cleanEmail = (email || "").trim().toLowerCase();
  const cleanFullName = (fullName || "").trim();

  if (!cleanFullName) return respond(400, { error: "Full name is required." });
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return respond(400, { error: "Valid email is required." });
  }
  if (!password || password.length < 8) {
    return respond(400, { error: "Password must be at least 8 characters." });
  }

  // derive last name (simple MVP)
  const lastName = cleanFullName.includes(" ")
    ? cleanFullName.split(" ").slice(-1)[0]
    : cleanFullName;

  // --- 3) Init Supabase (service key) ---
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { error: "Supabase env not configured." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // --- 4) Create Auth user ---
  const { data: userData, error: authError } =
    await supabase.auth.admin.createUser({
      email: cleanEmail,
      password,
      // You are using your own verification-code flow,
      // so we keep this as-is (no product behavior changes).
      email_confirm: true
    });

  if (authError || !userData || !userData.user || !userData.user.id) {
    return respond(400, {
      error: (authError && authError.message) || "Auth registration failed."
    });
  }

  const authUserId = userData.user.id; // uuid

  // --- 5) Insert into profiles (LINKED to auth user) ---
  // IMPORTANT: Your table already includes:
  // - profiles_user_id_unique (uuid)
  // - rank_paygrade (column exists in your screenshot, truncated as rank_paygra...)
  const profilePayload = {
    profiles_user_id_unique: authUserId, // ✅ critical linkage
    email: cleanEmail,
    full_name: cleanFullName,
    last_name: lastName,
    phone: phone || null,
    mode: mode || null,

    // Based on your current table:
    // - "rank" is storing paygrade like "E-9"
    // - "rank_paygrade" also exists, so we mirror it for future-proofing
    rank: rank || null,
    rank_paygrade: rank || null,

    // your schema shows va_disability is text, so keep as text
    va_disability: va_disability || null,

    // yos in your schema is int4
    yos: yos !== undefined && yos !== null && String(yos).trim() !== ""
      ? Number(yos)
      : null,

    // your schema shows family is text, keep it consistent (do NOT cast)
    family: family || null,

    base: base || null,
    notes: notes || null
  };

  const { error: profileError } = await supabase
    .from("profiles")
    .insert(profilePayload);

  if (profileError) {
    // --- 5B) Roll back Auth user to prevent orphan accounts ---
    try {
      await supabase.auth.admin.deleteUser(authUserId);
    } catch (_) {
      // ignore rollback errors (we still report the original failure)
    }

    console.error("PROFILE INSERT ERROR:", profileError);

    // Helpful messaging for common cases (duplicate email, etc.)
    const msg = profileError.message || "Profile save failed.";
    return respond(500, {
      error: "Profile save failed.",
      details: msg
    });
  }

  // --- 6) SUCCESS ---
  return respond(200, {
    ok: true,
    message: "Registered successfully.",
    user_id: authUserId
  });
};

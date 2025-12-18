// netlify/functions/register.js
//
// Creates a Supabase Auth user (email + password)
// + inserts a row in public.profiles
// + links via profiles_user_id_unique (uuid)
//
// ATOMIC BEHAVIOR:
// - If profile insert fails, delete the Auth user (rollback) to avoid orphans.
//
// EXPECTS ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service role key, NOT anon)
//
// BODY:
//   {
//     fullName, lastName, email, password, phone,
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
    return respond(405, { ok: false, error: "Method not allowed" });
  }

  // --- 2) Parse body ---
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return respond(400, { ok: false, error: "Invalid JSON body" });
  }

  const {
    fullName,
    lastName,
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

  if (!cleanFullName) return respond(400, { ok: false, error: "Full name is required." });
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return respond(400, { ok: false, error: "Valid email is required." });
  }
  if (!password || password.length < 8) {
    return respond(400, { ok: false, error: "Password must be at least 8 characters." });
  }

  // Prefer UI-provided lastName if present; otherwise derive (minimal)
  const cleanLastNameInput = (lastName || "").trim();
  const derivedLastName = cleanFullName.includes(" ")
    ? cleanFullName.split(" ").slice(-1)[0]
    : cleanFullName;
  const finalLastName = cleanLastNameInput || derivedLastName;

  // --- 3) Init Supabase (service key) ---
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { ok: false, error: "Supabase env not configured." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // --- 4) Create Auth user ---
  const { data: userData, error: authError } =
    await supabase.auth.admin.createUser({
      email: cleanEmail,
      password,
      // You are using your own verification-code flow.
      // Keep this behavior unchanged.
      email_confirm: true
    });

  if (authError || !userData || !userData.user || !userData.user.id) {
    const msg = (authError && authError.message) || "Auth registration failed.";
    // Common: email already exists -> treat as conflict
    const status = /already|exists|registered/i.test(msg) ? 409 : 400;
    return respond(status, { ok: false, error: msg });
  }

  const authUserId = userData.user.id; // uuid

  // --- 5) Insert into profiles (LINKED to auth user) ---
  const yosNum =
    yos !== undefined && yos !== null && String(yos).trim() !== ""
      ? Number(yos)
      : null;

  const profilePayload = {
    // ✅ critical linkage
    profiles_user_id_unique: authUserId,

    email: cleanEmail,
    full_name: cleanFullName,
    last_name: finalLastName,
    phone: phone || null,
    mode: mode || null,

    // Paygrade (UI sends in "rank")
    rank: rank || null,
    rank_paygrade: rank || null,

    // Keep as-is (don’t change your existing types/flow)
    va_disability: va_disability || null,

    // numeric
    yos: Number.isFinite(yosNum) ? yosNum : null,

    // keep as string (your UI sends "1","2"...)
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

    const msg = profileError.message || "Profile save failed.";
    const status = /duplicate|unique/i.test(msg) ? 409 : 500;
    return respond(status, {
      ok: false,
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

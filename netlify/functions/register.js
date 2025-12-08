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
  // --- 0. CORS preflight ---
  if (event.httpMethod === "OPTIONS") {
    return respond(200, {});
  }

  // --- 1. Enforce POST ---
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // --- 2. Parse body ---
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

  if (!cleanFullName) {
    return respond(400, { error: "Full name is required." });
  }
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return respond(400, { error: "Valid email is required." });
  }
  if (!password || password.length < 8) {
    return respond(400, { error: "Password must be at least 8 characters." });
  }

  // derive last name
  let lastName = cleanFullName;
  if (cleanFullName.includes(" ")) {
    const parts = cleanFullName.split(" ");
    lastName = parts[parts.length - 1];
  }

  // --- 3. Init Supabase (SERVICE KEY) ---
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { error: "Supabase env not configured." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // --- 4. Create Auth user (password stored ONLY in Auth) ---
  const { data: userData, error: authError } =
    await supabase.auth.admin.createUser({
      email: cleanEmail,
      password,
      email_confirm: false   // we are doing our own 6-digit verification
    });

  if (authError) {
    // This is where “A user with this email already exists” comes from.
    return respond(400, {
      error: authError.message || "Auth registration failed."
    });
  }

  const userId = userData?.user?.id || null;

  // --- 5. Insert profile row (NO password here) ---
  const { error: profileError } = await supabase
    .from("profiles")
    .insert({
      // only columns that actually exist in your profiles table:
      email: cleanEmail,
      full_name: cleanFullName,
      last_name: lastName,
      phone: phone || null,
      mode: mode || null,                 // "ad" or "vet"
      rank: rank || null,
      va_disability: va_disability || null,
      yos: yos ? Number(yos) : null,      // int4 in DB
      family: family || null,
      base: base || null,
      notes: notes || null,
      // optional: keep auth user id for linkage later
      auth_user_id: userId || null        // only if you add this column
    });

  if (profileError) {
    console.error("PROFILE INSERT ERROR:", profileError);
    return respond(500, {
      error: "Profile save failed.",
      details: profileError.message || null
    });
  }

  // --- 6. Success ---
  return respond(200, {
    ok: true,
    message: "Registered successfully."
  });
};

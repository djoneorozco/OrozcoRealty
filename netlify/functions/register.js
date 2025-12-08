// netlify/functions/register.js
//
// PURPOSE:
//  - Create a Supabase Auth user (email + password)
//  - Store profile data in public.profiles (no password there)
//  - Return { ok: true, user_id, profile } on success
//
// ENV VARS REQUIRED:
//  - SUPABASE_URL
//  - SUPABASE_SERVICE_KEY  (service role key – NOT anon key)

const { createClient } = require("@supabase/supabase-js");

// ----- CORS HELPERS -----
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj || {})
  };
}

// ----- MAIN HANDLER -----
exports.handler = async function (event) {
  // 0) Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return respond(200, {});
  }

  // 1) Enforce POST
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // 2) Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return respond(400, { error: "Invalid JSON body" });
  }

  const {
    email,
    password,
    fullName,
    phone,
    mode,
    rank,
    va_disability,
    yos,
    family,
    base,
    notes
  } = body;

  // 3) Basic validation
  const cleanEmail = (email || "").trim().toLowerCase();
  const cleanPassword = (password || "").trim();
  const cleanFullName = (fullName || "").trim();

  if (!cleanFullName) {
    return respond(400, { error: "Full name is required." });
  }

  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return respond(400, { error: "Valid email is required." });
  }

  if (!cleanPassword || cleanPassword.length < 8) {
    return respond(400, { error: "Password must be at least 8 characters." });
  }

  // 4) Init Supabase (service role)
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return respond(500, { error: "Supabase env not configured." });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false }
  });

  try {
    // 5) Create Auth user (password lives ONLY in Supabase Auth)
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email: cleanEmail,
        password: cleanPassword,
        email_confirm: false // they will still verify via your 6-digit flow
      });

    if (authError) {
      console.error("Auth createUser error:", authError);
      return respond(400, { error: authError.message || "Auth signup failed." });
    }

    const user = authData.user;

    // 6) Derive last_name from full name
    let lastName = cleanFullName;
    const parts = cleanFullName.split(" ");
    if (parts.length > 1) {
      lastName = parts[parts.length - 1];
    }

    // 7) Upsert into profiles (NO PASSWORD SAVED HERE)
    const profileRow = {
      email: cleanEmail,
      full_name: cleanFullName,
      last_name: lastName,
      phone: phone || null,
      mode: mode || null,              // "ad" or "vet"
      rank: rank || null,
      va_disability: va_disability || null,
      yos: yos ? Number(yos) : null,
      family: family || null,
      base: base || null,
      notes: notes || null
      // password_has column can stay NULL (we are not storing password)
    };

    const { error: profileError } = await supabase
      .from("profiles")
      .upsert(profileRow, { onConflict: "email" });

    if (profileError) {
      console.error("Profile upsert error:", profileError);
      // still return ok=false so you see the error in UI
      return respond(500, { error: "Profile save failed." });
    }

    // 8) Success
    return respond(200, {
      ok: true,
      message: "User registered.",
      user_id: user.id,
      profile: profileRow
    });
  } catch (err) {
    console.error("REGISTER UNEXPECTED ERROR:", err);
    return respond(500, { error: "Unexpected server error." });
  }
};

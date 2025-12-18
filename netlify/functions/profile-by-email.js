// netlify/functions/profile-by-email.js
//
// SIMPLE PROFILE LOOKUP (email -> public.profiles row)
// - Uses SUPABASE_SERVICE_KEY on the server (not exposed to browser)
// - Webflow can send only { email } and receive rank/yos/etc
//
// EXPECTS ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// BODY (POST):
//   { email: "user@email.com" }

const { createClient } = require("@supabase/supabase-js");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload || {}),
  };
}

exports.handler = async function (event) {
  // 0) CORS
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });

  // 1) POST only
  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed" });
  }

  // 2) Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, { ok: false, error: "Invalid JSON body" });
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return respond(400, { ok: false, error: "Valid email is required." });
  }

  // 3) Supabase env
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { ok: false, error: "Supabase env not configured." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 4) Query profile by email (return only what you need)
  const selectCols = [
    "id",
    "created_at",
    "profiles_user_id_unique",
    "email",
    "full_name",
    "last_name",
    "phone",
    "mode",
    "rank",
    "rank_paygrade",
    "va_disability",
    "yos",
    "family",
    "base",
    "notes",
  ].join(",");

  const { data, error } = await supabase
    .from("profiles")
    .select(selectCols)
    .eq("email", email)
    .maybeSingle();

  if (error) {
    return respond(500, { ok: false, error: error.message || "Query failed." });
  }

  if (!data) {
    return respond(404, { ok: false, error: "No profile found for that email." });
  }

  return respond(200, { ok: true, profile: data });
};

// netlify/functions/login.js
//
// Logs in a Supabase Auth user (email + password)
// Returns session + user info
//
// EXPECTS ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

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

  // --- 2. Parse Body ---
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const { email, password } = body;

  if (!email || !password) {
    return respond(400, { error: "Email and password are required." });
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

  // --- 4. SIGN IN USER ---
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password
  });

  if (error) {
    return respond(401, { error: error.message || "Invalid login credentials." });
  }

  // --- 5. SUCCESS ---
  return respond(200, {
    ok: true,
    user: data.user,
    session: data.session
  });
};

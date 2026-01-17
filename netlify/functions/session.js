// netlify/functions/session.js
//
// Validates a Supabase Auth access token (Bearer token)
// Returns ok:true + user if valid
//
// EXPECTS ENV:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Client should call with either:
//   - Authorization: Bearer <access_token>
//   OR
//   - JSON body: { "access_token": "<token>" }

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

function getBearerToken(event) {
  const h =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
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

  // --- 2. Parse token (Authorization header preferred) ---
  let token = getBearerToken(event);

  if (!token) {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return respond(400, { error: "Invalid JSON body" });
    }
    token = (body.access_token || "").trim();
  }

  if (!token) {
    return respond(401, { ok: false, error: "Missing access token." });
  }

  // --- 3. Init Supabase (SERVER) ---
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { error: "Supabase env not configured." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // --- 4. Validate token -> user ---
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return respond(401, { ok: false, error: "Invalid or expired session." });
  }

  // --- 5. Success ---
  return respond(200, { ok: true, user: data.user });
};

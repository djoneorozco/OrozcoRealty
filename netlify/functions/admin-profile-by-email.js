// netlify/functions/admin-profile-by-email.js
//
// Admin-only: fetch ONE profile row by email
//
// ENV required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   ADMIN_EXPORT_TOKEN
//
// Request:
//   POST /api/admin-profile-by-email
//   Headers: x-admin-token: <ADMIN_EXPORT_TOKEN>
//   Body: { "email": "someone@example.com" }

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

function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function getHeader(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : "";
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  if (event.httpMethod !== "POST") return respond(405, { ok: false, error: "Method not allowed" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_EXPORT_TOKEN = process.env.ADMIN_EXPORT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { ok: false, error: "Supabase env not configured." });
  }
  if (!ADMIN_EXPORT_TOKEN) {
    return respond(500, { ok: false, error: "ADMIN_EXPORT_TOKEN env not configured." });
  }

  const token = getHeader(event, "x-admin-token");
  if (!safeEqual(token, ADMIN_EXPORT_TOKEN)) {
    return respond(401, { ok: false, error: "Unauthorized" });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (_) {}

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return respond(400, { ok: false, error: "Valid email is required." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) return respond(500, { ok: false, error: error.message || String(error) });

  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row) return respond(404, { ok: false, error: "No profile found for that email." });

  return respond(200, { ok: true, profile: row });
};

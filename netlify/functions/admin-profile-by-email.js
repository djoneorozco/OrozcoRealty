// netlify/functions/admin-profile-by-email.js
//
// ADMIN: Read a full public.profiles row by email (server-side, protected)
// Optional: also returns the linked Supabase Auth user via profiles_user_id_unique
//
// ENV required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   ADMIN_EXPORT_TOKEN
//
// BODY:
//   { email: string, admin_key: string }
//
// NOTE: Do NOT expose SUPABASE_SERVICE_KEY client-side.

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
  // 0) CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true });
  }

  // 1) POST only
  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed" });
  }

  // 2) Env checks
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_EXPORT_TOKEN = process.env.ADMIN_EXPORT_TOKEN;

  if (!ADMIN_EXPORT_TOKEN) {
    return respond(500, { ok: false, error: "ADMIN_EXPORT_TOKEN env not configured." });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { ok: false, error: "Supabase env not configured." });
  }

  // 3) Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, { ok: false, error: "Invalid JSON body" });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const adminKey = String(body.admin_key || "").trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return respond(400, { ok: false, error: "Valid email is required." });
  }

  if (!adminKey) {
    return respond(401, { ok: false, error: "Admin key required." });
  }

  if (adminKey !== ADMIN_EXPORT_TOKEN) {
    return respond(401, { ok: false, error: "Invalid admin key." });
  }

  // 4) Init Supabase service client
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // 5) Fetch profile row
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (profErr) {
    return respond(500, { ok: false, error: profErr.message || "Profile lookup failed." });
  }

  if (!profile) {
    return respond(404, { ok: false, error: "No profile found for that email." });
  }

  // 6) Optional: fetch linked Auth user (if available)
  let authUser = null;
  try {
    const uid = profile.profiles_user_id_unique;
    if (uid) {
      const { data, error } = await supabase.auth.admin.getUserById(uid);
      if (!error && data && data.user) {
        authUser = {
          id: data.user.id,
          email: data.user.email,
          created_at: data.user.created_at,
          last_sign_in_at: data.user.last_sign_in_at,
          email_confirmed_at: data.user.email_confirmed_at,
          phone: data.user.phone || null,
          app_metadata: data.user.app_metadata || null,
          user_metadata: data.user.user_metadata || null
        };
      }
    }
  } catch (_) {
    // do nothing; profile is still returned
  }

  // 7) Success
  return respond(200, {
    ok: true,
    profile,
    authUser
  });
};

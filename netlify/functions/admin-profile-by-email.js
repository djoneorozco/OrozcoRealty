// netlify/functions/admin-profile-by-email.js
//
// Admin-only profile lookup by email (public.profiles)
// - Requires ADMIN_EXPORT_TOKEN to be set in Netlify env
// - Uses SUPABASE_SERVICE_KEY (service role) to bypass RLS safely server-side
//
// POST BODY:
//   {
//     "email": "user@email.com",
//     "adminKey": "YOUR_ADMIN_KEY",
//     "includeAuth": false
//   }
//
// Returns:
//   { ok:true, profile:{...}, auth?:{...} }

const { createClient } = require("@supabase/supabase-js");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload || {})
  };
}

function safeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  return { email: e, ok };
}

function tokenFromRequest(event) {
  // Prefer header, but allow body for convenience
  const h =
    event.headers &&
    (event.headers["x-admin-token"] ||
      event.headers["X-Admin-Token"] ||
      event.headers["authorization"] ||
      event.headers["Authorization"]);

  if (h) {
    const s = String(h).trim();
    // allow "Bearer <token>"
    const m = s.match(/^bearer\s+(.+)$/i);
    return (m ? m[1] : s).trim();
  }
  return "";
}

exports.handler = async function (event) {
  // 0) CORS
  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true });
  }

  // 1) POST only
  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "Method not allowed" });
  }

  // 2) ENV
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
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, { ok: false, error: "Invalid JSON body" });
  }

  const emailIn = body.email;
  const adminKeyBody = String(body.adminKey || "").trim();
  const includeAuth = !!body.includeAuth;

  // admin key: allow header token OR body adminKey
  const adminKeyHeader = tokenFromRequest(event);
  const adminKey = adminKeyHeader || adminKeyBody;

  if (!adminKey) {
    return respond(401, { ok: false, error: "Missing admin key." });
  }
  if (adminKey !== String(ADMIN_EXPORT_TOKEN)) {
    return respond(403, { ok: false, error: "Invalid admin key." });
  }

  const { email, ok } = safeEmail(emailIn);
  if (!ok) {
    return respond(400, { ok: false, error: "Valid email is required." });
  }

  // 4) Supabase client (service role)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // 5) Fetch profile row
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", email)
    .limit(1)
    .maybeSingle();

  if (profErr) {
    return respond(500, { ok: false, error: profErr.message || "Profile query failed." });
  }

  if (!profile) {
    return respond(404, { ok: false, error: "No profile found for that email." });
  }

  // 6) Optional: fetch auth user (only if you want)
  let auth = null;
  if (includeAuth) {
    const uid = profile.profiles_user_id_unique;
    if (uid) {
      const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(uid);
      if (!authErr && authData && authData.user) {
        auth = authData.user;
      }
    }
  }

  return respond(200, {
    ok: true,
    profile,
    auth
  });
};

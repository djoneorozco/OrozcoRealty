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

function getProjectRefFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = String(u.hostname || "");
    const ref = host.split(".")[0] || ""; // <ref>.supabase.co
    return { host, ref };
  } catch (_) {
    return { host: String(urlStr || ""), ref: "" };
  }
}

async function findAuthUserIdByEmail(supabase, emailLower) {
  // Uses Auth Admin API (works even when "auth" schema is not exposed)
  // Paginates safely; most projects won’t need many pages.
  const perPage = 200;
  let page = 1;

  for (let i = 0; i < 20; i++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) return { id: null, error: error.message || String(error) };

    const users = (data && data.users) ? data.users : [];
    const hit = users.find(u => String(u.email || "").toLowerCase() === emailLower);
    if (hit && hit.id) return { id: hit.id, error: null };

    // stop if this page returned fewer than perPage (no more data)
    if (users.length < perPage) break;
    page += 1;
  }

  return { id: null, error: null };
}

exports.handler = async function (event) {
  // --- 0) CORS ---
  if (event.httpMethod === "OPTIONS") {
    return respond(200, { ok: true });
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

  // Prefer UI-provided lastName if present; otherwise derive
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

  const { host: supabase_host, ref: supabase_project_ref } = getProjectRefFromUrl(SUPABASE_URL);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // --- 4) Create Auth user ---
  const { data: userData, error: authError } =
    await supabase.auth.admin.createUser({
      email: cleanEmail,
      password,
      // Keep your existing behavior unchanged
      email_confirm: true
    });

  if (authError || !userData || !userData.user || !userData.user.id) {
    const msg = (authError && authError.message) || "Auth registration failed.";
    const isDup = /already|exists|registered/i.test(msg);
    if (isDup) {
      const found = await findAuthUserIdByEmail(supabase, cleanEmail);
      return respond(409, {
        ok: false,
        error: "A user with this email address has already been registered",
        existing_user_id: found.id || null,
        supabase_project_ref,
        supabase_host
      });
    }
    return respond(400, { ok: false, error: msg, supabase_project_ref, supabase_host });
  }

  const authUserId = userData.user.id; // uuid

  // --- 5) Insert into profiles (LINKED to auth user) ---
  const yosNum =
    yos !== undefined && yos !== null && String(yos).trim() !== ""
      ? Number(yos)
      : null;

  const profilePayload = {
    profiles_user_id_unique: authUserId,
    email: cleanEmail,
    full_name: cleanFullName,
    last_name: finalLastName,
    phone: phone || null,
    mode: mode || null,

    rank: rank || null,
    rank_paygrade: rank || null,

    va_disability: va_disability || null,

    yos: Number.isFinite(yosNum) ? yosNum : null,
    family: family || null,

    base: base || null,
    notes: notes || null
  };

  const { error: profileError } = await supabase
    .from("profiles")
    .insert(profilePayload);

  if (profileError) {
    // --- rollback Auth user ---
    try {
      await supabase.auth.admin.deleteUser(authUserId);
    } catch (_) {}

    const msg = profileError.message || "Profile save failed.";
    const status = /duplicate|unique/i.test(msg) ? 409 : 500;

    return respond(status, {
      ok: false,
      error: "Profile save failed.",
      details: msg,
      supabase_project_ref,
      supabase_host
    });
  }

  // --- 6) SUCCESS ---
  return respond(200, {
    ok: true,
    message: "Registered successfully.",
    user_id: authUserId,
    supabase_project_ref,
    supabase_host
  });
};

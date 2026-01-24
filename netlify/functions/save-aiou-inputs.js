// netlify/functions/save-aiou-inputs.js
// ============================================================
// Saves AIOU input fields to Supabase
// - Requires Authorization: Bearer <supabase_access_token>
// - Upserts into public.user_aiou_inputs by email
// ============================================================

import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, payload) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(payload || {}) };
}

function getBearerToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export const handler = async (event) => {
  // //#0 CORS
  if (event.httpMethod === "OPTIONS") return respond(200, {});
  if (event.httpMethod !== "POST") return respond(405, { error: "Method not allowed" });

  // //#1 ENV
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { error: "Supabase env not configured." });
  }

  // //#2 AUTH
  const token = getBearerToken(event);
  if (!token) return respond(401, { error: "Missing Authorization Bearer token." });

  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await sbAdmin.auth.getUser(token);
  if (userErr || !userData?.user?.email) {
    return respond(401, { error: "Invalid or expired session token." });
  }

  const email = userData.user.email.trim().toLowerCase();

  // //#3 BODY
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  const {
    home_year,       // "new_home" | "light_touchups" | "25k_plus"
    bedrooms,
    bathrooms,
    sqft,
    property_type,
    amenities        // comma-separated string
  } = body;

  const payload = {
    email,
    home_year: home_year ?? null,
    bedrooms: bedrooms ?? null,
    bathrooms: bathrooms ?? null,
    sqft: sqft ?? null,
    property_type: property_type ?? null,
    amenities: amenities ?? null,
    updated_at: new Date().toISOString(),
  };

  // //#4 Lookup profile_id
  let profile_id = null;
  const { data: prof, error: profErr } = await sbAdmin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (!profErr && prof?.id) profile_id = prof.id;

  // //#5 UPSERT
  const { data: saved, error: saveErr } = await sbAdmin
    .from("user_aiou_inputs")
    .upsert({ ...payload, profile_id }, { onConflict: "email" })
    .select()
    .maybeSingle();

  if (saveErr) return respond(500, { error: saveErr.message || "Failed to save AIOU inputs." });

  return respond(200, { ok: true, email, saved });
};

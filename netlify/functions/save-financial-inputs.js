// netlify/functions/save-financial-inputs.js
// ============================================================
// Saves Financial Dashboard input fields to Supabase
// - Requires Authorization: Bearer <supabase_access_token>
// - Upserts into public.user_financial_inputs by email
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

  // //#2 AUTH (verify access token)
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
    purchase_time,          // "ready_now" | "within_6_months" | "unsure"
    monthly_expenses,       // number
    projected_home_price,   // number
    downpayment,            // number
    credit_score            // int
  } = body;

  // light validation (don’t block you, just normalize)
  const payload = {
    email,
    purchase_time: purchase_time ?? null,
    monthly_expenses: monthly_expenses ?? null,
    projected_home_price: projected_home_price ?? null,
    downpayment: downpayment ?? null,
    credit_score: credit_score ?? null,
    updated_at: new Date().toISOString(),
  };

  // //#4 Lookup profile_id (optional but nice)
  let profile_id = null;
  const { data: prof, error: profErr } = await sbAdmin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (!profErr && prof?.id) profile_id = prof.id;

  // //#5 UPSERT
  const { data: saved, error: saveErr } = await sbAdmin
    .from("user_financial_inputs")
    .upsert({ ...payload, profile_id }, { onConflict: "email" })
    .select()
    .maybeSingle();

  if (saveErr) return respond(500, { error: saveErr.message || "Failed to save financial inputs." });

  return respond(200, { ok: true, email, saved });
};

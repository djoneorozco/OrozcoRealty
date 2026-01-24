// netlify/functions/commit-financial-analysis.js
// ============================================================
// Commits a Financial Analysis run (Analyze button)
// - Requires Authorization: Bearer <supabase_access_token>
// - Inserts into public.financial_analysis_runs
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
    inputs,              // json snapshot of inputs used (recommended)
    mortgage_estimate,   // number
    disposable_income,   // number
    financial_health,    // "A" | "B" | "C" | "F" (or your format)
    verdict,             // "GREEN" | "CAUTION" | "NO-GO"
    city_key             // optional
  } = body;

  // //#4 profile_id lookup
  let profile_id = null;
  const { data: prof } = await sbAdmin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (prof?.id) profile_id = prof.id;

  // //#5 INSERT RUN
  const row = {
    email,
    profile_id,
    inputs: inputs ?? {},
    mortgage_estimate: mortgage_estimate ?? null,
    disposable_income: disposable_income ?? null,
    financial_health: financial_health ?? null,
    verdict: verdict ?? null,
    city_key: city_key ?? null,
    created_at: new Date().toISOString(),
  };

  const { data: saved, error: saveErr } = await sbAdmin
    .from("financial_analysis_runs")
    .insert(row)
    .select()
    .maybeSingle();

  if (saveErr) return respond(500, { error: saveErr.message || "Failed to commit analysis." });

  return respond(200, { ok: true, email, saved });
};

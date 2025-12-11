// netlify/functions/profile.js
//
// Returns a single profile row by email from public.profiles
//
// BODY:
//   { email }

import { createClient } from "@supabase/supabase-js";

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

// Initialise Supabase client once (re-used across invocations)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "[profile] Missing Supabase env (SUPABASE_URL or SUPABASE_SERVICE_KEY)"
  );
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function handler(event) {
  // --- 0. CORS preflight ---
  if (event.httpMethod === "OPTIONS") {
    return respond(200, {});
  }

  // --- 1. Enforce POST ---
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // --- 2. Parse body ---
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return respond(400, { error: "Invalid JSON body" });
  }

  const cleanEmail = (body.email || "").trim().toLowerCase();
  if (!cleanEmail) {
    return respond(400, { error: "Email is required" });
  }

  // --- 3. Ensure Supabase configured ---
  if (!supabase) {
    return respond(500, { error: "Supabase env not configured." });
  }

  // --- 4. Fetch profile by email ---
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", cleanEmail)
    .maybeSingle();

  if (error) {
    console.error("[profile] SELECT ERROR:", error);
    return respond(500, { error: "Failed to load profile." });
  }

  if (!data) {
    return respond(404, { error: "Profile not found." });
  }

  // --- 5. Success ---
  return respond(200, {
    ok: true,
    profile: data,
  });
}

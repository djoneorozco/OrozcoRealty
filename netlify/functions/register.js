// netlify/functions/register.js
//
// PURPOSE:
// 1. Create a Supabase Auth user (email + password)
// 2. Insert profile row into public.profiles (no password stored)
// 3. Return { ok: true } if successful
//
// REQUIREMENTS:
// - SUPABASE_URL
// - SUPABASE_SERVICE_KEY  (service role key so we can create auth users)

import { createClient } from "@supabase/supabase-js";

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    const body = JSON.parse(event.body || "{}");

    const {
      email,
      password,
      fullName,
      lastName,
      phone,
      mode,
      rank,
      va_disability,
      yos,
      family,
      base,
      notes
    } = body;

    if (!email || !password || !fullName) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" })
      };
    }

    // ==============================
    //  INIT SUPABASE (SERVICE KEY)
    // ==============================
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY, // service role is REQUIRED to sign up users
      { auth: { persistSession: false } }
    );

    // ==============================
    //  1) CREATE AUTH USER
    // ==============================
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: false // YOU still use 6-digit code flow to confirm email
      });

    if (authError) {
      console.error("Auth createUser error:", authError);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: authError.message })
      };
    }

    const userId = authData.user.id;

    // ==============================
    //  2) INSERT PROFILE RECORD
    // ==============================
    const { error: profileErr } = await supabase.from("profiles").insert([
      {
        email,
        full_name: fullName,
        last_name: lastName || null,
        phone,
        mode,
        rank: rank || null,
        va_disability: va_disability || null,
        yos: yos || null,
        family: family || null,
        base: base || null,
        notes: notes || null,
        auth_user_id: userId // OPTIONAL (only if you add this column)
      }
    ]);

    if (profileErr) {
      console.error("Profile insert error:", profileErr);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Failed to save profile." })
      };
    }

    // Success
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: "User created. Proceed to email verification."
      })
    };

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error during registration." })
    };
  }
};

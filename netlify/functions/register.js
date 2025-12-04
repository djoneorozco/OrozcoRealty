// netlify/functions/register.js
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
      full_name,
      last_name,
      email,
      phone,
      mode,
      rank,
      va_disability,
      yos,
      family,
      base,
      notes,
      password
    } = body;

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Email and password required" })
      };
    }

    // Initialize Supabase with service key (required for user creation)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // 1) CREATE AUTH USER
    const { data: authUser, error: signUpErr } = await supabase.auth.admin.createUser({
      email: email.toLowerCase(),
      password,
      email_confirm: true   // auto-confirm email since you're verifying separately
    });

    if (signUpErr) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: signUpErr.message })
      };
    }

    const userId = authUser.user.id;

    // 2) STORE PROFILE ROW
    const { error: profileErr } = await supabase.from("profiles").upsert({
      id: userId,  // <-- Link profile row to auth user
      email: email.toLowerCase(),
      full_name,
      last_name,
      phone,
      mode,
      rank,
      va_disability,
      yos,
      family,
      base,
      notes,
      created_at: new Date().toISOString()
    });

    if (profileErr) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Failed to save profile." })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: "Account created successfully."
      })
    };

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error." })
    };
  }
};

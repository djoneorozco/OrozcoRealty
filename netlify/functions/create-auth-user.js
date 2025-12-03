// netlify/functions/create-auth-user.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Admin Supabase client (service role)
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Password Rule C: 8+ chars, upper, lower, number
function validatePassword(password) {
  const lengthOK = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);

  return lengthOK && hasUpper && hasLower && hasNumber;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");
    const { email, password, profile } = body;

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "Missing email or password" })
      };
    }

    // Validate password strength
    if (!validatePassword(password)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          ok: false,
          error:
            "Password must be 8+ characters and include uppercase, lowercase, and a number."
        })
      };
    }

    // Create Supabase Auth user
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // auto-confirm since you run your own verification
      user_metadata: profile || {}
    });

    if (error) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: error.message })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        user_id: data.user?.id || null,
        message: "Auth user created successfully"
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
}

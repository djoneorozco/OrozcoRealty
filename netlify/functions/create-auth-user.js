// netlify/functions/create-auth-user.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // requires "service_role" key

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method Not Allowed" })
      };
    }

    const data = JSON.parse(event.body || "{}");
    const { email, password } = data;

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email or password." })
      };
    }

    // ===== CREATE AUTH USER VIA ADMIN API =====
    const { data: userData, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false, // user will confirm via your verification code
    });

    if (error) {
      console.error("Auth create error:", error);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: error.message || "Failed to create auth user." })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        user_id: userData.user?.id || null
      })
    };

  } catch (err) {
    console.error("Unhandled error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}

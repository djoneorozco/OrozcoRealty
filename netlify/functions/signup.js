// netlify/functions/signup.js
import { createClient } from "@supabase/supabase-js";

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    const { email, password } = JSON.parse(event.body || "{}");

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Email and password required" })
      };
    }

    // Initialize Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Create user
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (error) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: error.message })
      };
    }

    // Automatically sign them in
    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (loginError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: loginError.message })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Account created successfully.",
        session: loginData.session
      })
    };

  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error." })
    };
  }
};

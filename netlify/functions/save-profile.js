// netlify/functions/save-profile.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const data = JSON.parse(event.body);

    // Insert or update based on email
    const { error } = await supabase
      .from("profiles")
      .upsert(
        {
          email: data.email,
          full_name: data.full_name,
          phone: data.phone,
          mode: data.mode,
          rank: data.rank || null,
          va_disability: data.va_disability || null,
          years_of_service: data.yos,
          family_size: data.family,
          base: data.base,
          notes: data.notes
        },
        { onConflict: "email" }
      );

    if (error) {
      console.error("Supabase Error:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ message: "Failed to save profile", error })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Profile saved successfully" })
    };

  } catch (err) {
    console.error("Handler Error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Server error", err })
    };
  }
}

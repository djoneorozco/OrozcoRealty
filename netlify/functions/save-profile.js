// netlify/functions/save-profile.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

export default async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const data = JSON.parse(event.body);

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
      console.error("Supabase Upsert Error:", error);
      return new Response(
        JSON.stringify({
          message: "Failed to save profile",
          error: error.message
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({ message: "Profile saved successfully" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Server Error:", err);
    return new Response(
      JSON.stringify({ message: "Server error", error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

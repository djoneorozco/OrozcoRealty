// netlify/functions/send-code.js
//
// PURPOSE:
// - Accept POST { email, rank, lastName, phone }
// - Generate 6-digit code
// - Hash code (never store raw code)
// - Insert row into Supabase (email_codes table)
// - Send code via Resend email (HTML + text)
// - Return { ok: true }

import crypto from "crypto";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, payloadObj) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payloadObj || {}),
  };
}

function makeCode() {
  const n = crypto.randomInt(0, 1000000);
  return n.toString().padStart(6, "0");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export async function handler(event, context) {
  if (event.httpMethod === "OPTIONS") return respond(200, {});
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return respond(400, { error: "Invalid JSON body" });
  }

  const email = (body.email || "").trim().toLowerCase();
  const rank = body.rank || "";
  const lastName = body.lastName || "";
  const phone = body.phone || "";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return respond(400, { error: "Valid email required" });
  }

  // === Generate and hash 6-digit code ===
  const code = makeCode();
  const code_hash = hashCode(code);
  const now = new Date().toISOString();

  // Josue preference: no real expiration yet, fixed far-future date
  const expiresAt = new Date("2075-01-01T00:00:00Z").toISOString();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { error: "Supabase env not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // === Insert into email_codes ===
  const { error: insertErr } = await supabase.from("email_codes").insert([
    {
      email,
      code_hash,
      attempts: 0,
      created_at: now,
      expires_at: expiresAt,
      rank,
      last_name: lastName,
      phone,
      context: { rank, lastName, phone },
    },
  ]);

  if (insertErr) {
    console.error("Supabase insert error:", insertErr);
    return respond(500, { error: "DB insert failed." });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error("Missing RESEND_API_KEY");
    return respond(500, { error: "Email env not configured" });
  }

  const fromAddress =
    process.env.EMAIL_FROM ||
    process.env.FROM_EMAIL ||
    "RealtySaSS <noreply@example.com>";

  const resend = new Resend(resendKey);

  const subject = "Your RealtySaSS Verification Code";

  const textBody = `Hi ${rank ? rank + " " : ""}${lastName || ""},

Your verification code is: ${code}

Do not share this code. It is for you only.
`;

  const htmlEmailBody = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <style>
        body {
          background-color: #f9fafb;
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        .container {
          max-width: 480px;
          margin: 40px auto;
          background: white;
          border-radius: 8px;
          padding: 32px;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
        }
        .logo {
          display: block;
          margin: 0 auto 24px;
          max-height: 60px;
        }
        h1 {
          font-size: 20px;
          color: #1a1a1a;
          text-align: center;
          margin-bottom: 0.5rem;
        }
        p {
          font-size: 14px;
          color: #333;
          text-align: center;
          margin: 8px 0;
        }
        .code-box {
          margin: 24px auto;
          background: #f0f4f8;
          border-radius: 8px;
          font-size: 28px;
          font-weight: bold;
          letter-spacing: 4px;
          padding: 16px;
          text-align: center;
          color: #1a1a1a;
          width: fit-content;
          box-shadow: 0 3px 6px rgba(0,0,0,0.08);
        }
        .footer {
          font-size: 12px;
          color: #777;
          text-align: center;
          margin-top: 24px;
        }
        .signature {
          margin-top: 24px;
          text-align: left;
          font-size: 13px;
          color: #333;
        }
        .signature img {
          max-height: 60px;
          margin-top: 12px;
          border-radius: 8px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <img src="https://cdn.prod.website-files.com/68cecb820ec3dbdca3ef9099/690045801fe6ec061af6b131_1394a00d76ce9dd861ade690dfb1a058_TOR-p-2600.png" alt="OrozcoRealty Logo" class="logo" />
        <h1>Welcome to The Orozco Realty</h1>
        <p><strong>Hi ${rank} ${lastName},</strong></p>
        <p>Your unique verification code for <strong>OrozcoRealty</strong> is:</p>
        <div class="code-box">${code}</div>
        <p>Please safeguard this code and do not share it with anyone.</p>
        <div class="signature">
          Sincerely Yours,<br />
          <strong>Elena</strong><br />
          <em>"A.I. Concierge"</em><br />
          <img src="https://cdn.prod.website-files.com/68cecb820ec3dbdca3ef9099/68db342a77ed69fc1044ebee_5aaaff2bff71a700da3fa14548ad049f_Landing%20Footer%20Background.png" alt="Elena Signature Image" />
        </div>
        <div class="footer">
          "OrozcoReatly.ai™ — An A.I Powered Real Estate & Intelligence Company<br />
          © 2025 The Orozco Realty. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await resend.emails.send({
      from: fromAddress,
      to: [email],
      subject,
      text: textBody,
      html: htmlEmailBody,
    });
  } catch (mailErr) {
    console.error("Resend error:", mailErr);
    return respond(500, { error: "Email send failed" });
  }

  return respond(200, {
    ok: true,
    message: "Code created, stored, and emailed.",
  });
}

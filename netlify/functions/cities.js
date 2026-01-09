// netlify/functions/city.js
// ============================================================
// PUBLIC CITY JSON SERVE ENDPOINT (Webflow-safe)
// GET  /api/city?cityKey=SanAntonio
// POST /api/city  { "cityKey": "SanAntonio" }
//
// Uses Netlify bundling + included_files:
// [functions].included_files = ["netlify/functions/cities/**", ...]
//
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

export const handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS, body: "" };
    }

    let cityKey = event.queryStringParameters?.cityKey || "";

    if (!cityKey && event.body) {
      try {
        const parsed = JSON.parse(event.body);
        cityKey = parsed?.cityKey || "";
      } catch {
        // ignore
      }
    }

    cityKey = String(cityKey || "").trim();

    if (!cityKey) {
      return {
        statusCode: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing cityKey" }),
      };
    }

    // safety: prevent path traversal
    if (!/^[A-Za-z0-9_-]+$/.test(cityKey)) {
      return {
        statusCode: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid cityKey format" }),
      };
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const filePath = path.join(__dirname, "cities", `${cityKey}.json`);

    const raw = await fs.readFile(filePath, "utf8");

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
      body: raw,
    };
  } catch (err) {
    return {
      statusCode: 404,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "City JSON not found",
        detail: String(err?.message || err),
      }),
    };
  }
};

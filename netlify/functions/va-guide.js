// netlify/functions/va-guide.js
// ============================================================
// //#1 VA BUYER'S GUIDE JSON FEED — v1.0
// PURPOSE:
// - Serve your VA Buyer's Guide JSON to Webflow (or any client)
// - Avoid Webflow Assets .json upload limitations
// - Provide CORS + caching controls
//
// URL:
// - https://<your-site>.netlify.app/.netlify/functions/va-guide
// - or (recommended, because you already have /api/* redirect)
//   https://<your-site>.netlify.app/api/va-guide
//
// OPTIONAL QUERY PARAMS:
// - ?lite=1   -> returns a lightweight index (sections only) if present
// ============================================================

import fs from "fs/promises";
import path from "path";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

function jsonResponse(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      // Keep it fast; you can change later if you want aggressive caching
      "Cache-Control": "public, max-age=300",
      ...extraHeaders
    },
    body: JSON.stringify(obj)
  };
}

export const handler = async (event) => {
  // //#2 CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    // //#3 Resolve file paths (bundling-safe)
    // Recommended location: netlify/functions/data/va_buyers_guide.json
    const baseDir = process.cwd(); // Netlify function bundle working dir
    const fullPath = path.join(baseDir, "netlify", "functions", "data", "va_buyers_guide.json");
    const litePath = path.join(baseDir, "netlify", "functions", "data", "va_buyers_guide_index.json");

    const params = event.queryStringParameters || {};
    const lite = String(params.lite || "") === "1";

    const fileToRead = lite ? litePath : fullPath;

    // //#4 Read + parse
    const raw = await fs.readFile(fileToRead, "utf8");
    const data = JSON.parse(raw);

    // //#5 Respond
    return jsonResponse(200, { ok: true, ...data }, {
      // Useful for debugging / versioning
      "X-VA-Guide-Mode": lite ? "lite" : "full"
    });

  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: "VA guide JSON could not be loaded.",
      detail: String(err?.message || err)
    }, { "Cache-Control": "no-store" });
  }
};

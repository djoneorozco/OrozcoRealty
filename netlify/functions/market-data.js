// ============================================================
// The Orozco Realty • Market Data API
// netlify/functions/market-data.js
// v1.0.0
//
// PURPOSE
// - Public API wrapper for JSON files stored inside:
//   netlify/functions/data/market/
// - Browser calls:
//   /api/market-data?city=san-antonio
// ============================================================

import fs from "fs/promises";
import path from "path";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json"
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(body)
  };
}

function safeSlug(value) {
  return String(value || "san-antonio")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/--+/g, "-") || "san-antonio";
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: HEADERS,
      body: ""
    };
  }

  if (event.httpMethod !== "GET") {
    return json(405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const city = safeSlug(event.queryStringParameters?.city || "san-antonio");

    const filePath = path.join(
      process.cwd(),
      "netlify",
      "functions",
      "data",
      "market",
      `${city}.json`
    );

    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);

    return json(200, {
      ok: true,
      city,
      source: `netlify/functions/data/market/${city}.json`,
      data
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err?.message || String(err)
    });
  }
}

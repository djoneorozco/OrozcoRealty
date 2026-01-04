// netlify/functions/pay-tables.js
//
// Computes REAL Base Pay + REAL BAH using your actual militaryPayTables.json
// JSON structure you provided, including BASEPAY and BAH_TX.
//
// RETURNS:
// { ok, rank, rankTitle, yos, zip, basePay, bah, total }

import fs from "fs";
import path from "path";

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: cors(),
        body: JSON.stringify({ ok: false, error: "Method not allowed" })
      };
    }

    // Parse incoming request
    const body = JSON.parse(event.body || "{}");

    const rank = (body.rank || "").trim();       // "E-9"
    const yos = Number(body.yos || 0);           // 0–30 years
    const zip = (body.zip || "").trim();         // e.g., "78236"
    const family = Boolean(body.family);         // with dependents = true

    if (!rank) return fail("Rank missing.");
    if (!yos && yos !== 0) return fail("Years of service missing.");
    if (!zip) return fail("ZIP code missing (needed for BAH).");

    // Load full JSON dataset
    const filePath = path.resolve("netlify/functions/data/militaryPayTables.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);

    // ===========================
    // 1. BASE PAY LOOKUP
    // ===========================
    const payTable = json.BASEPAY?.[rank] || null;

    if (!payTable) return fail(`No base pay table found for rank ${rank}`);

    // Find exact or highest available YOS
    let yosKey = Object.keys(payTable).find(k => Number(k) === yos);

    if (!yosKey) {
      const sorted = Object.keys(payTable).map(Number).sort((a,b)=>a-b);
      yosKey = String(sorted[sorted.length - 1]);
    }

    const basePay = Number(payTable[yosKey] || 0);

    // ===========================
    // 2. BAH LOOKUP
    // ===========================
    const bahZip = json.BAH_TX?.[zip] || null;

    if (!bahZip) return fail(`No BAH data found for ZIP ${zip}`);

    const bahRankBlock = family
      ? bahZip.with?.[rank]
      : bahZip.without?.[rank];

    if (!bahRankBlock && bahRankBlock !== 0) {
      return fail(`BAH not found for rank ${rank} at ZIP ${zip}`);
    }

    const bah = Number(bahRankBlock || 0);

    // ===========================
    // 3. RANK TITLE
    // ===========================
    const RANK_TITLES = {
      "E-1": "Airman Basic",
      "E-2": "Airman",
      "E-3": "Airman First Class",
      "E-4": "Senior Airman",
      "E-5": "Staff Sergeant",
      "E-6": "Technical Sergeant",
      "E-7": "Master Sergeant",
      "E-8": "Senior Master Sergeant",
      "E-9": "Chief Master Sergeant",

      "O-1": "Second Lieutenant",
      "O-2": "First Lieutenant",
      "O-3": "Captain",
      "O-4": "Major",
      "O-5": "Lieutenant Colonel",
      "O-6": "Colonel",
      "O-7": "Brigadier General"
    };

    const rankTitle = RANK_TITLES[rank] || rank;

    // ===========================
    // 4. TOTAL COMPENSATION
    // ===========================
    const total = basePay + bah;

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        ok: true,
        rank,
        rankTitle,
        yos,
        zip,
        basePay,
        bah,
        total
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({
        ok: false,
        error: "Server error",
        details: err.message
      })
    };
  }
};

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*"
  };
}

function fail(msg) {
  return {
    statusCode: 400,
    headers: cors(),
    body: JSON.stringify({ ok: false, error: msg })
  };
}

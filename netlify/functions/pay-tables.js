// netlify/functions/pay-tables.js
//
// Computes REAL Base Pay + REAL BAH based on:
// rank, yos (years of service), base location, family status
//
// RETURNS exactly what your dashboard expects:
// { ok, rankTitle, basePay, bah, total }

import fs from "fs";
import path from "path";

export const handler = async (event) => {
  try {
    // ===========================
    // 0. ONLY ALLOW POST REQUESTS
    // ===========================
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: cors(),
        body: JSON.stringify({ ok: false, error: "Method not allowed" })
      };
    }

    // ===========================
    // 1. PARSE INPUT
    // ===========================
    const body = JSON.parse(event.body || "{}");

    const rank = (body.rank || "").trim();         // "E-9"
    const yos = Number(body.yos || 0);             // 1–30 years
    const base = (body.base || "").trim();         // "Nellis"
    const family = Boolean(body.family);           // true = with dependents

    if (!rank) return fail("Rank missing.");
    if (!yos) return fail("Years of service missing.");
    if (!base) return fail("Base location missing.");

    // ===========================
    // 2. LOAD YOUR ACTUAL PAY TABLE FILE
    //    (Was wrong before — corrected now)
    // ===========================
    const payFile = path.resolve("netlify/functions/data/PayTables.json");
    const rawPay = fs.readFileSync(payFile, "utf8");
    const payJson = JSON.parse(rawPay);

    // ===========================
    // 3. LOAD BASE-SPECIFIC BAH DATA
    // ===========================
    const bahFile = path.resolve(`netlify/functions/cities/${base}.json`);
    const rawBah = fs.readFileSync(bahFile, "utf8");
    const bahJson = JSON.parse(rawBah);

    // ===========================
    // 4. FIND BASE PAY
    // ===========================
    const payTable = payJson.basePay?.[rank] || null;

    if (!payTable) return fail(`No pay table found for ${rank}`);

    // Find exact or closest YOS
    let yosKey = Object.keys(payTable).find(k => Number(k) === yos);

    // If exact isn't listed, use highest available bracket
    if (!yosKey) {
      const sorted = Object.keys(payTable).map(Number).sort((a,b)=>a-b);
      yosKey = String(sorted[sorted.length - 1]);
    }

    const basePay = Number(payTable[yosKey] || 0);

    // ===========================
    // 5. FIND BAH
    // ===========================
    if (!bahJson?.bah) return fail(`BAH table missing for base ${base}`);

    const bahRank = bahJson.bah[rank] || bahJson.bah[rank.toUpperCase()] || null;

    if (!bahRank) return fail(`BAH not found for rank ${rank} at ${base}`);

    const bah = Number(family ? bahRank.with_dep : bahRank.single);

    // ===========================
    // 6. RANK TITLE
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
      "E-9": "Chief Master Sergeant"
    };

    const rankTitle = RANK_TITLES[rank] || rank;

    // ===========================
    // 7. TOTAL COMPENSATION
    // ===========================
    const total = basePay + bah;

    // ===========================
    // 8. RETURN EXACT FORMAT UI EXPECTS
    // ===========================
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        ok: true,
        rank,
        rankTitle,
        yos,
        base,
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

// CORS helper
function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*"
  };
}

// Simple helper
function fail(msg) {
  return {
    statusCode: 400,
    headers: cors(),
    body: JSON.stringify({ ok: false, error: msg })
  };
}

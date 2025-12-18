// netlify/functions/admin-export.js
//
// Admin-only export endpoint to retrieve data from Supabase tables.
// - Uses SUPABASE_SERVICE_KEY (service role) => bypasses RLS
// - Protects access via x-admin-token header
//
// ENV required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   ADMIN_EXPORT_TOKEN
//
// Usage examples:
//   GET /.netlify/functions/admin-export?table=profiles
//   GET /.netlify/functions/admin-export?table=profiles&page=1&pageSize=1000
//   GET /.netlify/functions/admin-export?all=1  (exports multiple tables)
//
// Header required:
//   x-admin-token: <ADMIN_EXPORT_TOKEN>

const { createClient } = require("@supabase/supabase-js");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json"
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload || {})
  };
}

// Constant-time-ish compare (simple + good enough for this use)
function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function getHeader(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : "";
}

async function fetchAllRows(supabase, table, selectCols = "*", pageSize = 1000, hardCap = 20000) {
  const out = [];
  let page = 0;

  while (out.length < hardCap) {
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from(table)
      .select(selectCols)
      .range(from, to);

    if (error) throw new Error(error.message || String(error));
    const rows = Array.isArray(data) ? data : [];

    out.push(...rows);

    if (rows.length < pageSize) break; // done
    page += 1;
  }

  return out;
}

exports.handler = async function (event) {
  // CORS
  if (event.httpMethod === "OPTIONS") return respond(200, { ok: true });
  if (event.httpMethod !== "GET") return respond(405, { ok: false, error: "Method not allowed" });

  // Env
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_EXPORT_TOKEN = process.env.ADMIN_EXPORT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return respond(500, { ok: false, error: "Supabase env not configured." });
  }
  if (!ADMIN_EXPORT_TOKEN) {
    return respond(500, { ok: false, error: "ADMIN_EXPORT_TOKEN env not configured." });
  }

  // Auth
  const token = getHeader(event, "x-admin-token");
  if (!safeEqual(token, ADMIN_EXPORT_TOKEN)) {
    return respond(401, { ok: false, error: "Unauthorized" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Query params
  const params = event.queryStringParameters || {};
  const table = String(params.table || "profiles").trim();
  const all = String(params.all || "").trim() === "1";

  const pageSize = Math.max(1, Math.min(5000, Number(params.pageSize || 1000)));
  const hardCap = Math.max(1, Math.min(100000, Number(params.hardCap || 20000)));

  // Allowlist tables (add more if you want)
  const ALLOWED_TABLES = new Set(["profiles", "email_codes"]);
  const TABLES_FOR_ALL = ["profiles", "email_codes"];

  try {
    if (all) {
      const result = {};
      for (const t of TABLES_FOR_ALL) {
        if (!ALLOWED_TABLES.has(t)) continue;

        // By default, avoid returning the verification "code" field unless explicitly requested
        // (remove this if you truly want everything).
        const includeCodes = String(params.include_codes || "").trim() === "1";
        const selectCols =
          (t === "email_codes" && !includeCodes)
            ? "email,name,rank,income,expenses,projected_mortgage,status,created_at,last_used"
            : "*";

        result[t] = await fetchAllRows(supabase, t, selectCols, pageSize, hardCap);
      }

      return respond(200, {
        ok: true,
        exported: Object.keys(result),
        counts: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])),
        data: result
      });
    }

    if (!ALLOWED_TABLES.has(table)) {
      return respond(400, {
        ok: false,
        error: `Table not allowed. Allowed: ${Array.from(ALLOWED_TABLES).join(", ")}`
      });
    }

    const includeCodes = String(params.include_codes || "").trim() === "1";
    const selectCols =
      (table === "email_codes" && !includeCodes)
        ? "email,name,rank,income,expenses,projected_mortgage,status,created_at,last_used"
        : "*";

    const data = await fetchAllRows(supabase, table, selectCols, pageSize, hardCap);

    return respond(200, {
      ok: true,
      table,
      count: data.length,
      pageSize,
      hardCap,
      data
    });
  } catch (e) {
    return respond(500, { ok: false, error: e.message || String(e) });
  }
};

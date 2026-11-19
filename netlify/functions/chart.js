//#1 Imports & constants
/*  Chart.js edge-cache proxy for Netlify Functions
    - Fetches the UMD build from jsDelivr
    - Caches aggressively with ETag support
    - Allows version pinning via ?v=4.4.4 (defaults below)
    Usage in HTML:
      <script src="/.netlify/functions/chart?v=4.4.4" onload="z1Boot()"></script>
*/
const DEFAULT_VERSION = "4.4.4";
const BASE = "https://cdn.jsdelivr.net/npm/chart.js@{VER}/dist/chart.umd.min.js";

//#2 Small helpers
const okVersion = (v) => /^(\d+\.)?(\d+\.)?(\*|\d+)$/.test(v); // e.g., 4.4.4
const buildUrl = (ver) => BASE.replace("{VER}", ver);

//#3 Minimal inline fallback (only used if CDN fails)
const FALLBACK_STUB = `/* Chart.js fallback stub (CDN fetch failed) */
window.Chart = window.Chart || (function(){
  console.warn("[Zipped] Chart.js CDN failed. Using no-op stub.");
  function Noop(){ return {
    destroy(){}, update(){}, resize(){}, toBase64Image(){ return ""; }
  }; }
  return function(){ return new Noop(); };
}());`;

//#4 Handler
export const handler = async (event) => {
  try {
    // 4A) Version from query (?v=4.4.4) with validation
    const url = new URL(event.rawUrl || `https://x.local${event.rawQuery ? "?" + event.rawQuery : ""}`);
    const v = url.searchParams.get("v") || DEFAULT_VERSION;
    const ver = okVersion(v) ? v : DEFAULT_VERSION;

    // 4B) Compose CDN URL & set headers
    const cdnUrl = buildUrl(ver);
    const reqHeaders = {};

    // Pass through If-None-Match for 304 handling
    if (event.headers && event.headers["if-none-match"]) {
      reqHeaders["If-None-Match"] = event.headers["if-none-match"];
    }

    // 4C) Fetch from CDN
    const resp = await fetch(cdnUrl, { headers: reqHeaders });

    // 4D) If CDN returns 304, reflect it to client
    if (resp.status === 304) {
      return {
        statusCode: 304,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=0, s-maxage=31536000, stale-while-revalidate=86400",
          ETag: resp.headers.get("etag") || "",
        },
        body: "",
      };
    }

    // 4E) If ok, stream body as text
    if (resp.ok) {
      const body = await resp.text();
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          // Cache at edge/CDN; browsers revalidate via ETag
          "Cache-Control": "public, max-age=0, s-maxage=31536000, stale-while-revalidate=86400",
          "ETag": resp.headers.get("etag") || "",
          "X-Chart-Source": cdnUrl,
        },
        body,
      };
    }

    // 4F) Non-OK response -> fallback stub
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Chart-Error": `CDN status ${resp.status}`,
      },
      body: FALLBACK_STUB,
    };
  } catch (err) {
    // 4G) Network or runtime error -> fallback stub
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Chart-Error": err && err.message ? err.message : "unknown",
      },
      body: FALLBACK_STUB,
    };
  }
};

// netlify/functions/stage.js
// OrozcoRealty • RE-Defined Stage Proxy
// v3.0.0
// CommonJS • Node 18+

const crypto = require("crypto");

// ============================================================
// #1) CONFIG
// ============================================================
const DEFAULT_ALLOWED_ORIGINS = [
  "https://new-real-estate-purchase.webflow.io",
  "https://theorozcorealty.netlify.app",
  "https://theorozcorealty.com",
  "https://www.theorozcorealty.com",
  "http://localhost:8888",
  "http://localhost:3000",
  "http://127.0.0.1:8888",
  "http://127.0.0.1:3000",
];

const EXTRA_ALLOWED_ORIGINS = String(process.env.STAGE_ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = Array.from(new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...EXTRA_ALLOWED_ORIGINS,
]));

const ALLOWED_FEATURES = new Set(["staging", "paint", "landscape"]);

const ALLOWED_ROOM_TYPES = new Set([
  "livingroom",
  "kitchen",
  "diningroom",
  "bedroom",
  "bathroom",
  "kidsroom",
  "familyroom",
  "readingnook",
  "sunroom",
  "walkincloset",
  "mudroom",
  "toyroom",
  "office",
  "foyer",
  "powderroom",
  "laundryroom",
  "gym",
  "basement",
  "garage",
  "balcony",
  "cafe",
  "homebar",
  "study_room",
  "front_porch",
  "back_porch",
  "back_patio",
  "openplan",
  "boardroom",
  "meetingroom",
  "openworkspace",
  "privateoffice",
]);

const ALLOWED_DESIGN_STYLES = new Set([
  "modern",
  "minimalist",
  "coastal",
  "contemporary",
  "scandinavian",
  "industrial",
  "farmhouse",
  "traditional",
  "luxury",
  "transitional",
  "bohemian",
]);

const ALLOWED_YARD_TYPES = new Set([
  "Front Yard",
  "Back Yard",
  "Patio",
  "Balcony",
  "Garden",
]);

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_DATA_URL_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LEN = 400;
const TIMEOUT_MS = Math.max(5000, Number(process.env.STAGE_TIMEOUT_MS || 45000));
const ALLOW_DEV_FALLBACK =
  String(process.env.STAGE_ALLOW_DEV_FALLBACK || "true").toLowerCase() === "true";

const DECOR8_BASE = "https://api.decor8.ai";
const ENDPOINTS = {
  staging: `${DECOR8_BASE}/generate_designs_for_room`,
  paint: `${DECOR8_BASE}/change_wall_color`,
  landscape: `${DECOR8_BASE}/generate_landscaping_designs`,
};

// ============================================================
// #2) HELPERS
// ============================================================
function mkRequestId() {
  return `stg_${crypto.randomBytes(8).toString("hex")}`;
}

function getHeader(event, name) {
  return (
    event?.headers?.[name] ||
    event?.headers?.[name.toLowerCase()] ||
    event?.headers?.[name.toUpperCase()] ||
    ""
  );
}

function getOrigin(event) {
  return (
    getHeader(event, "origin") ||
    event?.multiValueHeaders?.origin?.[0] ||
    ""
  ).trim();
}

function isAllowedOrigin(origin) {
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

function buildCorsHeaders(origin, acrh = "") {
  const requested = String(acrh || "")
    .split(",")
    .map(h => h.trim())
    .filter(Boolean);

  const allowHeaders = Array.from(new Set([
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Stage-Debug",
    ...requested,
  ])).join(", ");

  const fallbackOrigin = ALLOWED_ORIGINS[0] || "https://theorozcorealty.netlify.app";
  const allowOrigin = isAllowedOrigin(origin) ? origin : fallbackOrigin;

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function json(statusCode, headers, obj) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(obj),
  };
}

function cleanString(value, maxLen = MAX_TEXT_LEN) {
  if (value == null) return "";
  return String(value).trim().slice(0, maxLen);
}

function byteLengthUtf8(str) {
  return Buffer.byteLength(String(str || ""), "utf8");
}

function isHttpUrl(str) {
  try {
    const u = new URL(String(str));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isDataImageUrl(str) {
  return /^data:image\/(png|jpeg|jpg|webp|heic|heif);base64,[a-z0-9+/=\s]+$/i.test(String(str || ""));
}

function isHexColor(str) {
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(String(str || "").trim());
}

function normalizeFeature(feature) {
  const f = cleanString(feature).toLowerCase();
  return ALLOWED_FEATURES.has(f) ? f : "";
}

function normalizeRoomType(room) {
  const r = cleanString(room).toLowerCase();
  return ALLOWED_ROOM_TYPES.has(r) ? r : "";
}

function normalizeDesignStyle(style) {
  const s = cleanString(style).toLowerCase();
  return ALLOWED_DESIGN_STYLES.has(s) ? s : "";
}

function normalizeYardType(yard) {
  const y = cleanString(yard);
  return ALLOWED_YARD_TYPES.has(y) ? y : "";
}

function maybeDataUrlTooLarge(inputImage) {
  return isDataImageUrl(inputImage) && byteLengthUtf8(inputImage) > MAX_DATA_URL_BYTES;
}

function allowDevFallback(event, origin) {
  const host = getHeader(event, "host");
  const isLocal =
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1") ||
    String(host).includes("localhost") ||
    String(host).includes("127.0.0.1");

  const isPreview =
    origin.includes(".webflow.io") ||
    origin.includes("netlify.app");

  return ALLOW_DEV_FALLBACK && (isLocal || isPreview);
}

function toErrorPayload(requestId, code, message, extra = {}) {
  return {
    ok: false,
    request_id: requestId,
    code,
    error: message,
    ...extra,
  };
}

function extractImagesArray(data) {
  const raw =
    data?.images ||
    data?.info?.images ||
    data?.result?.images ||
    data?.output?.images ||
    data?.data?.images ||
    [];

  if (!Array.isArray(raw)) return [];

  return raw
    .map(img => {
      if (typeof img === "string") return { url: img };
      if (img && typeof img === "object" && img.url) {
        return {
          url: img.url,
          width: Number(img.width) || undefined,
          height: Number(img.height) || undefined,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function extractFirstImageUrl(data) {
  return (
    data?.image_url ||
    data?.url ||
    data?.info?.url ||
    data?.images?.[0]?.url ||
    data?.info?.images?.[0]?.url ||
    data?.result?.images?.[0]?.url ||
    data?.output?.images?.[0]?.url ||
    data?.data?.images?.[0]?.url ||
    ""
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function mapLandscapeStyleToGardenStyle(style) {
  const s = String(style || "").toLowerCase();
  const map = {
    modern: "Modern",
    minimalist: "Modern",
    coastal: "Tropical",
    contemporary: "Modern",
    scandinavian: "Minimalist",
    industrial: "Modern",
    farmhouse: "Cottage",
    traditional: "Classic",
    luxury: "Luxury",
    transitional: "Classic",
    bohemian: "Tropical",
  };
  return map[s] || "Garden";
}

function validatePayload(payload) {
  const feature = normalizeFeature(payload.feature);
  const inputImage = cleanString(payload.input_image_url, 8_000_000);
  const roomType = normalizeRoomType(payload.room_type);
  const designStyle = normalizeDesignStyle(payload.design_style);
  const paintColorHex = cleanString(payload.paint_color_hex, 20);
  const yardType = normalizeYardType(payload.yard_type);
  const source = cleanString(payload.source || "orozcorealty-redefined", 80);
  const email = cleanString(payload.email, 200);

  if (!feature) {
    return { ok: false, message: "feature is required and must be staging, paint, or landscape" };
  }

  if (!inputImage) {
    return { ok: false, message: "input_image_url is required" };
  }

  if (!(isHttpUrl(inputImage) || isDataImageUrl(inputImage))) {
    return { ok: false, message: "input_image_url must be an http/https URL or data:image base64 URL" };
  }

  if (isDataImageUrl(inputImage) && maybeDataUrlTooLarge(inputImage)) {
    return { ok: false, message: "Base64 image exceeds the 4 MB limit" };
  }

  if (feature === "staging") {
    if (!roomType) return { ok: false, message: "room_type is required for staging" };
    if (!designStyle) return { ok: false, message: "design_style is required for staging" };
  }

  if (feature === "paint") {
    if (!paintColorHex || !isHexColor(paintColorHex)) {
      return { ok: false, message: "paint_color_hex is required for paint and must be a valid HEX color" };
    }
  }

  if (feature === "landscape") {
    if (!yardType) return { ok: false, message: "yard_type is required for landscape" };
  }

  return {
    ok: true,
    normalized: {
      feature,
      input_image_url: inputImage,
      room_type: roomType || undefined,
      design_style: designStyle || undefined,
      paint_color_hex: paintColorHex || undefined,
      yard_type: yardType || undefined,
      source,
      email: email || undefined,
    },
  };
}

function buildDecor8Request(normalized) {
  if (normalized.feature === "staging") {
    return {
      endpoint: process.env.STAGE_API_URL || ENDPOINTS.staging,
      payload: {
        input_image_url: normalized.input_image_url,
        room_type: normalized.room_type,
        design_style: normalized.design_style,
        num_images: 1,
      },
    };
  }

  if (normalized.feature === "paint") {
    return {
      endpoint: process.env.STAGE_API_URL || ENDPOINTS.paint,
      payload: {
        input_image_url: normalized.input_image_url,
        wall_color_hex_code: normalized.paint_color_hex,
        room_type: normalized.room_type || "livingroom",
      },
    };
  }

  return {
    endpoint: process.env.STAGE_API_URL || ENDPOINTS.landscape,
    payload: {
      input_image_url: normalized.input_image_url,
      yard_type: normalized.yard_type,
      garden_style: mapLandscapeStyleToGardenStyle(normalized.design_style),
      num_images: 1,
    },
  };
}

function normalizeSuccessResponse({
  requestId,
  provider,
  mode,
  normalized,
  upstreamData,
}) {
  const images = extractImagesArray(upstreamData);
  const imageUrl = extractFirstImageUrl(upstreamData) || images[0]?.url || "";

  return {
    ok: true,
    request_id: requestId,
    provider,
    mode,
    image_url: imageUrl || null,
    images: imageUrl && images.length === 0 ? [{ url: imageUrl }] : images,
    meta: {
      feature: normalized.feature,
      room_type: normalized.room_type || null,
      design_style: normalized.design_style || null,
      paint_color_hex: normalized.paint_color_hex || null,
      yard_type: normalized.yard_type || null,
      source: normalized.source || "orozcorealty-redefined",
    },
    message: upstreamData?.message || "Success",
  };
}

function makeDevFallback(normalized) {
  const original = normalized.input_image_url;
  return {
    message: "Dev fallback active.",
    image_url: original,
    images: [{ url: original, width: 1600, height: 1067 }],
    info: { images: [{ url: original, width: 1600, height: 1067 }] },
  };
}

// ============================================================
// #3) HANDLER
// ============================================================
module.exports.handler = async (event) => {
  const requestId = mkRequestId();
  const origin = getOrigin(event);
  const acrh = getHeader(event, "access-control-request-headers");
  const headers = buildCorsHeaders(origin, acrh);

  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers, body: "" };
    }

    const host = getHeader(event, "host");
    const isLocalHost = String(host).includes("localhost") || String(host).includes("127.0.0.1");

    if (origin && !isAllowedOrigin(origin) && !isLocalHost) {
      return json(
        403,
        headers,
        toErrorPayload(requestId, "FORBIDDEN_ORIGIN", "Origin not allowed", { origin })
      );
    }

    if (event.httpMethod === "GET") {
      return json(200, headers, {
        ok: true,
        service: "stage",
        version: "3.0.0",
        request_id: requestId,
        provider: "decor8",
      });
    }

    if (event.httpMethod !== "POST") {
      return json(
        405,
        headers,
        toErrorPayload(requestId, "METHOD_NOT_ALLOWED", "Method Not Allowed")
      );
    }

    const rawBody = String(event.body || "");
    if (!rawBody) {
      return json(400, headers, toErrorPayload(requestId, "BAD_REQUEST", "Missing JSON body"));
    }

    if (byteLengthUtf8(rawBody) > MAX_BODY_BYTES) {
      return json(413, headers, toErrorPayload(requestId, "PAYLOAD_TOO_LARGE", "Request body is too large"));
    }

    let payload = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, headers, toErrorPayload(requestId, "BAD_JSON", "Invalid JSON body"));
    }

    const valid = validatePayload(payload);
    if (!valid.ok) {
      return json(400, headers, toErrorPayload(requestId, "BAD_REQUEST", valid.message));
    }

    const normalized = valid.normalized;
    const apiKey =
      cleanString(process.env.DECOR8_API_KEY, 500) ||
      cleanString(process.env.STAGE_API_KEY, 500) ||
      cleanString(process.env.OPENAI_API_KEY, 500);

    if (!apiKey) {
      const canUseFallback = allowDevFallback(event, origin);
      if (canUseFallback) {
        const mock = makeDevFallback(normalized);
        return json(200, headers, normalizeSuccessResponse({
          requestId,
          provider: "mock",
          mode: "dev-fallback",
          normalized,
          upstreamData: mock,
        }));
      }

      return json(
        503,
        headers,
        toErrorPayload(requestId, "MISSING_API_KEY", "DECOR8_API_KEY is not configured")
      );
    }

    const { endpoint, payload: upstreamPayload } = buildDecor8Request(normalized);

    let upstreamResp;
    try {
      upstreamResp = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "X-Request-Id": requestId,
          },
          body: JSON.stringify(upstreamPayload),
        },
        TIMEOUT_MS
      );
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      return json(
        isAbort ? 504 : 502,
        headers,
        toErrorPayload(
          requestId,
          isAbort ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FETCH_ERROR",
          isAbort ? "Decor8 request timed out" : "Failed to reach Decor8"
        )
      );
    }

    const upstreamText = await upstreamResp.text();
    let upstreamData;
    try {
      upstreamData = upstreamText ? JSON.parse(upstreamText) : {};
    } catch {
      upstreamData = { raw: upstreamText };
    }

    if (!upstreamResp.ok) {
      return json(
        upstreamResp.status || 502,
        headers,
        toErrorPayload(
          requestId,
          "UPSTREAM_ERROR",
          upstreamData?.message || upstreamData?.error || "Decor8 request failed",
          {
            status: upstreamResp.status || 502,
            endpoint,
            detail: upstreamData,
          }
        )
      );
    }

    const normalizedResponse = normalizeSuccessResponse({
      requestId,
      provider: "decor8",
      mode: "live",
      normalized,
      upstreamData,
    });

    if (!normalizedResponse.image_url && (!normalizedResponse.images || normalizedResponse.images.length === 0)) {
      return json(
        502,
        headers,
        toErrorPayload(requestId, "BAD_UPSTREAM_RESPONSE", "Decor8 returned no usable image", {
          endpoint,
          detail: upstreamData,
        })
      );
    }

    return json(200, headers, normalizedResponse);
  } catch (err) {
    console.error("[stage.js] unhandled", {
      request_id: requestId,
      error: String(err?.message || err),
    });

    return json(
      500,
      headers,
      toErrorPayload(requestId, "SERVER_EXCEPTION", "Server exception")
    );
  }
};

// netlify/functions/stage.js
// CommonJS • Node 18+
// RE:Defined / OrozcoRealty / PCSUnited compatible
// Decor8-ready feature router

const DEFAULT_ALLOWED_ORIGINS = [
  "https://new-real-estate-purchase.webflow.io",
  "https://pcsu.webflow.io",
  "https://luxury-re.webflow.io",
  "https://theorozcorealty.netlify.app",
  "https://pcsunited.netlify.app",
  "http://localhost:8888",
  "http://localhost:3000"
];

const FALLBACK_WILDCARD = true;

function parseAllowedOrigins() {
  const extra = String(process.env.ALLOW_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]));
}

function buildCorsHeaders(origin, acrh) {
  const allowedOrigins = parseAllowedOrigins();
  const allowed = allowedOrigins.includes(origin);
  const allowOrigin = allowed ? origin : (FALLBACK_WILDCARD ? "*" : (allowedOrigins[0] || "*"));

  const baseAllowed = ["Content-Type", "Authorization", "X-Requested-With"];
  const requested = String(acrh || "")
    .split(",")
    .map(h => h.trim())
    .filter(Boolean);

  const allowHeaders = Array.from(new Set([...baseAllowed, ...requested])).join(", ");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json"
  };
}

function json(statusCode, headers, bodyObj) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(bodyObj)
  };
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function trimString(value) {
  return String(value == null ? "" : value).trim();
}

function sanitizeHex(value, fallback = "") {
  const raw = trimString(value);
  if (!raw) return fallback;
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(withHash) ? withHash.toUpperCase() : fallback;
}

function normalizeFeature(raw) {
  const feature = trimString(raw).toLowerCase();

  const map = {
    "staging": "staging",
    "virtual_staging": "staging",
    "virtual-staging": "staging",

    "redesign": "redesign",
    "room_redesign": "redesign",
    "room-redesign": "redesign",
    "interior_redesign": "redesign",
    "interior-redesign": "redesign",

    "declutter": "declutter",
    "cleanup": "declutter",
    "remove_furniture": "declutter",
    "remove-furniture": "declutter",
    "furniture_removal": "declutter",
    "furniture-removal": "declutter",

    "paint": "paint",
    "wall_paint": "paint",
    "wall-paint": "paint",

    "cabinet": "cabinet",
    "cabinet_color": "cabinet",
    "cabinet-color": "cabinet",
    "kitchen_cabinet_color": "cabinet",
    "kitchen-cabinet-color": "cabinet",

    "landscape": "landscape",
    "landscaping": "landscape",

    "exterior_refresh": "exterior_refresh",
    "exterior-refresh": "exterior_refresh",
    "curb_appeal": "exterior_refresh",
    "curb-appeal": "exterior_refresh",

    "patio_refresh": "patio_refresh",
    "patio-refresh": "patio_refresh",

    "balcony_refresh": "balcony_refresh",
    "balcony-refresh": "balcony_refresh",

    "variations": "variations"
  };

  return map[feature] || "staging";
}

function dataUrlToBase64(dataUrl) {
  const raw = trimString(dataUrl);
  const match = raw.match(/^data:.*?;base64,(.+)$/i);
  return match ? match[1] : "";
}

function inferInputImage(payload) {
  const inputImage = trimString(payload.input_image);
  const inputImageUrl = trimString(payload.input_image_url);

  if (inputImage) {
    return {
      input_image: inputImage,
      input_image_url: inputImageUrl || ""
    };
  }

  if (inputImageUrl && inputImageUrl.startsWith("data:")) {
    return {
      input_image: dataUrlToBase64(inputImageUrl),
      input_image_url: inputImageUrl
    };
  }

  return {
    input_image: "",
    input_image_url: inputImageUrl || ""
  };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function buildFeaturePayload(rawPayload) {
  const feature = normalizeFeature(rawPayload.feature);
  const roomType = trimString(rawPayload.room_type || rawPayload.roomType || "livingroom");
  const yardType = trimString(rawPayload.yard_type || rawPayload.yardType || "Front Yard");
  const designStyle = trimString(rawPayload.design_style || rawPayload.designStyle || "modern");
  const prompt = trimString(rawPayload.prompt || rawPayload.custom_prompt || rawPayload.customPrompt || "");
  const paintColor = sanitizeHex(rawPayload.paint_color_hex || rawPayload.paintColor || "", "#D6D6D6");
  const cabinetColor = sanitizeHex(rawPayload.cabinet_color_hex || rawPayload.cabinetColor || "", "#D6D6D6");
  const numImages = clampInt(rawPayload.num_images || rawPayload.numImages || 1, 1, 4, 1);
  const source = trimString(rawPayload.source || "redefined");
  const email = trimString(rawPayload.email || "");

  const image = inferInputImage(rawPayload);

  const base = {
    feature,
    source,
    email,
    input_image: image.input_image,
    input_image_url: image.input_image_url,
    room_type: roomType,
    design_style: designStyle,
    prompt,
    num_images: numImages
  };

  switch (feature) {
    case "staging":
      return {
        ...base,
        mode: "virtual_staging"
      };

    case "redesign":
      return {
        ...base,
        mode: "room_redesign"
      };

    case "declutter":
      return {
        ...base,
        mode: "furniture_removal",
        remove_furniture: true
      };

    case "paint":
      return {
        ...base,
        mode: "wall_paint",
        paint_color_hex: paintColor
      };

    case "cabinet":
      return {
        ...base,
        mode: "cabinet_color",
        cabinet_color_hex: cabinetColor,
        room_type: roomType || "kitchen"
      };

    case "landscape":
      return {
        ...base,
        mode: "landscape_refresh",
        yard_type: yardType
      };

    case "exterior_refresh":
      return {
        ...base,
        mode: "exterior_refresh",
        yard_type: yardType
      };

    case "patio_refresh":
      return {
        ...base,
        mode: "patio_refresh",
        yard_type: "Patio"
      };

    case "balcony_refresh":
      return {
        ...base,
        mode: "balcony_refresh",
        yard_type: "Balcony"
      };

    case "variations":
      return {
        ...base,
        mode: "variations"
      };

    default:
      return {
        ...base,
        mode: "virtual_staging"
      };
  }
}

function getFeatureEndpoint(feature, forceDev) {
  if (forceDev) return "";

  const generic = trimString(
    process.env.STAGE_API_URL ||
    process.env.DECOR8_API_URL ||
    process.env.DECOR8_GENERATE_URL ||
    ""
  );

  const featureMap = {
    staging: trimString(process.env.STAGE_ENDPOINT_STAGING || ""),
    redesign: trimString(process.env.STAGE_ENDPOINT_REDESIGN || ""),
    declutter: trimString(process.env.STAGE_ENDPOINT_DECLUTTER || ""),
    paint: trimString(process.env.STAGE_ENDPOINT_PAINT || ""),
    cabinet: trimString(process.env.STAGE_ENDPOINT_CABINET || ""),
    landscape: trimString(process.env.STAGE_ENDPOINT_LANDSCAPE || ""),
    exterior_refresh: trimString(process.env.STAGE_ENDPOINT_EXTERIOR || ""),
    patio_refresh: trimString(process.env.STAGE_ENDPOINT_PATIO || ""),
    balcony_refresh: trimString(process.env.STAGE_ENDPOINT_BALCONY || ""),
    variations: trimString(process.env.STAGE_ENDPOINT_VARIATIONS || "")
  };

  return featureMap[feature] || generic || "";
}

function buildUpstreamHeaders() {
  const apiKey =
    trimString(process.env.DECOR8_API_KEY) ||
    trimString(process.env.STAGE_API_KEY) ||
    trimString(process.env.OPENAI_API_KEY) ||
    "";

  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }

  return headers;
}

function extractFirstImageUrl(data) {
  return (
    data?.image_url ||
    data?.url ||
    data?.images?.[0]?.url ||
    data?.info?.images?.[0]?.url ||
    data?.result?.images?.[0]?.url ||
    data?.output?.images?.[0]?.url ||
    data?.data?.images?.[0]?.url ||
    ""
  );
}

module.exports.handler = async (event) => {
  const origin =
    event.headers?.origin ||
    event.headers?.Origin ||
    event.multiValueHeaders?.origin?.[0] ||
    "";

  const acrh =
    event.headers?.["access-control-request-headers"] ||
    event.headers?.["Access-Control-Request-Headers"] ||
    "";

  const headers = buildCorsHeaders(origin, acrh);

  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers, body: "" };
    }

    const host = event.headers?.host || "localhost";
    const rawUrl = event.rawUrl || `https://${host}${event.path || "/.netlify/functions/stage"}`;
    const url = new URL(rawUrl);
    const forceDev = url.searchParams.get("forceDev") === "1";

    if (event.httpMethod === "GET") {
      return json(200, headers, {
        ok: true,
        service: "stage",
        version: "3.0.0",
        supports: [
          "staging",
          "redesign",
          "declutter",
          "paint",
          "cabinet",
          "landscape",
          "exterior_refresh",
          "patio_refresh",
          "balcony_refresh",
          "variations"
        ],
        expects: {
          method: "POST",
          json: {
            feature: "staging",
            input_image_url: "data:image/jpeg;base64,... OR https://...",
            room_type: "livingroom",
            design_style: "modern",
            num_images: 1
          }
        },
        env: {
          generic_upstream: !!trimString(process.env.STAGE_API_URL || process.env.DECOR8_API_URL || ""),
          feature_endpoints: {
            staging: !!trimString(process.env.STAGE_ENDPOINT_STAGING || ""),
            redesign: !!trimString(process.env.STAGE_ENDPOINT_REDESIGN || ""),
            declutter: !!trimString(process.env.STAGE_ENDPOINT_DECLUTTER || ""),
            paint: !!trimString(process.env.STAGE_ENDPOINT_PAINT || ""),
            cabinet: !!trimString(process.env.STAGE_ENDPOINT_CABINET || ""),
            landscape: !!trimString(process.env.STAGE_ENDPOINT_LANDSCAPE || ""),
            exterior: !!trimString(process.env.STAGE_ENDPOINT_EXTERIOR || "")
          }
        },
        cors: {
          origin,
          allowed: parseAllowedOrigins().includes(origin)
        },
        tips: {
          forceDev,
          note: "If you only have one Decor8 endpoint today, set STAGE_API_URL and DECOR8_API_KEY."
        }
      });
    }

    if (event.httpMethod !== "POST") {
      return json(405, headers, { ok: false, error: "Method Not Allowed" });
    }

    const rawPayload = safeJsonParse(event.body || "{}", null);
    if (!rawPayload || typeof rawPayload !== "object") {
      return json(400, headers, { ok: false, error: "Invalid JSON body" });
    }

    const featurePayload = buildFeaturePayload(rawPayload);

    if (!featurePayload.input_image && !featurePayload.input_image_url) {
      return json(400, headers, {
        ok: false,
        error: "Missing input image. Send input_image or input_image_url."
      });
    }

    const upstream = getFeatureEndpoint(featurePayload.feature, forceDev);

    if (upstream) {
      const upstreamHeaders = buildUpstreamHeaders();

      const resp = await fetch(upstream, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(featurePayload)
      });

      const text = await resp.text();
      const data = safeJsonParse(text, { raw: text });

      if (!resp.ok) {
        return json(resp.status || 502, headers, {
          ok: false,
          error: "Upstream error",
          feature: featurePayload.feature,
          status: resp.status,
          detail: data
        });
      }

      return json(200, headers, {
        ok: true,
        feature: featurePayload.feature,
        image_url: extractFirstImageUrl(data),
        upstream: data
      });
    }

    const demo =
      featurePayload.input_image_url ||
      "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=1600&q=80";

    return json(200, headers, {
      ok: true,
      feature: featurePayload.feature,
      image_url: demo,
      info: {
        images: [{ url: demo, width: 1600, height: 1067 }]
      },
      echo: {
        received: featurePayload
      },
      note: "Dev fallback: set STAGE_API_URL and DECOR8_API_KEY (or feature-specific STAGE_ENDPOINT_* vars) in Netlify."
    });
  } catch (err) {
    return json(500, headers, {
      ok: false,
      error: "Server exception",
      detail: String(err?.message || err)
    });
  }
};

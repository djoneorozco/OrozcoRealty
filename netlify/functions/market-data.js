// ============================================================
// The Orozco Realty • Market Data API
// netlify/functions/market-data.js
// v2.0.0 • JSON + Official Census Enrichment
//
// PURPOSE
// - Public API wrapper for JSON files stored inside:
//   netlify/functions/data/market/
// - Enriches demographic fields from official Census ACS profile data
// - Keeps custom TOR market/region intelligence from san-antonio.json
//
// BROWSER CALLS:
// /api/market-data?city=san-antonio
// /api/market-data?city=san-antonio&census=false
// /api/market-data?city=san-antonio&raw=true
//
// REQUIRED ENV:
// CENSUS_API_KEY
//
// REQUIRED FILE:
// netlify/functions/data/market/san-antonio.json
// ============================================================

import fs from "fs/promises";
import path from "path";

const CENSUS_BASE = "https://api.census.gov/data";
const DEFAULT_CENSUS_YEAR = "2024";
const DEFAULT_CENSUS_DATASET = "acs/acs5/profile";

const BASE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=86400, s-maxage=604800"
};

const CITY_CENSUS_DEFAULTS = {
  "san-antonio": {
    state: "48",
    place: "65000",
    label: "San Antonio city, Texas"
  }
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders
    },
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

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value) {
  const n = cleanNumber(value);
  return n === null ? null : Number(n.toFixed(1));
}

function money(value) {
  const n = cleanNumber(value);
  return n === null ? null : Math.round(n);
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function parseGeoId(geoId) {
  const raw = String(geoId || "").trim();

  const placeMatch = raw.match(/^1600000US(\d{2})(\d{5})$/);
  if (placeMatch) {
    return {
      state: placeMatch[1],
      place: placeMatch[2],
      label: `Place ${placeMatch[2]}, State ${placeMatch[1]}`
    };
  }

  const countyMatch = raw.match(/^0500000US(\d{2})(\d{3})$/);
  if (countyMatch) {
    return {
      state: countyMatch[1],
      county: countyMatch[2],
      label: `County ${countyMatch[2]}, State ${countyMatch[1]}`
    };
  }

  return null;
}

function getCityCensusGeo(citySlug, marketJson) {
  const explicit = marketJson?.census_geography;

  if (explicit?.zip) {
    return {
      forValue: `zip code tabulation area:${explicit.zip}`,
      inValue: null,
      label: explicit.label || `ZIP Code Tabulation Area ${explicit.zip}`
    };
  }

  if (explicit?.state && explicit?.place) {
    return {
      forValue: `place:${explicit.place}`,
      inValue: `state:${explicit.state}`,
      label: explicit.label || `Place ${explicit.place}, State ${explicit.state}`
    };
  }

  if (explicit?.state && explicit?.county && explicit?.tract) {
    return {
      forValue: `tract:${explicit.tract}`,
      inValue: `state:${explicit.state} county:${explicit.county}`,
      label: explicit.label || `Tract ${explicit.tract}, County ${explicit.county}, State ${explicit.state}`
    };
  }

  if (explicit?.state && explicit?.county) {
    return {
      forValue: `county:${explicit.county}`,
      inValue: `state:${explicit.state}`,
      label: explicit.label || `County ${explicit.county}, State ${explicit.state}`
    };
  }

  const parsed = parseGeoId(marketJson?.geo_id);
  if (parsed?.state && parsed?.place) {
    return {
      forValue: `place:${parsed.place}`,
      inValue: `state:${parsed.state}`,
      label: parsed.label
    };
  }

  if (parsed?.state && parsed?.county) {
    return {
      forValue: `county:${parsed.county}`,
      inValue: `state:${parsed.state}`,
      label: parsed.label
    };
  }

  const fallback = CITY_CENSUS_DEFAULTS[citySlug];

  if (fallback?.state && fallback?.place) {
    return {
      forValue: `place:${fallback.place}`,
      inValue: `state:${fallback.state}`,
      label: fallback.label
    };
  }

  return null;
}

function getRegionCensusGeo(region) {
  const geo = region?.census_geography;
  if (!geo) return null;

  if (geo.zip) {
    return {
      forValue: `zip code tabulation area:${geo.zip}`,
      inValue: null,
      label: geo.label || `ZIP Code Tabulation Area ${geo.zip}`
    };
  }

  if (geo.state && geo.place) {
    return {
      forValue: `place:${geo.place}`,
      inValue: `state:${geo.state}`,
      label: geo.label || `Place ${geo.place}, State ${geo.state}`
    };
  }

  if (geo.state && geo.county && geo.tract) {
    return {
      forValue: `tract:${geo.tract}`,
      inValue: `state:${geo.state} county:${geo.county}`,
      label: geo.label || `Tract ${geo.tract}, County ${geo.county}, State ${geo.state}`
    };
  }

  if (geo.state && geo.county) {
    return {
      forValue: `county:${geo.county}`,
      inValue: `state:${geo.state}`,
      label: geo.label || `County ${geo.county}, State ${geo.state}`
    };
  }

  return null;
}

async function fetchCensusProfile({ geo, year, dataset, includeRaw }) {
  const key = process.env.CENSUS_API_KEY;

  if (!key) {
    return {
      ok: false,
      error: "Missing CENSUS_API_KEY in Netlify environment variables."
    };
  }

  if (!geo?.forValue) {
    return {
      ok: false,
      error: "Missing Census geography."
    };
  }

  const variables = [
    "NAME",

    // Population / demographics
    "DP05_0001E",
    "DP05_0005PE",
    "DP05_0006PE",
    "DP05_0018E",
    "DP05_0037PE",
    "DP05_0024PE",

    // Race / ethnicity
    "DP05_0038PE",
    "DP05_0039PE",
    "DP05_0044PE",
    "DP05_0071PE",

    // Households / family
    "DP02_0001E",
    "DP02_0016E",
    "DP02_0022PE",
    "DP02_0067PE",

    // Education
    "DP02_0063PE",
    "DP02_0064PE",

    // Income / economy
    "DP03_0009PE",
    "DP03_0051E",
    "DP03_0062E",
    "DP03_0128PE",

    // Commute
    "DP03_0025E",

    // Housing
    "DP04_0001E",
    "DP04_0046PE",
    "DP04_0047PE",
    "DP04_0003PE",
    "DP04_0089E",
    "DP04_0134E"
  ];

  const url = new URL(`${CENSUS_BASE}/${year}/${dataset}`);
  url.searchParams.set("get", variables.join(","));
  url.searchParams.set("for", geo.forValue);
  if (geo.inValue) url.searchParams.set("in", geo.inValue);
  url.searchParams.set("key", key);

  const response = await fetch(url.toString());

  if (!response.ok) {
    const detail = await response.text();

    return {
      ok: false,
      error: "Census API request failed.",
      status: response.status,
      detail
    };
  }

  const rows = await response.json();

  if (!Array.isArray(rows) || rows.length < 2) {
    return {
      ok: false,
      error: "No Census data returned for this geography.",
      geography: geo
    };
  }

  const headers = rows[0];
  const values = rows[1];

  const raw = {};
  headers.forEach((header, index) => {
    raw[header] = values[index];
  });

  const profile = {
    name: raw.NAME || geo.label,
    year,
    dataset,
    geography: geo,

    population: {
      total: cleanNumber(raw.DP05_0001E),
      median_age: cleanNumber(raw.DP05_0018E),
      under_18_pct: pct(raw.DP05_0037PE),
      age_65_plus_pct: pct(raw.DP05_0024PE),
      male_pct: pct(raw.DP05_0005PE),
      female_pct: pct(raw.DP05_0006PE)
    },

    race_ethnicity: {
      white_pct: pct(raw.DP05_0038PE),
      black_pct: pct(raw.DP05_0039PE),
      asian_pct: pct(raw.DP05_0044PE),
      hispanic_latino_pct: pct(raw.DP05_0071PE)
    },

    households: {
      total: cleanNumber(raw.DP02_0001E),
      average_household_size: cleanNumber(raw.DP02_0016E),
      married_couple_family_pct: pct(raw.DP02_0022PE)
    },

    military_veterans: {
      veterans_pct: pct(raw.DP02_0067PE)
    },

    education: {
      high_school_or_higher_pct: pct(raw.DP02_0063PE),
      bachelors_or_higher_pct: pct(raw.DP02_0064PE)
    },

    economy: {
      unemployment_rate_pct: pct(raw.DP03_0009PE),
      median_household_income: money(raw.DP03_0051E),
      per_capita_income: money(raw.DP03_0062E),
      poverty_pct: pct(raw.DP03_0128PE)
    },

    commute: {
      mean_travel_time_minutes: cleanNumber(raw.DP03_0025E)
    },

    housing: {
      total_housing_units: cleanNumber(raw.DP04_0001E),
      owner_occupied_pct: pct(raw.DP04_0046PE),
      renter_occupied_pct: pct(raw.DP04_0047PE),
      vacancy_pct: pct(raw.DP04_0003PE),
      median_home_value: money(raw.DP04_0089E),
      median_gross_rent: money(raw.DP04_0134E)
    }
  };

  return {
    ok: true,
    source: "U.S. Census Bureau ACS 5-Year Data Profile",
    fetched_at: new Date().toISOString(),
    profile,
    raw: includeRaw ? raw : undefined
  };
}

function applyCensusToMarketData(data, censusProfile) {
  if (!data || !censusProfile) return data;

  const next = structuredClone(data);
  const p = censusProfile;

  next.official_census_profile = p;

  next.population = {
    ...(next.population || {}),
    estimate: firstDefined(p.population?.total, next.population?.estimate),
    median_age: firstDefined(p.population?.median_age, next.population?.median_age),
    persons_per_household: firstDefined(
      p.households?.average_household_size,
      next.population?.persons_per_household
    ),
    under_18_pct: firstDefined(p.population?.under_18_pct, next.population?.under_18_pct),
    age_65_plus_pct: firstDefined(p.population?.age_65_plus_pct, next.population?.age_65_plus_pct),
    male_pct: firstDefined(p.population?.male_pct, next.population?.male_pct),
    female_pct: firstDefined(p.population?.female_pct, next.population?.female_pct)
  };

  next.snapshot = {
    ...(next.snapshot || {}),
    population_city: firstDefined(p.population?.total, next.snapshot?.population_city),
    median_household_income: firstDefined(
      p.economy?.median_household_income,
      next.snapshot?.median_household_income
    )
  };

  next.households = {
    ...(next.households || {}),
    total_households: firstDefined(p.households?.total, next.households?.total_households),
    married_couple_family_pct: firstDefined(
      p.households?.married_couple_family_pct,
      next.households?.married_couple_family_pct
    )
  };

  next.income = {
    ...(next.income || {}),
    median_household_income: firstDefined(
      p.economy?.median_household_income,
      next.income?.median_household_income
    ),
    per_capita_income: firstDefined(p.economy?.per_capita_income, next.income?.per_capita_income),
    poverty_rate_percent: firstDefined(p.economy?.poverty_pct, next.income?.poverty_rate_percent)
  };

  next.education = {
    ...(next.education || {}),
    high_school_grad_or_higher_percent: firstDefined(
      p.education?.high_school_or_higher_pct,
      next.education?.high_school_grad_or_higher_percent
    ),
    bachelors_degree_or_higher_percent: firstDefined(
      p.education?.bachelors_or_higher_pct,
      next.education?.bachelors_degree_or_higher_percent
    )
  };

  next.veterans = {
    ...(next.veterans || {}),
    veteran_population_percent: firstDefined(
      p.military_veterans?.veterans_pct,
      next.veterans?.veteran_population_percent
    )
  };

  next.labor = {
    ...(next.labor || {}),
    mean_travel_time_to_work_minutes: firstDefined(
      p.commute?.mean_travel_time_minutes,
      next.labor?.mean_travel_time_to_work_minutes
    ),
    unemployment_rate_percent: firstDefined(
      p.economy?.unemployment_rate_pct,
      next.labor?.unemployment_rate_percent
    )
  };

  next.housing = {
    ...(next.housing || {}),
    housing_units: firstDefined(p.housing?.total_housing_units, next.housing?.housing_units),
    median_value_owner_occupied: firstDefined(
      p.housing?.median_home_value,
      next.housing?.median_value_owner_occupied
    ),
    owner_occupied_pct: firstDefined(p.housing?.owner_occupied_pct, next.housing?.owner_occupied_pct),
    renter_occupied_pct: firstDefined(p.housing?.renter_occupied_pct, next.housing?.renter_occupied_pct),
    vacancy_pct: firstDefined(p.housing?.vacancy_pct, next.housing?.vacancy_pct)
  };

  next.rental_metrics = {
    ...(next.rental_metrics || {}),
    median_rent: firstDefined(p.housing?.median_gross_rent, next.rental_metrics?.median_rent),
    vacancy_rate_percent: firstDefined(p.housing?.vacancy_pct, next.rental_metrics?.vacancy_rate_percent)
  };

  next.rental_vacancy = {
    ...(next.rental_vacancy || {}),
    rate_percent: firstDefined(p.housing?.vacancy_pct, next.rental_vacancy?.rate_percent)
  };

  next.race_ethnicity = {
    ...(next.race_ethnicity || {}),
    white_pct: p.race_ethnicity?.white_pct,
    black_pct: p.race_ethnicity?.black_pct,
    asian_pct: p.race_ethnicity?.asian_pct,
    hispanic_latino_pct: p.race_ethnicity?.hispanic_latino_pct
  };

  next.sources = {
    ...(next.sources || {}),
    official_census: {
      provider: "U.S. Census Bureau ACS 5-Year Data Profile",
      as_of: String(p.year || DEFAULT_CENSUS_YEAR),
      geography: p.name,
      note: "Official Census data is used to enrich demographic, household, education, labor, commute, and housing profile fields."
    }
  };

  next.compatibility = {
    ...(next.compatibility || {}),
    census_enriched: true,
    census_source: "official_census_profile",
    census_note: "Market narratives and regional strategy still come from the market JSON; official demographic fields are enriched from Census ACS profile data."
  };

  return next;
}

function applyCensusToRegion(region, censusProfile) {
  if (!region || !censusProfile) return region;

  const next = structuredClone(region);
  const p = censusProfile;

  next.official_census_profile = p;

  next.demographics = {
    ...(next.demographics || {}),
    official_population: p.population?.total,
    official_median_age: p.population?.median_age,
    official_households: p.households?.total,
    official_average_household_size: p.households?.average_household_size,
    official_median_household_income: p.economy?.median_household_income,
    official_per_capita_income: p.economy?.per_capita_income,
    official_poverty_pct: p.economy?.poverty_pct,
    official_unemployment_rate_pct: p.economy?.unemployment_rate_pct,
    official_mean_travel_time_minutes: p.commute?.mean_travel_time_minutes,
    official_high_school_or_higher_pct: p.education?.high_school_or_higher_pct,
    official_bachelors_or_higher_pct: p.education?.bachelors_or_higher_pct,
    official_veterans_pct: p.military_veterans?.veterans_pct,
    official_median_home_value: p.housing?.median_home_value,
    official_median_gross_rent: p.housing?.median_gross_rent
  };

  return next;
}

async function loadMarketJson(city) {
  const filePath = path.join(
    process.cwd(),
    "netlify",
    "functions",
    "data",
    "market",
    `${city}.json`
  );

  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: BASE_HEADERS,
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
    const params = event.queryStringParameters || {};

    const city = safeSlug(params.city || "san-antonio");
    const regionKey = safeSlug(params.region || "");
    const includeCensus = String(params.census ?? "true").toLowerCase() !== "false";
    const includeRaw = String(params.raw ?? "false").toLowerCase() === "true";
    const censusYear = String(params.year || DEFAULT_CENSUS_YEAR);
    const censusDataset = String(params.dataset || DEFAULT_CENSUS_DATASET);

    const marketJson = await loadMarketJson(city);

    const warnings = [];
    let cityCensus = null;
    let regionCensus = null;

    let data = marketJson;

    if (includeCensus) {
      const cityGeo = getCityCensusGeo(city, marketJson);

      if (cityGeo) {
        const result = await fetchCensusProfile({
          geo: cityGeo,
          year: censusYear,
          dataset: censusDataset,
          includeRaw
        });

        if (result.ok) {
          cityCensus = result.profile;
          data = applyCensusToMarketData(data, cityCensus);
        } else {
          warnings.push({
            type: "city_census_failed",
            detail: result
          });
        }
      } else {
        warnings.push({
          type: "missing_city_census_geography",
          message: "No usable city-level Census geography found."
        });
      }

      if (regionKey && data?.regions?.[regionKey]) {
        const regionGeo = getRegionCensusGeo(data.regions[regionKey]);

        if (regionGeo) {
          const result = await fetchCensusProfile({
            geo: regionGeo,
            year: censusYear,
            dataset: censusDataset,
            includeRaw
          });

          if (result.ok) {
            regionCensus = result.profile;
            data = structuredClone(data);
            data.regions[regionKey] = applyCensusToRegion(data.regions[regionKey], regionCensus);
          } else {
            warnings.push({
              type: "region_census_failed",
              region: regionKey,
              detail: result
            });
          }
        } else {
          warnings.push({
            type: "missing_region_census_geography",
            region: regionKey,
            message: "Region does not have census_geography. Returning city-enriched market data."
          });
        }
      }
    }

    return json(200, {
      ok: true,
      city,
      region: regionKey || null,
      source: `netlify/functions/data/market/${city}.json`,
      census: {
        enabled: includeCensus,
        city_loaded: Boolean(cityCensus),
        region_loaded: Boolean(regionCensus),
        year: censusYear,
        dataset: censusDataset
      },
      warnings,
      data
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err?.message || String(err)
    }, {
      "Cache-Control": "no-store"
    });
  }
}

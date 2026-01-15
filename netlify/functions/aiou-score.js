// netlify/functions/aiou-score.js
// ============================================================
// A.I.O.U • Scoring Engine API (v1.0)
// PURPOSE:
// - Centralize the scoring model so Webflow never needs scoring edits.
// - Accept raw answers + optional visual slider
// - Return:
//   - Big5-style scores (O,C,E,A,N) on 1..5 scale
//   - Consistency flags (rephrased item mismatches)
//   - Archetype label
//   - MBTI type + confidence + blurb
//
// INPUT (POST JSON) supports either:
//
// Option A (recommended):
// {
//   "answers": { "O1": 2, "O1b": -3, ... , "V1": 4 },
//   "styleVsPriceSlider": 4
// }
//
// Option B (compat with your existing "brief"):
// {
//   "brief": {
//     "answers": { ... },
//     "visual": { "styleVsPriceSlider": 4 }
//   }
// }
//
// OUTPUT (200):
// {
//   "ok": true,
//   "version": "aiou.score.v1",
//   "scores": { "O": 3.88, "C": 3.10, "E": 2.95, "A": 3.40, "N": 4.12 },
//   "mbti": { "type": "INTJ", "confidence": 0.61, "label": "Architect", "blurb": "..." },
//   "archetype": "Risk-Guarded Nest-Builder",
//   "inconsistencies": ["O1/O1b"],
//   "debug": { "styleVsPriceSlider": 4 }
// }
// ============================================================

import { Handler } from "@netlify/functions";

/* ============================================================
   //#1 CORS
============================================================ */
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  };
}

/* ============================================================
   //#2 MODEL: QUESTIONS (Server-side truth)
   - Keep these IDs aligned with your Webflow quiz
   - Change scoring here without touching Webflow
============================================================ */
const QUESTIONS = [
  { id: "V1", type: "visual", dim: "O", rev: false },

  { id: "O1", dim: "O", rev: false, ctrlPair: "O1b" },
  { id: "O1b", dim: "O", rev: true, ctrlPair: "O1" },
  { id: "O2", dim: "O", rev: false },
  { id: "O3", dim: "O", rev: false },

  { id: "C1", dim: "C", rev: true, ctrlPair: "C1b" },
  { id: "C1b", dim: "C", rev: false, ctrlPair: "C1" },
  { id: "C2", dim: "C", rev: false },

  { id: "E1", dim: "E", rev: false, ctrlPair: "E1b" },
  { id: "E1b", dim: "E", rev: true, ctrlPair: "E1" },
  { id: "E2", dim: "E", rev: false },

  { id: "A1", dim: "A", rev: false, ctrlPair: "A1b" },
  { id: "A1b", dim: "A", rev: true, ctrlPair: "A1" },

  { id: "N1", dim: "N", rev: false, ctrlPair: "N1b" },
  { id: "N1b", dim: "N", rev: true, ctrlPair: "N1" },
  { id: "N2", dim: "N", rev: false },
  { id: "N3", dim: "N", rev: false },

  { id: "X1", dim: "O", rev: false },
];

/* ============================================================
   //#3 MBTI GUIDE (same as your client)
============================================================ */
const MBTI_BUYER_GUIDE = {
  ISTJ: "Stable, detail-first. Prefers proven neighborhoods, low-variance costs, and strong inspection records.",
  ISFJ: "Practical caretaker. Values safety, schools, and quiet streets; favors move-in-ready over projects.",
  INFJ: "Purpose-driven. Wants harmony and meaningful space; calm areas and quality renovations matter.",
  INTJ: "Planner/optimizer. Seeks value efficiency and long-term upside; ignores fluffy upgrades.",
  ISTP: "Hands-on problem-solver. Open to light projects if priced right; needs clear scope/timeline.",
  ISFP: "Aesthetic + comfort. Drawn to warm finishes, natural light, and cozy outdoor spots.",
  INFP: "Idealistic. Wants character and story; needs guardrails so budget doesn’t drift.",
  INTP: "Analytical. Structure/systems/future flexibility > staging glam.",
  ESTP: "Action-oriented. Loves lively areas and entertainment spaces; avoid payment creep.",
  ESFP: "Experience-first. Open layouts and social hubs; size payment first, then pick the fun.",
  ENFP: "Vision + people. Creative layouts, natural light; watch impulsive upgrades.",
  ENTP: "Options hunter. Wants flexibility/ADU potential; negotiate hard.",
  ESTJ: "Structured operator. Predictability, commute efficiency, and low-maintenance wins.",
  ESFJ: "Community anchor. Schools/parks close; turnkey > fixer to keep harmony.",
  ENFJ: "Connector. Hosting flow matters; choose move-in-ready to keep momentum.",
  ENTJ: "Decisive strategist. Location + resale math; newish or quality reno to avoid downtime.",
};

function mbtiLabel(type) {
  const map = {
    ISTJ: "Inspector",
    ISFJ: "Protector",
    INFJ: "Sage",
    INTJ: "Architect",
    ISTP: "Crafter",
    ISFP: "Artist",
    INFP: "Idealist",
    INTP: "Analyst",
    ESTP: "Promoter",
    ESFP: "Performer",
    ENFP: "Champion",
    ENTP: "Debater",
    ESTJ: "Executive",
    ESFJ: "Consul",
    ENFJ: "Protagonist",
    ENTJ: "Commander",
  };
  return map[type] || "Persona";
}

/* ============================================================
   //#4 SCORING CORE
============================================================ */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function mapMinus5toPlus5_to_1to5(v) {
  // v in [-5, +5] => [1..5]
  // -5 => 1, 0 => 3, +5 => 5
  return ((v + 5) * 0.4) + 1;
}

function scoreAll({ answers = {}, styleVsPriceSlider = 0 }) {
  const dims = { O: [], C: [], E: [], A: [], N: [] };
  const qMap = Object.fromEntries(QUESTIONS.map(q => [q.id, q]));

  // score dims from non-visual items
  for (const q of QUESTIONS) {
    if (q.type === "visual") continue;

    let v = answers[q.id];
    if (v === undefined || v === null || Number.isNaN(Number(v))) v = 0;
    v = Number(v);

    if (q.rev) v = -v;

    const mapped = mapMinus5toPlus5_to_1to5(v);
    if (dims[q.dim]) dims[q.dim].push(mapped);
  }

  const avg = arr => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 3);

  const S = {
    O: +avg(dims.O).toFixed(2),
    C: +avg(dims.C).toFixed(2),
    E: +avg(dims.E).toFixed(2),
    A: +avg(dims.A).toFixed(2),
    N: +avg(dims.N).toFixed(2),
  };

  // bias Openness with visual slider (same as your client)
  const v = Number(styleVsPriceSlider || 0);
  S.O = +clamp(S.O + (v / 12.5), 1, 5).toFixed(2);

  // consistency flags (rephrased pairs)
  const inconsistencies = [];
  const handled = new Set();

  for (const q of QUESTIONS) {
    if (!q.ctrlPair) continue;
    if (handled.has(q.id)) continue;

    const pair = q.ctrlPair;
    const qa = q;
    const qb = qMap[pair];

    let a = answers[qa.id];
    let b = answers[pair];

    if (a === undefined || a === null) a = 0;
    if (b === undefined || b === null) b = 0;

    a = Number(a);
    b = Number(b);

    const aAdj = qa.rev ? -a : a;
    const bAdj = qb?.rev ? -b : b;

    // your current threshold: >= 6 on the -5..+5 scale
    if (Math.abs(aAdj - bAdj) >= 6) inconsistencies.push(`${qa.id}/${pair}`);

    handled.add(qa.id);
    handled.add(pair);
  }

  return { scores: S, inconsistencies };
}

/* ============================================================
   //#5 MBTI DERIVATION (same logic as your client)
============================================================ */
function letterEI(E) { return E >= 3.75 ? "E" : (E <= 3.25 ? "I" : (E >= 3.5 ? "E" : "I")); }
function letterSN(O) { return O >= 3.75 ? "N" : (O <= 3.25 ? "S" : (O >= 3.5 ? "N" : "S")); }
function letterTF(A) { return A >= 3.75 ? "F" : (A <= 3.25 ? "T" : (A >= 3.5 ? "F" : "T")); }
function letterJP(C) { return C >= 3.75 ? "J" : (C <= 3.25 ? "P" : (C >= 3.5 ? "J" : "P")); }

function scoresToMBTI(S) {
  const ei = letterEI(S.E);
  const sn = letterSN(S.O);
  const tf = letterTF(S.A);
  const jp = letterJP(S.C);
  const type = `${ei}${sn}${tf}${jp}`;

  const dist = (v, hi = true) => (hi ? Math.max(0, v - 3.5) / 1.5 : Math.max(0, 3.5 - v) / 1.5);
  const parts = [
    ei === "E" ? dist(S.E, true) : dist(S.E, false),
    sn === "N" ? dist(S.O, true) : dist(S.O, false),
    tf === "F" ? dist(S.A, true) : dist(S.A, false),
    jp === "J" ? dist(S.C, true) : dist(S.C, false),
  ];

  const confidence = Math.max(0.35, +(parts.reduce((a, b) => a + b, 0) / 4).toFixed(2));
  return { type, confidence };
}

/* ============================================================
   //#6 ARCHETYPE (same as your client)
============================================================ */
function scoresToArchetype(s) {
  const hi = v => v >= 4.0;
  const lo = v => v <= 2.5;

  if (hi(s.O) && hi(s.E)) return "Visionary Host";
  if (hi(s.C) && !hi(s.O) && !hi(s.E)) return "Steady Planner";
  if (hi(s.N) && lo(s.E)) return "Risk-Guarded Nest-Builder";
  if (hi(s.A) && hi(s.C)) return "Family-First Optimizer";
  if (hi(s.O) && s.N < 3.3) return "Design-Forward Adventurer";
  return "Balanced Explorer";
}

/* ============================================================
   //#7 PARSE INPUT
============================================================ */
function parsePayload(bodyObj) {
  // Support both shapes
  const brief = bodyObj?.brief;
  const answers =
    bodyObj?.answers ||
    brief?.answers ||
    brief?.psych?.answers ||
    {};

  const styleVsPriceSlider =
    bodyObj?.styleVsPriceSlider ??
    brief?.visual?.styleVsPriceSlider ??
    answers?.V1 ??
    0;

  return {
    answers,
    styleVsPriceSlider: Number(styleVsPriceSlider || 0),
  };
}

/* ============================================================
   //#8 HANDLER
============================================================ */
export const handler = async (event) => {
  // OPTIONS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors(),
      body: JSON.stringify({ ok: false, error: "Method not allowed. Use POST." }),
    };
  }

  try {
    const bodyObj = event.body ? JSON.parse(event.body) : {};
    const { answers, styleVsPriceSlider } = parsePayload(bodyObj);

    const { scores, inconsistencies } = scoreAll({ answers, styleVsPriceSlider });
    const mb = scoresToMBTI(scores);
    const archetype = scoresToArchetype(scores);

    const blurb =
      MBTI_BUYER_GUIDE[mb.type] ||
      "Personality informs your tradeoffs; we’ll size budget first, then match how you live.";

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        ok: true,
        version: "aiou.score.v1",
        scores,
        mbti: {
          type: mb.type,
          confidence: mb.confidence,
          label: mbtiLabel(mb.type),
          blurb,
        },
        archetype,
        inconsistencies,
        debug: { styleVsPriceSlider },
      }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        ok: false,
        error: String(err?.message || err),
      }),
    };
  }
};

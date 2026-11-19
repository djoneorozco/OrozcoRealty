// netlify/functions/summarize.js
// v1.3 — CEO-grade, EXACTLY FIVE PARAGRAPHS with Rank + Last Name greeting
// Purpose → Concrete Health/Grade Targets → Biggest Issues → Improvement Playbook → Closing

const ALLOW_ORIGINS = [
  "https://new-real-estate-purchase.webflow.io",
  "https://www.new-real-estate-purchase.webflow.io",
  "https://theorozcorealty.netlify.app",
  "http://localhost:8888"
];

function corsHeaders(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Content-Type": "application/json"
  };
}

/* ===================== Helpers ===================== */
const USD = (n) =>
  (Number(n) || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });
const PCT0 = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
const PCT0dir = (x) => `${Math.round(Number(x) || 0)}%`;

function pmti(P, r, n) { if (r === 0) return P / n; const x = Math.pow(1 + r, n); return P * ((r * x) / (x - 1)); }
function scoreAPR(s) {
  s = Number(s) || 720;
  if (s >= 780) return 6.50;
  if (s >= 760) return 6.75;
  if (s >= 720) return 7.00;
  if (s >= 700) return 7.20;
  if (s >= 680) return 7.35;
  if (s >= 660) return 7.85;
  if (s >= 640) return 8.25;
  if (s >= 620) return 9.25;
  return 9.95;
}

function paygradeToRank(paygradeRaw, branchRaw) {
  const p = String(paygradeRaw || "").toUpperCase().replace(/\s+/g, "");
  const b = String(branchRaw || "").toLowerCase();
  const OFF = {"O-1":"Second Lieutenant (O-1)","O-2":"First Lieutenant (O-2)","O-3":"Captain (O-3)","O-4":"Major (O-4)","O-5":"Lieutenant Colonel (O-5)","O-6":"Colonel (O-6)","O-7":"Brigadier General (O-7)","O-8":"Major General (O-8)","O-9":"Lieutenant General (O-9)","O-10":"General (O-10)"};
  const WARR={"W-1":"Warrant Officer 1 (W-1)","W-2":"Chief Warrant Officer 2 (W-2)","W-3":"Chief Warrant Officer 3 (W-3)","W-4":"Chief Warrant Officer 4 (W-4)","W-5":"Chief Warrant Officer 5 (W-5)"};
  const AF  ={"E-1":"Airman Basic (E-1)","E-2":"Airman (E-2)","E-3":"Airman First Class (E-3)","E-4":"Senior Airman (E-4)","E-5":"Staff Sergeant (E-5)","E-6":"Technical Sergeant (E-6)","E-7":"Master Sergeant (E-7)","E-8":"Senior Master Sergeant (E-8)","E-9":"Chief Master Sergeant (E-9)"};
  const ARMY={"E-1":"Private (E-1)","E-2":"Private (E-2)","E-3":"Private First Class (E-3)","E-4":"Specialist/Corporal (E-4)","E-5":"Sergeant (E-5)","E-6":"Staff Sergeant (E-6)","E-7":"Sergeant First Class (E-7)","E-8":"Master/First Sergeant (E-8)","E-9":"Sergeant Major (E-9)"};
  const NAVYMC={"E-1":"Seaman Recruit/Private (E-1)","E-2":"Seaman Apprentice/Private (E-2)","E-3":"Seaman/Private First Class (E-3)","E-4":"Petty Officer Third Class/Corporal (E-4)","E-5":"Petty Officer Second Class/Sergeant (E-5)","E-6":"Petty Officer First Class/Staff Sergeant (E-6)","E-7":"Chief Petty Officer/Gunnery Sergeant (E-7)","E-8":"Senior Chief/First Sergeant (E-8)","E-9":"Master Chief/Master Gunnery Sergeant (E-9)"};
  const CG  ={"E-1":"Seaman Recruit (E-1)","E-2":"Seaman Apprentice (E-2)","E-3":"Seaman (E-3)","E-4":"Petty Officer Third Class (E-4)","E-5":"Petty Officer Second Class (E-5)","E-6":"Petty Officer First Class (E-6)","E-7":"Chief Petty Officer (E-7)","E-8":"Senior Chief Petty Officer (E-8)","E-9":"Master Chief Petty Officer (E-9)"};
  const GEN ={"E-1":"Junior Enlisted (E-1)","E-2":"Junior Enlisted (E-2)","E-3":"Junior Enlisted (E-3)","E-4":"Corporal/Specialist (E-4)","E-5":"Sergeant (E-5)","E-6":"Staff/Technical Sergeant (E-6)","E-7":"Senior NCO (E-7)","E-8":"Senior NCO (E-8)","E-9":"Senior NCO (E-9)"};
  if (!p) return null;
  if (OFF[p]) return OFF[p];
  if (WARR[p]) return WARR[p];
  if (b.includes("air") || b.includes("space")) return AF[p] || null;
  if (b.includes("army")) return ARMY[p] || null;
  if (b.includes("navy") || b.includes("marine")) return NAVYMC[p] || null;
  if (b.includes("coast")) return CG[p] || null;
  return GEN[p] || p;
}

function computeKPIs(s) {
  const income = +s.income || 0;
  const expenses = +s.expenses || 0;
  const savings = +s.savings || 0;
  const housing = +s.housing || 0;

  const totalShare = income > 0 ? (expenses + savings + housing) / income : 1;
  const housingShare = income > 0 ? housing / income : 0;
  const dti = income > 0 ? (expenses + housing) / income : 1;
  const freePost = income - expenses - savings - housing;

  const coverage = expenses > 0 ? income / expenses : income > 0 ? Infinity : 0;
  const runwayMonths = expenses > 0 ? savings / expenses : 0;

  // Stress: +200bps APR & +5% expenses using price/dp when available
  const stressApr =
    (Number(s.apr) || scoreAPR(Number(s.creditScore || 720))) + 2.0;
  const price = Number(s.price) || 0;
  const dpAmt = Number(s.dpAmt) || 0;
  const loan = Math.max(0, price - dpAmt);
  const mRate = stressApr / 100 / 12;
  const termN = Math.max(1, (Number(s.termYears) || 30) * 12);
  const pAndI_stress = loan > 0 ? pmti(loan, mRate, termN) : 0;
  const housing_stress =
    pAndI_stress + Number(s.tihoa || 0) + Number(s.pmi || 0);
  const expenses_stress = expenses * 1.05;

  const dti_stress =
    income > 0 ? (expenses_stress + housing_stress) / income : 1;
  const freePost_stress =
    income - expenses_stress - savings - housing_stress;

  const targets = {
    commitmentMax: 0.70,
    housingLaneMin: 0.28,
    housingLaneMax: 0.33,
    runwayMinMonths: 3,
    coverageMin: 1.3
  };

  return {
    income, expenses, savings, housing, freePost,
    totalShare, housingShare, dti, coverage, runwayMonths,
    stress: { dti: dti_stress, freePost: freePost_stress },
    targets
  };
}

function gradeLetter(k) {
  let g = 92;
  if (k.totalShare >= 0.85) g -= 30;
  else if (k.totalShare >= 0.70) g -= 15;
  else g += 4;

  if (k.housingShare > 0.40) g -= 18;
  else if (k.housingShare > 0.33) g -= 8;
  else g += 4;

  if (k.freePost < 0) g -= 30;
  else if (k.income > 0 && k.freePost / k.income < 0.10) g -= 10;
  else if (k.income > 0 && k.freePost / k.income >= 0.20) g += 4;

  const sr = k.income > 0 ? k.savings / k.income : 0;
  if (sr < 0.10) g -= 8;
  else if (sr >= 0.20) g += 4;

  g = Math.max(0, Math.min(100, g));
  return g >= 98 ? "A+"
       : g >= 92 ? "A"
       : g >= 88 ? "A-"
       : g >= 82 ? "B+"
       : g >= 76 ? "B"
       : g >= 72 ? "B-"
       : g >= 66 ? "C+"
       : g >= 60 ? "C"
       : g >= 55 ? "C-"
       : g >= 50 ? "D+"
       : g >= 45 ? "D" : "F";
}

function lastNameOf(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  return parts.length ? parts[parts.length - 1] : s;
}

/** EXACTLY five <p> paragraphs */
function toFiveParagraphHTML(text) {
  if (!text) return "<p></p><p></p><p></p><p></p><p></p>";
  let t = text
    .replace(/(^|\n)#{1,6}\s*/g, "\n")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.*?)__/g, "<strong>$1</strong>")
    .trim();

  let parts = t.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 5) {
    const soft = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (soft.length >= 5) parts = soft.slice(0,5);
  }
  if (parts.length > 5) parts = parts.slice(0, 5);
  while (parts.length < 5) parts.push("");

  return parts.map((p) => `<p>${p}</p>`).join("");
}

/** Server-side synthesis if model under-delivers */
function synthesizeFromFacts(f, k) {
  const greet = (f.client.rankPretty ? f.client.rankPretty.split(" (")[0] : "Service Member") + " " + (f.client.lastName || "Client");

  const incomeNum = k.income || 0;
  const laneMin = incomeNum * 0.28;
  const laneMax = incomeNum * 0.33;
  const autoSave = Math.max(50, Math.round(incomeNum * 0.10));
  const discShift = Math.round(incomeNum * 0.10);

  const p1 = `<p><strong>${greet}</strong>, thank you for your service. This executive memo provides a clear, board-ready readout of your financial health, key risks, and concrete steps to correct them. With income <strong>${f.figures.income}</strong>, expenses <strong>${f.figures.expenses}</strong>, programmed savings <strong>${f.figures.savings}</strong>, housing <strong>${f.figures.housing}</strong> (housing share ${f.ratios.housingShare}), DTI ${f.ratios.dti}, coverage <strong>${f.ratios.coverage}</strong>, and runway <strong>${f.ratios.runway}</strong>, your grade currently reads <strong>${f.grade}</strong>.</p>`;

  const p2 = `<p><strong>Financial Health—Dollar Targets.</strong> Keep housing in the <strong>28–33%</strong> lane, which for your income equals <strong>${USD(laneMin)}–${USD(laneMax)}</strong> per month (P&I + taxes/insurance/HOA/PMI). Maintain positive disposable income with at least <strong>10%</strong> of income left after all obligations. Automate a payday transfer of <strong>${USD(autoSave)}</strong> toward a <strong>3–6 month</strong> reserve; pause contributions only once you clear 3 months of expenses.</p>`;

  const p3 = `<p><strong>Biggest Issues.</strong> Elevated DTI and short runway constrain approval options and raise risk. Credit-tier APR penalties can shift payment by <strong>$75–$200+</strong>/mo. Discretionary outflows above <strong>10–12%</strong> of income slow the reserve build and suppress grade. Any purchase must be right-sized into the housing lane above.</p>`;

  const p4 = `<p><strong>Improvement Playbook.</strong> 1) Pull free credit reports at <a href="https://www.annualcreditreport.com" target="_blank" rel="noopener">annualcreditreport.com</a>; dispute errors; drive utilization under <strong>30%</strong> (ideal <strong>&lt;10%</strong>) using a lowest-APR ladder. 2) Reallocate ~<strong>${USD(discShift)}</strong>/mo from discretionary to an autopay reserve until you reach 3–6 months. 3) Keep total commitments ≤ <strong>70%</strong> of income; if above, sequence paydowns on high-payment, short-term debts for DTI relief. 4) When you offer, pair a price sized to <strong>${USD(laneMin)}–${USD(laneMax)}</strong> with seller credits; evaluate points vs. lender credits to optimize cash vs. rate. Guidance: <a href="https://www.consumerfinance.gov/" target="_blank" rel="noopener">cfpb.gov</a>.</p>`;

  const p5 = `<p><strong>Closing & Next Steps.</strong> We’ll convert these targets into a pre-approval brief, then run property scenarios inside the lane and sequence COE → underwriting → lock strategy → curated inventory. We’ll refresh this memo as your live numbers improve so you purchase with confidence.</p>`;
  return [p1,p2,p3,p4,p5].join("");
}

/* ===================== Handler ===================== */
export const handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  try {
    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch (_) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) }; }

    const { snapshot, buckets, styleGuide: styleGuideFromClient, kind } = payload;
    if (!snapshot || typeof snapshot !== "object") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid snapshot" }) };
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: "OPENAI_API_KEY not configured" }) };

    /* -------- Identity -------- */
    const branch =
      snapshot?.military?.branch || snapshot?.profile?.branch || "";
    const paygrade =
      snapshot?.rank || snapshot?.military?.rank || snapshot?.profile?.rank || "";
    const rankPretty = paygradeToRank(paygrade, branch);
    const clientName =
      (snapshot?.profile?.name || snapshot?.userName || "Client").toString();
    const clientEmail =
      (snapshot?.profile?.email || snapshot?.userEmail || "").toString();

    /* -------- KPIs & grade -------- */
    const k = computeKPIs(snapshot);
    const letter = gradeLetter(k);

    /* -------- Facts -------- */
    const facts = {
      client: {
        name: clientName,
        lastName: lastNameOf(clientName),
        email: clientEmail,
        branch, paygrade, rankPretty
      },
      grade: letter,
      figures: {
        income: USD(k.income), expenses: USD(k.expenses),
        savings: USD(k.savings), housing: USD(k.housing),
        freeCashFlow: USD(k.freePost)
      },
      ratios: {
        commitmentShare: PCT0(k.totalShare),
        housingShare: PCT0(k.housingShare),
        dti: PCT0(k.dti),
        coverage: k.coverage === Infinity ? "∞" : (k.coverage || 0).toFixed(2) + "×",
        runway: (k.runwayMonths || 0).toFixed(2) + " months"
      },
      stress: { dti: PCT0(k.stress.dti), freeCashFlow: USD(k.stress.freePost) },
      targets: {
        commitmentShareMax: PCT0dir(k.targets.commitmentMax * 100),
        housingLane: `${PCT0dir(k.targets.housingLaneMin * 100)}–${PCT0dir(k.targets.housingLaneMax * 100)}`,
        runwayMin: `${k.targets.runwayMinMonths}–6 months`,
        coverageMin: "≥1.3×"
      },
      credit: { score: Number(snapshot?.creditScore || 720) }
    };

    /* -------- Style (server-enforced) -------- */
    const defaultStyleGuide = {
      persona: {
        name: "Elena — Executive Concierge",
        role: "CEO-level finance & real-estate strategist",
        pedigree: "Harvard-trained, VA-loan specialist, boardroom communicator",
        voice: [
          "Crisp, confident, data-forward",
          "Plain English with banker precision",
          "No slang, no emojis, no fluff"
        ],
        audience: clientName || "Client"
      },
      purpose: "Deliver a five-paragraph fiduciary memo in HTML-ready prose.",
      structure: [
        "P1 — Address by Rank + Last Name; thank for service; purpose + headline figures.",
        "P2 — Concrete dollar targets: housing lane (28–33%) AS DOLLAR RANGE, minimum DI, autopay reserve amount, DTI guardrails.",
        "P3 — Biggest issues with specificity (credit tier $ impact, runway, discretionary %).",
        "P4 — Improvement Playbook with actionable steps + plain links (annualcreditreport.com, cfpb.gov), seller-credits/points tactics.",
        "P5 — Closing & next steps with OrozcoRealty."
      ],
      formatting: {
        paragraphs: 5, bullets: "none",
        boldKeyNumbers: true,
        currency: "USD (whole dollars)",
        readingLevel: "executive"
      },
      guardrails: [
        "Educational tone; no guarantees",
        "3–5 sentences per paragraph",
        "Define DTI inline",
        "Use provided figures; do not invent numbers"
      ],
      signoff: "— Elena, Your Virtual Concierge"
    };

    const styleGuide = {
      ...defaultStyleGuide,
      ...(styleGuideFromClient || {}),
      guardrails: defaultStyleGuide.guardrails,
      signoff: defaultStyleGuide.signoff
    };

    /* -------- Prompts -------- */
    const system = [
      "You are ELENA — a CEO-grade fiduciary strategist with a Harvard-polished voice.",
      "Write EXACTLY FIVE paragraphs of HTML-ready prose (no headings, no lists). Never return fewer than five paragraphs.",
      "Paragraph 1 MUST greet by rank + last name if rankPretty exists, else greet as 'Service Member' + last name or the client’s name. Always thank for service.",
      "Use banker terms: commitment share, housing share, DTI (define inline as share of income to debts), coverage ×, runway months. Bold key numbers using **...**.",
      "Paragraph 2 must include concrete dollar targets (housing 28–33% lane AS DOLLAR RANGE, minimum DI, autopay reserve amount).",
      "Paragraph 4 must be a tactical playbook with plain URLs: annualcreditreport.com and cfpb.gov.",
      "If you find yourself with fewer than five paragraphs, expand with credit strategy, savings runway, debt sequencing, and rate/points trade-offs until you reach five."
    ].join(" ");

    const user = JSON.stringify({
      kind: kind || "fiduciary-memo",
      styleGuide,
      facts,
      snapshot,
      buckets
    });

    /* -------- OpenAI call -------- */
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.25,
        max_tokens: 1200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return { statusCode: 502, headers, body: JSON.stringify({ error: "OpenAI upstream error", detail }) };
    }

    const data = await resp.json();
    let raw = (data?.choices?.[0]?.message?.content || "").trim();

    // Enforce 5 paragraphs; synthesize if short
    let memoHtml = toFiveParagraphHTML(raw);
    const count = (memoHtml.match(/<p>/g) || []).length;
    if (count < 5) memoHtml = toFiveParagraphHTML(synthesizeFromFacts(facts, k));

    const out = {
      memoHtml,
      memo: raw,
      grade: letter,
      kpis: {
        income: k.income, expenses: k.expenses, savings: k.savings, housing: k.housing,
        freePost: k.freePost, totalShare: k.totalShare, housingShare: k.housingShare,
        dti: k.dti, coverage: k.coverage, runwayMonths: k.runwayMonths, stress: k.stress
      }
    };

    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server exception", detail: String(err?.message || err) }) };
  }
};

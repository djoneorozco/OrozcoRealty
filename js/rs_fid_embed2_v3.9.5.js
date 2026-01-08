<script>
(() => {
  "use strict";

  /* ============================================================
     RS_FID — EMBED #2 (2A + 2B + 2C) • v3.9.5-compatible
     - Works with your provided Shell (IDs unchanged)
     ✅ UPDATE: Mortgage math moved to mortgage.js (via /api/mortgage)
     - Everything else stays the same.
  ============================================================ */

  if (window.RS_FID && window.RS_FID.__coreMounted) return;

  const CORE = (window.RS_FID = window.RS_FID || {});
  CORE.__coreMounted = true;

  // ============================================================
  // //#0 — Helpers
  // ============================================================
  const $ = (q) => document.querySelector(q);
  const n0 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const clamp = (n,min,max)=> Math.max(min, Math.min(max, n));

  const cur = (n, d=0) => (Number(n)||0).toLocaleString("en-US",{
    style:"currency", currency:"USD",
    minimumFractionDigits:d, maximumFractionDigits:d
  });
  const signed = (n) => (n>=0 ? cur(n,0) : ("-"+cur(Math.abs(n),0)));

  function onReady(fn){
    if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(fn, 0);
    else document.addEventListener("DOMContentLoaded", fn, { once:true });
  }

  function pickFirst(obj, keys){
    for (const k of keys){
      const v = obj?.[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  }

  // ============================================================
  // //#1 — API origin (Webflow-safe)
  // ============================================================
  const RS_LIVE_API_ORIGIN = "https://theorozcorealty.netlify.app";
  const RS_API_ORIGIN = (() => {
    const host = String(location.hostname||"").toLowerCase();
    if (host.endsWith(".webflow.io")) return RS_LIVE_API_ORIGIN;
    return "";
  })();

  const rsApiUrl = (path) => {
    const base = (RS_API_ORIGIN || "");
    if (!base) return path;
    return base.replace(/\/+$/,"") + "/" + String(path||"").replace(/^\/+/,"");
  };

  function resolveEmail(){
    const a = localStorage.getItem("realtysass.loginEmail");
    if (a) return a;
    try{
      const pl = JSON.parse(localStorage.getItem("realtysass.profile_lookup")||"{}");
      const b = pl?.profile?.email;
      if (b) return b;
    }catch(_){}
    return "orozco@me.com";
  }

  // ============================================================
  // //#2 — Mortgage via mortgage.js (Netlify) — replaces local mortgage math
  // ============================================================
  // We keep ONLY lightweight shared helpers for other modules:
  // - scoreAPR() + pmti() + remainingBalance() remain for 2C (targets + rent vs buy)
  // Mortgage Estimate + breakdown for 2A now comes from /api/mortgage

  const MORTGAGE_CACHE_KEY = "realtysass.mortgage_cache.v1";

  function stableKey(obj){
    const keys = Object.keys(obj||{}).sort();
    const out = {};
    for (const k of keys) out[k] = obj[k];
    return JSON.stringify(out);
  }

  function bandFromScore(s){
    s=Number(s)||720;
    if(s>=760) return "Excellent";
    if(s>=720) return "Good";
    if(s>=680) return "Fair";
    if(s>=640) return "OK-ish";
    if(s>=620) return "Weak";
    return "Subprime";
  }

  function scoreAPR(s){
    s=Number(s)||720;
    if(s>=780) return 6.50;
    if(s>=760) return 6.75;
    if(s>=720) return 7.00;
    if(s>=700) return 7.20;
    if(s>=680) return 7.35;
    if(s>=660) return 7.85;
    if(s>=640) return 8.25;
    if(s>=620) return 9.25;
    return 9.95;
  }

  function pmti(P,r,n){
    P = n0(P);
    if (P<=0) return 0;
    if (r===0) return P/Math.max(1,n);
    const x = Math.pow(1+r,n);
    return P*(r*x)/(x-1);
  }

  // Remaining balance after k payments (for Rent vs Buy)
  function remainingBalance(P, r, payment, k){
    P = Math.max(0, n0(P));
    r = Math.max(0, n0(r));
    payment = Math.max(0, n0(payment));
    k = Math.max(0, Math.floor(n0(k)));
    if (P<=0 || k<=0) return P;
    if (r<=0) return Math.max(0, P - payment*k);
    const pow = Math.pow(1+r, k);
    const bal = P*pow - payment*((pow - 1)/r);
    return Math.max(0, bal);
  }

  function readMortgageCache(){
    try{
      const c = JSON.parse(localStorage.getItem(MORTGAGE_CACHE_KEY)||"{}");
      if (c && c.data && c.key) return c;
    }catch(_){}
    return null;
  }

  function writeMortgageCache(key, data){
    try{
      localStorage.setItem(MORTGAGE_CACHE_KEY, JSON.stringify({
        key, data, ts: Date.now()
      }));
    }catch(_){}
  }

  function normalizeMortgageResponse(j){
    // accept many shapes
    const root = j || {};
    const ok = !!(root.ok ?? root?.mortgage?.ok ?? root?.data?.ok ?? false);

    const m = root.mortgage || root.data || root.payload || root;
    const br = m.breakdown || root.breakdown || {};

    const allIn =
      n0(pickFirst(br, ["allIn","all_in","total","totalMonthly","total_monthly","monthly","payment","allInMonthly"])) ||
      n0(pickFirst(m,  ["allIn","all_in","total","totalMonthly","total_monthly","monthly","payment","estimatedMonthlyMortgage","estimated_monthly_mortgage"]));

    const pi =
      n0(pickFirst(br, ["pi","pAndI","p_and_i","principalInterest","principal_interest"])) ||
      n0(pickFirst(m,  ["pi","pAndI","p_and_i","principalInterest","principal_interest"]));

    const tax =
      n0(pickFirst(br, ["tax","taxMo","tax_monthly","taxMonthly","propertyTaxMonthly"])) ||
      n0(pickFirst(m,  ["tax","taxMo","tax_monthly","taxMonthly","propertyTaxMonthly"]));

    const insurance =
      n0(pickFirst(br, ["insurance","ins","insMo","ins_monthly","insuranceMonthly","homeInsuranceMonthly"])) ||
      n0(pickFirst(m,  ["insurance","ins","insMo","ins_monthly","insuranceMonthly","homeInsuranceMonthly"]));

    const hoa =
      n0(pickFirst(br, ["hoa","hoaMo","hoa_monthly","hoaMonthly"])) ||
      n0(pickFirst(m,  ["hoa","hoaMo","hoa_monthly","hoaMonthly"]));

    const pmi =
      n0(pickFirst(br, ["pmi","pmiMo","pmi_monthly","pmiMonthly","miMonthly","mortgageInsuranceMonthly"])) ||
      n0(pickFirst(m,  ["pmi","pmiMo","pmi_monthly","pmiMonthly","miMonthly","mortgageInsuranceMonthly"]));

    const apr =
      n0(pickFirst(m, ["apr","aprUsed","rate","interestRate","interest_rate","annualRate"])) ||
      n0(pickFirst(root, ["apr","aprUsed","rate","interestRate","interest_rate","annualRate"]));

    const loan =
      n0(pickFirst(m, ["loan","loanAmount","loan_amount","principal","loanAmt"])) ||
      0;

    // Principal/Interest if provided; else compute month-1 estimate from loan+apr and PI.
    let principal = n0(pickFirst(br, ["principal","principalMo","principal_monthly"])) || 0;
    let interest  = n0(pickFirst(br, ["interest","interestMo","interest_monthly"])) || 0;

    const usedAPR = (apr > 0 ? apr : 0);
    if ((principal<=0 || interest<=0) && loan>0 && usedAPR>0 && pi>0){
      const mRate = (usedAPR/100)/12;
      interest = loan * mRate;
      principal = Math.max(0, pi - interest);
    }

    // If PI missing but all-in and components exist, recover PI
    const recoveredPI = (pi>0 ? pi : Math.max(0, allIn - tax - insurance - hoa - pmi));

    // Fold PMI into insurance to keep your existing 2A bar semantics (Insurance = Insurance + PMI)
    const insPlus = Math.max(0, insurance) + Math.max(0, pmi);

    return {
      ok,
      apr: usedAPR,
      loan,
      breakdown: {
        allIn: Math.max(0, allIn),
        pi: Math.max(0, recoveredPI),
        principal: Math.max(0, principal),
        interest: Math.max(0, interest),
        tax: Math.max(0, tax),
        insurance: Math.max(0, insPlus),
        hoa: Math.max(0, hoa),
        pmi: Math.max(0, pmi)
      },
      raw: root
    };
  }

  CORE.mortgage = CORE.mortgage || {
    key: null,
    data: null,
    inFlight: false
  };

  async function fetchMortgageEstimate(payload){
    const key = stableKey(payload);

    // In-memory hit
    if (CORE.mortgage?.key === key && CORE.mortgage?.data?.ok) return CORE.mortgage.data;

    // LocalStorage hit
    const c = readMortgageCache();
    if (c?.key === key && c?.data?.ok){
      CORE.mortgage.key = c.key;
      CORE.mortgage.data = c.data;
      return c.data;
    }

    const url = rsApiUrl("/api/mortgage");
    const r = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(()=> ({}));
    const norm = normalizeMortgageResponse(j);

    if (!r.ok || !norm.ok){
      // Soft-fail: keep any existing cache, don’t crash UI
      throw new Error(`Mortgage API failed (HTTP ${r.status})`);
    }

    CORE.mortgage.key = key;
    CORE.mortgage.data = norm;
    writeMortgageCache(key, norm);

    return norm;
  }

  let __mortgageTimer = null;
  function scheduleMortgageRefresh(payload, reason){
    // Avoid spamming /api/mortgage on slider drags
    const key = stableKey(payload);
    if (CORE.mortgage?.key === key && CORE.mortgage?.data?.ok) return;

    clearTimeout(__mortgageTimer);
    __mortgageTimer = setTimeout(async ()=>{
      if (CORE.mortgage.inFlight) return;
      CORE.mortgage.inFlight = true;
      try{
        await fetchMortgageEstimate(payload);
        // repaint with fresh mortgage breakdown
        CORE.paintAll();
      }catch(_){
        // keep UI stable; we still render using fallback
      }finally{
        CORE.mortgage.inFlight = false;
      }
    }, 275);
  }

  // ============================================================
  // //#3 — Bridge state
  // ============================================================
  CORE.bridge = CORE.bridge || null;

  function loadBridge(){
    let bridge = null;
    try{
      const raw = localStorage.getItem("realtysass.bridge");
      if (raw) bridge = JSON.parse(raw);
    }catch(_){}

    // Optional: legacy expenses rows
    try{
      if(!bridge?.itemizedRows){
        const rows = JSON.parse(localStorage.getItem("va.expenses.rows")||"[]");
        if(rows?.length){
          bridge = Object.assign({}, bridge, {
            itemizedRows: rows.map(r=>({ name:r.name, monthly:r.month, cat:r.cat }))
          });
        }
      }
    }catch(_){}

    CORE.bridge = bridge || {};
  }

  window.addEventListener("message", (ev)=>{
    try{
      const msg = ev.data || {};
      if (msg.type==="realtysass-bridge" && msg.payload){
        CORE.bridge = msg.payload;
        CORE.state.rentStartOverride = null;
        CORE.fetchBrain?.();
        CORE.paintAll();
      }
    }catch(_){}
  }, false);

  // ============================================================
  // //#4 — KPI Overrides
  // ============================================================
  const OV_KEY = "realtysass.kpi_overrides.v1";

  function readOverrides(){
    try{ return JSON.parse(localStorage.getItem(OV_KEY)||"{}")||{}; }
    catch(_){ return {}; }
  }
  function writeOverrides(obj){
    try{ localStorage.setItem(OV_KEY, JSON.stringify(obj||{})); }
    catch(_){}
  }
  function numOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

  function getOv(){
    const o = readOverrides();

    const addIncome = Math.max(0, Number(
      pickFirst(o, ["addIncome","add_income","addIncomeOverride","incomeAdd","additionalIncome"]) || 0
    ) || 0);

    const expenses = numOrNull(pickFirst(o, ["expensesOverride","expenses","monthlyExpenses","expenseOverride"]));
    const housing  = numOrNull(pickFirst(o, ["housingOverride","housing","homePrice","priceOverride"]));
    const savings  = numOrNull(pickFirst(o, ["savingsOverride","savings","downpayment","dpAmt","downPaymentAmt"]));
    const creditScore = numOrNull(pickFirst(o, ["creditScore","score","fico","credit_score"]));

    return { addIncome, expenses, housing, savings, creditScore };
  }

  CORE.readOverrides = readOverrides;
  CORE.writeOverrides = writeOverrides;
  CORE.getOv = getOv;

  // ============================================================
  // //#5 — Brain fetch (cached)
  // ============================================================
  const BRAIN_KEY = "realtysass.brain_cache.v1";
  CORE.brain = CORE.brain || null;

  function buildBrainPayload(){
    const email = resolveEmail();
    const b = CORE.bridge || {};
    const ov = getOv();

    const price =
      (ov.housing != null ? n0(ov.housing) : n0(b.housing || b.price || b.homePrice || b.purchasePrice || 0));

    const dpAmt =
      n0(b.dpAmt || b.downPayment || b.downPaymentAmt || b.down_payment || 0) ||
      n0(ov.savings != null ? ov.savings : b.savings);

    const dpPct =
      n0(b.dpPct || b.downPaymentPct || b.down_payment_pct || 0) ||
      (price>0 && dpAmt>0 ? ((dpAmt/price)*100) : 0);

    const creditScore =
      (ov.creditScore != null ? ov.creditScore : (b.creditScore || b.credit_score || null));

    const termYears = n0(b.termYears || b.term || b.term_years || 30) || 30;

    const cityKey = b.cityKey || b.city || "SanAntonio";
    const bedrooms = n0(b.bedrooms || b.beds || 4) || 4;

    return {
      email,
      cityKey,
      bedrooms,
      price: price>0 ? price : undefined,
      dpPct: dpPct>0 ? dpPct : undefined,
      termYears,
      creditScore: creditScore != null ? Number(creditScore) : undefined
    };
  }

  CORE.fetchBrain = async function fetchBrain(){
    const payload = buildBrainPayload();
    try{
      const r = await fetch(rsApiUrl("/api/brain"),{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (j && (j.ok || j.schemaVersion)){
        CORE.brain = j;
        try{ localStorage.setItem(BRAIN_KEY, JSON.stringify({ t:Date.now(), data:j })); }catch(_){}
        return j;
      }
    }catch(_){}

    try{
      const c = JSON.parse(localStorage.getItem(BRAIN_KEY)||"{}");
      if (c?.data){
        CORE.brain = c.data;
        return CORE.brain;
      }
    }catch(_){}
    return null;
  };

  // ============================================================
  // //#6 — City extract + deterministic TIHOA fallbacks
  // ============================================================
  function extractCityFromBrain(brain){
    return (
      brain?.city ||
      brain?.market ||
      brain?.cityData ||
      brain?.data?.city ||
      brain?.payload?.city ||
      null
    );
  }

  function normRate(x){
    const v = n0(x);
    if (v <= 0) return 0;
    if (v > 1) return v / 100;
    return v;
  }

  function cityAvgHome(city){
    if (!city) return 0;
    const v = n0(pickFirst(city, [
      "avg_home_value","average_home_value","avgHome","avgHomeValue","city_avg_home","cityAvgHome",
      "median_home_value","medianHomeValue","home_value_avg","homeValueAvg"
    ]));
    return v;
  }

  function cityTaxMonthly(price, city){
    price = Math.max(0, n0(price));
    if (!city || price<=0) return (price * 0.019) / 12;

    const monthlyExplicit = n0(pickFirst(city, [
      "tax_monthly","taxMonthly","property_tax_monthly","propertyTaxMonthly","avg_property_tax_monthly"
    ]));
    if (monthlyExplicit > 0) return monthlyExplicit;

    const annualExplicit = n0(pickFirst(city, [
      "tax_annual","taxAnnual","property_tax_annual","propertyTaxAnnual","avg_property_tax_annual"
    ]));
    if (annualExplicit > 0) return annualExplicit / 12;

    const rate = normRate(pickFirst(city, [
      "propertyTaxRate","property_tax_rate","taxRate","tax_rate","property_tax","prop_tax_rate"
    ]));
    if (rate > 0) return (price * rate) / 12;

    return (price * 0.019) / 12;
  }

  function cityInsuranceMonthly(price, city){
    price = Math.max(0, n0(price));
    if (!city || price<=0) return (price * 0.0070) / 12;

    const monthlyExplicit = n0(pickFirst(city, [
      "insurance_monthly","insuranceMonthly","home_insurance_monthly","homeInsuranceMonthly","avg_home_insurance_monthly"
    ]));
    if (monthlyExplicit > 0) return monthlyExplicit;

    const annualExplicit = n0(pickFirst(city, [
      "insurance_annual","insuranceAnnual","home_insurance_annual","homeInsuranceAnnual","avg_home_insurance_annual"
    ]));
    if (annualExplicit > 0) return annualExplicit / 12;

    const rate = normRate(pickFirst(city, [
      "insuranceRate","insurance_rate","homeInsuranceRate","home_insurance_rate"
    ]));
    if (rate > 0) return (price * rate) / 12;

    return (price * 0.0070) / 12;
  }

  function cityHoaMonthly(city){
    if (!city) return 0;
    const hoa = n0(pickFirst(city, ["hoa_monthly","hoaMonthly","avg_hoa_monthly","hoa","avgHoaMonthly"]));
    return hoa > 0 ? hoa : 0;
  }

  function normalizeInsuranceMonthlyValue(insValue, price, city){
    let v = Math.max(0, n0(insValue));
    const p = Math.max(0, n0(price));
    if (v <= 0) return 0;

    // annual-looking values -> monthly
    if (v >= 8000) v = v / 12;

    const hardCap = (p > 0 ? (p * 0.020) / 12 : 0);
    const expected = cityInsuranceMonthly(p, city) || ((p * 0.0070) / 12);

    if ((hardCap > 0 && v > hardCap) || (expected > 0 && v > expected * 3)){
      return expected;
    }
    return v;
  }

  // ============================================================
  // //#7 — Pay + Mortgage extractors
  // ============================================================
  function extractBrainPay(brain){
    const pay = brain?.pay || brain || {};

    const base =
      n0(pickFirst(pay, ["basePay","base_pay","base"]) || 0) ||
      n0(pickFirst(brain, ["basePay","base_pay","base"]) || 0);

    const bah =
      n0(pickFirst(pay, ["bah","BAH","bahMonthly","bah_monthly"]) || 0) ||
      n0(pickFirst(brain, ["bah","BAH"]) || 0);

    const bas =
      n0(pickFirst(pay, ["bas","BAS","basMonthly","bas_monthly"]) || 0) ||
      n0(pickFirst(brain, ["bas","BAS"]) || 0);

    const disability =
      n0(pickFirst(pay, ["disability","vaDisabilityPay","vaDisabilityMonthly","va_disability_monthly","disabilityMonthly"]) || 0) ||
      n0(pickFirst(brain, ["disability","vaDisabilityPay","vaDisabilityMonthly","va_disability_monthly","disabilityMonthly"]) || 0);

    const totalExplicit =
      n0(pickFirst(pay, ["total","totalPay","total_pay","totalComp","total_comp","totalMonthly","monthlyTotal","monthly_total"]) || 0) ||
      n0(pickFirst(brain, ["total","totalPay","total_pay","totalComp","total_comp","totalMonthly","monthlyTotal","monthly_total"]) || 0);

    const computed = (base + bah + bas + disability);
    const total = (totalExplicit > 0 ? totalExplicit : (computed > 0 ? computed : 0));

    return { total, base, bah, bas, disability, computed, totalExplicit };
  }

  function extractBrainMortgage(brain){
    const candidates = [];
    candidates.push(n0(brain?.estimatedMonthlyMortgage));
    candidates.push(n0(brain?.estimated_monthly_mortgage));
    candidates.push(n0(brain?.monthlyMortgage));
    candidates.push(n0(brain?.monthly_mortgage));

    const m = brain?.mortgage || {};
    candidates.push(n0(m?.totalMonthly));
    candidates.push(n0(m?.total_monthly));
    candidates.push(n0(m?.monthlyTotal));
    candidates.push(n0(m?.monthly_total));

    candidates.push(n0(m?.principalInterest));
    candidates.push(n0(m?.principal_interest));
    candidates.push(n0(m?.pAndI));
    candidates.push(n0(m?.p_and_i));

    const best = candidates.map(v=>Number(v)||0).filter(v=>v>0).sort((a,b)=>b-a)[0] || 0;
    return best;
  }

  // ============================================================
  // //#8 — Feasibility publisher + derived mortgage store
  // ============================================================
  const FEAS_KEY = "realtysass.feasibility.v1";
  const VERDICT_KEY = "realtysass.ec_verdict.v1";
  const DERIVED_MTG_KEY = "realtysass.derived.housing_monthly.v1";

  function publishFeasibility(s){
    try{
      const income   = n0(s.income);
      const expenses = Math.max(0, n0(s.expenses));
      const housing  = Math.max(0, n0(s.mortgageMonthly));

      const capPct = 0.30;
      const housingCap = income * capPct;
      const disposable = income - (expenses + housing);

      let status = "GREEN";
      if (housing > housingCap || disposable < 0) status = "NO-GO";
      else if (disposable < income*0.10) status = "CAUTION";

      const delta = housing - housingCap;

      let bluf = "";
      if (status === "NO-GO"){
        bluf = `NO-GO: Housing is ${cur(housing,0)}/mo vs a safe cap of ${cur(housingCap,0)}/mo. Reduce by ~${cur(Math.max(0, delta),0)}.`;
      } else if (status === "CAUTION"){
        bluf = `CAUTION: Housing is ${cur(housing,0)}/mo vs cap ${cur(housingCap,0)}/mo. Buffer is thin (Disposable ${cur(disposable,0)}/mo).`;
      } else {
        bluf = `GREEN: Housing is ${cur(housing,0)}/mo under cap ${cur(housingCap,0)}/mo. Disposable ${cur(disposable,0)}/mo.`;
      }

      const payload = {
        schema: "realtysass.feasibility.v1",
        ts: Date.now(),
        source: {
          page: location.pathname || "",
          href: String(location.href || ""),
          widget: "fid-2A",
          version: "v3.9.5-embed2"
        },
        email: resolveEmail(),
        status,
        bluf,
        income: Math.round(income),
        expenses: Math.round(expenses),
        housing: Math.round(housing),
        housingCap: Math.round(housingCap),
        capPct,
        disposable: Math.round(disposable),
        creditScore: Math.round(n0(s.creditScore)),
        aprUsed: Number(s.aprUsed || 0),
        termYears: Math.round(n0(s.termYears||30)),
        price: Math.round(n0(s.price)),
        dpAmt: Math.round(n0(s.dpAmt)),
        mort_principal: Math.round(n0(s.principalMo)),
        mort_interest:  Math.round(n0(s.interestMo)),
        mort_tax:       Math.round(n0(s.taxMo)),
        mort_insurance: Math.round(n0(s.insMo)),
        mort_hoa:       Math.round(n0(s.hoaMo))
      };

      localStorage.setItem(FEAS_KEY, JSON.stringify(payload));
      localStorage.setItem(VERDICT_KEY, JSON.stringify({
        ts: payload.ts,
        status: payload.status,
        bluf: payload.bluf,
        housing: payload.housing,
        housingCap: payload.housingCap,
        disposable: payload.disposable
      }));

      // Derived mortgage monthly for other modules
      try{
        localStorage.setItem(DERIVED_MTG_KEY, JSON.stringify({
          value: Math.round(housing),
          meta: { source:"embed2", note:"mortgage monthly derived from snapshot" },
          updatedAt: new Date().toISOString()
        }));
      }catch(_){}

      try{
        if (window.parent && window.parent !== window){
          window.parent.postMessage({ type:"realtysass-feasibility", payload }, "*");
        }
      }catch(_){}
    }catch(_){}
  }

  // ============================================================
  // //#9 — Snapshot builder (the single source of truth for UI paint)
  // ============================================================
  CORE.snapshotFromBridge = function snapshotFromBridge(){
    const b = CORE.bridge || {};
    const ov = getOv();
    const brain = CORE.brain;

    const bp = extractBrainPay(brain);

    const brainTotal = n0(bp.total);
    const bridgeIncome = n0(b.income);
    const brainBase = n0(bp.base);

    const baseIncome = (brainTotal > 0 ? brainTotal : (bridgeIncome > 0 ? bridgeIncome : brainBase));
    const income     = baseIncome + (ov.addIncome || 0);

    const expenses0  = n0(b.expenses);
    const expenses = (ov.expenses==null ? expenses0 : Math.max(0, ov.expenses));

    const price =
      (ov.housing != null ? n0(ov.housing) : n0(b.housing || b.price || b.homePrice || b.purchasePrice || 0));

    const dpAmt =
      n0(b.dpAmt || b.downPayment || b.downPaymentAmt || b.down_payment || 0) ||
      n0(ov.savings != null ? ov.savings : b.savings);

    const termYears = n0(b.termYears) || 30;

    const creditScore = (ov.creditScore==null
      ? (Number(b.creditScore)||720)
      : clamp(ov.creditScore, 300, 850));

    const cityKey = b.cityKey || b.city || "SanAntonio";
    const bedrooms = n0(b.bedrooms || b.beds || 4) || 4;

    const city = extractCityFromBrain(brain);

    // ---- Mortgage via /api/mortgage (mortgage.js)
    // We always schedule a refresh; snapshot uses best available cached data immediately.
    const mortgagePayload = {
      // Keep payload intentionally small + deterministic
      price: Math.max(0, n0(price)),
      down: Math.max(0, n0(dpAmt)),              // mortgage.js can treat this as dp amount
      creditScore: Number(creditScore) || 720,
      termYears: Math.round(n0(termYears) || 30),
      cityKey,
      bedrooms,
      // OPTIONAL hints (mortgage.js may ignore if it self-derives):
      // loanType: "conventional"
    };

    // Schedule refresh when inputs change (debounced)
    if (mortgagePayload.price > 0){
      scheduleMortgageRefresh(mortgagePayload, "snapshot");
    }

    // Pull best cached mortgage result (if matches this payload)
    let mNorm = null;
    try{
      const key = stableKey(mortgagePayload);
      if (CORE.mortgage?.key === key && CORE.mortgage?.data?.ok) mNorm = CORE.mortgage.data;
      else {
        const c = readMortgageCache();
        if (c?.key === key && c?.data?.ok) mNorm = c.data;
      }
    }catch(_){}

    // Fallbacks if mortgage not available yet
    const brainMortgage = extractBrainMortgage(brain);

    const allIn = Math.max(0,
      n0(mNorm?.breakdown?.allIn) ||
      n0(brainMortgage) ||
      0
    );

    // Breakdown bars prefer mortgage.js; fallback to city components (light)
    let taxMo = Math.max(0, n0(mNorm?.breakdown?.tax));
    let insMo = Math.max(0, n0(mNorm?.breakdown?.insurance));
    let hoaMo = Math.max(0, n0(mNorm?.breakdown?.hoa));

    if (!taxMo && price>0) taxMo = cityTaxMonthly(price, city);
    if (!insMo && price>0) insMo = normalizeInsuranceMonthlyValue(cityInsuranceMonthly(price, city), price, city);
    if (!hoaMo) hoaMo = cityHoaMonthly(city);

    // Principal/Interest month-1 estimate
    let principalMo = Math.max(0, n0(mNorm?.breakdown?.principal));
    let interestMo  = Math.max(0, n0(mNorm?.breakdown?.interest));

    // If mortgage.js didn’t provide split, estimate from PI/loan/apr
    const pi = Math.max(0, n0(mNorm?.breakdown?.pi));
    const aprFromM = Math.max(0, n0(mNorm?.apr));
    const loanFromM = Math.max(0, n0(mNorm?.loan));

    if ((!principalMo || !interestMo) && pi>0 && aprFromM>0 && loanFromM>0){
      const mRate = (aprFromM/100)/12;
      interestMo = loanFromM * mRate;
      principalMo = Math.max(0, pi - interestMo);
    }

    // If still missing, keep them 0 (bars will still reflect tax/ins/hoa)
    const mortgageMonthly = Math.max(0, allIn);

    const allowances = Math.max(0, (brainTotal>0 ? (brainTotal - brainBase) : 0));
    const aprUsed = (aprFromM>0 ? aprFromM : scoreAPR(creditScore));

    return {
      income,
      expenses,
      price,
      dpAmt,
      creditScore,
      termYears,
      mortgageMonthly,
      principalMo,
      interestMo,
      taxMo,
      insMo,
      hoaMo,
      aprUsed,
      __baseIncome: baseIncome,
      __addIncome: (ov.addIncome || 0),
      __brainBase: brainBase,
      __brainAllowances: allowances,
      __brainBah: n0(bp.bah),
      __city: city,
      __cityKey: cityKey,
      __beds: bedrooms
    };
  };

  // ============================================================
  // //#10 — Feasibility Snapshot painter (Tiles + Mortgage breakdown bars)
  // ============================================================
  let __breakdownInjected = false;

  function ensureBreakdownRows(){
    if (__breakdownInjected) return;
    __breakdownInjected = true;

    const bars = document.querySelector(".fs-bars");
    if (!bars) return;

    const rows = bars.querySelectorAll(".fs-row");
    if (rows[0]?.querySelector(".name")) rows[0].querySelector(".name").textContent = "Principal";
    if (rows[1]?.querySelector(".name")) rows[1].querySelector(".name").textContent = "Interest";
    if (rows[2]?.querySelector(".name")) rows[2].querySelector(".name").textContent = "Taxes";
    if (rows[3]?.querySelector(".name")) rows[3].querySelector(".name").textContent = "Insurance";

    // Add HOA row if missing
    if (!document.getElementById("fs-bar-hoa")){
      const row = document.createElement("div");
      row.className = "fs-row";
      row.innerHTML = `
        <div class="name">HOA</div>
        <div class="fs-track"><div class="fs-fill housing" id="fs-bar-hoa"></div></div>
        <div class="amt" id="fs-amt-hoa">$—</div>
      `;
      bars.appendChild(row);
    }

    const note = document.getElementById("fs-note");
    if (note){
      note.textContent = "Bars show the Mortgage Estimate broken down by Principal, Interest, Taxes, Insurance, and HOA.";
    }
  }

  function setBar(id, pct){
    const el = document.getElementById(id);
    if (!el) return;
    el.style.width = clamp(Number(pct)||0, 0, 100) + "%";
    el.classList.remove("negative");
  }

  function setTileLabel(valueId, labelText){
    const valEl = document.getElementById(valueId);
    if (!valEl) return;
    const tile = valEl.closest(".fs-metric");
    const lbl = tile ? tile.querySelector(".lbl") : null;
    if (lbl) lbl.textContent = labelText;
  }

  function setTileSub(valueId, subText){
    const valEl = document.getElementById(valueId);
    if (!valEl) return;
    const tile = valEl.closest(".fs-metric");
    const sub = tile ? tile.querySelector(".sub") : null;
    if (sub) sub.textContent = subText;
  }

  function financialHealthGrade28(income, totalMonthlyExpenses){
    income = Math.max(0, n0(income));
    if (income <= 0) return "—";

    const disposable = income - totalMonthlyExpenses;
    const disposablePct = disposable / income;

    const totalShare = totalMonthlyExpenses / income;

    if (disposable < 0 || totalShare > 0.85) return "F";
    if (totalShare <= 0.60 && disposablePct >= 0.20) return "A";
    if (totalShare <= 0.65 && disposablePct >= 0.15) return "A-";
    if (totalShare <= 0.70 && disposablePct >= 0.10) return "B+";
    if (totalShare <= 0.75 && disposablePct >= 0.08) return "B";
    if (totalShare <= 0.80 && disposablePct >= 0.05) return "C";
    if (totalShare <= 0.85 && disposablePct >= 0.00) return "D";
    return "F";
  }

  function paintFeasibility(s){
    ensureBreakdownRows();

    const income = n0(s.income);
    const expenses = Math.max(0, n0(s.expenses));
    const mortgage = Math.max(0, n0(s.mortgageMonthly));

    const totalMonthlyExpenses = expenses + mortgage;
    const disposableIncome = income - totalMonthlyExpenses;

    // Tile #1
    const t1 = document.getElementById("fs-income");
    if (t1) t1.textContent = cur(income,0);
    setTileLabel("fs-income", "TOTAL MONTHLY INCOME");

    // Sub #1
    const base = n0(s.__brainBase);
    const allow = n0(s.__brainAllowances);
    const add  = n0(s.__addIncome);
    if (base>0 && allow>0){
      setTileSub("fs-income", add>0
        ? `Base ${cur(base,0)} + Allowances ${cur(allow,0)} + Add’l ${cur(add,0)}`
        : `Base ${cur(base,0)} + Allowances ${cur(allow,0)}`
      );
    } else {
      const bi = n0(s.__baseIncome);
      setTileSub("fs-income", add>0 ? `Base ${cur(bi,0)} + Add’l ${cur(add,0)}` : `Base ${cur(bi,0)}`);
    }

    // Tile #2 (uses fs-housing element)
    const t2 = document.getElementById("fs-housing");
    if (t2) t2.textContent = cur(totalMonthlyExpenses,0);
    setTileLabel("fs-housing", "TOTAL MONTHLY EXPENSES");
    setTileSub("fs-housing", `Monthly Expenses ${cur(expenses,0)} + Mortgage ${cur(mortgage,0)}`);

    // Tile #3 (uses fs-expenses element)
    const t3 = document.getElementById("fs-expenses");
    if (t3) t3.textContent = signed(disposableIncome);
    setTileLabel("fs-expenses", "DISPOSABLE INCOME");
    const dispPct = (income>0 ? Math.round((disposableIncome/income)*100) : 0);
    setTileSub("fs-expenses", `${dispPct}% Based on Total Income - Total Monthly Expenses`);

    // Tile #4 (uses fs-saving element)
    const t4 = document.getElementById("fs-saving");
    const grade = financialHealthGrade28(income, totalMonthlyExpenses);
    if (t4) t4.textContent = grade;
    setTileLabel("fs-saving", "FINANCIAL HEALTH");
    setTileSub("fs-saving", "Based on Disposable Income and Total Expense %");

    // Bars = mortgage breakdown
    const P = Math.max(0, n0(s.principalMo));
    const I = Math.max(0, n0(s.interestMo));
    const T = Math.max(0, n0(s.taxMo));
    const N = Math.max(0, n0(s.insMo));
    const H = Math.max(0, n0(s.hoaMo));

    const total = Math.max(1, (P+I+T+N+H) || mortgage || 1);

    setBar("fs-bar-exp", (P/total)*100);
    setBar("fs-bar-hou", (I/total)*100);
    setBar("fs-bar-sav", (T/total)*100);
    setBar("fs-bar-res", (N/total)*100);
    setBar("fs-bar-hoa", (H/total)*100);

    const aExp = document.getElementById("fs-amt-exp");
    const aHou = document.getElementById("fs-amt-hou");
    const aSav = document.getElementById("fs-amt-sav");
    const aRes = document.getElementById("fs-amt-res");
    const aHoa = document.getElementById("fs-amt-hoa");

    if (aExp) aExp.textContent = cur(P,0);
    if (aHou) aHou.textContent = cur(I,0);
    if (aSav) aSav.textContent = cur(T,0);
    if (aRes) aRes.textContent = cur(N,0);
    if (aHoa) aHoa.textContent = cur(H,0);

    // Bottom residual box becomes Mortgage Estimate
    const resVal = document.getElementById("fs-residual");
    if (resVal) resVal.textContent = cur(mortgage,0);
    const resWrap = resVal ? resVal.closest(".fs-res") : null;
    const resLbl = resWrap ? resWrap.querySelector(".lbl") : null;
    if (resLbl) resLbl.textContent = "MORTGAGE ESTIMATE";
  }

  // ============================================================
  // //#11 — Header KPI painter (top 5 cards)
  // ============================================================
  function paintKpis(s){
    const ki = $("#k-income");
    const ke = $("#k-expense");
    const km = $("#k-mtg");
    const ks = $("#k-save");

    if (ki) ki.textContent = cur(s.income,0);
    if (ke) ke.textContent = cur(s.expenses,0);

    // KPI #3 is still the purchase price (Housing Cost) — mortgage is shown in Feasibility + bottom
    if (km) km.textContent = cur(s.price,0);
    if (ks) ks.textContent = cur(s.dpAmt,0);

    const cs = Number(s.creditScore)||720;
    const kscore = $("#k-score");
    const band = $("#score-band");
    if (kscore) kscore.textContent = cs;
    if (band) band.textContent = `(${bandFromScore(cs)})`;

    const marker = $("#score-marker");
    if (marker){
      const pct = clamp((cs - 300) / (850 - 300), 0, 1);
      marker.style.left = (pct*100) + "%";
    }

    const slider = document.getElementById("score-slider");
    if (slider && document.activeElement !== slider) slider.value = String(cs);
  }

  // ============================================================
  // //#12 — KPI edit wiring
  // ============================================================
  function setEditing(cardId, isEditing){
    const el = document.getElementById(cardId);
    if (!el) return;
    el.classList.toggle("is-editing", !!isEditing);
  }
  function showActions(prefix, mode){
    const edit = document.getElementById(prefix+"-edit");
    const save = document.getElementById(prefix+"-save");
    const cancel = document.getElementById(prefix+"-cancel");
    if (edit) edit.style.display = (mode==="view") ? "" : "none";
    if (save) save.style.display = (mode==="edit") ? "" : "none";
    if (cancel) cancel.style.display = (mode==="edit") ? "" : "none";
  }

  function wireMoneyKpi({ cardId, prefix, inputId, onOpenFill, onSave }){
    const card = document.getElementById(cardId);
    const edit = document.getElementById(prefix+"-edit");
    const save = document.getElementById(prefix+"-save");
    const cancel = document.getElementById(prefix+"-cancel");
    const input = document.getElementById(inputId);
    if (!card || !input) return;

    const open = ()=>{
      const ov = readOverrides();
      const s = CORE.snapshotFromBridge();
      input.value = String(onOpenFill({ ov, s }) ?? "");
      setEditing(cardId, true);
      showActions(prefix, "edit");
      input.focus();
      input.select?.();
    };

    const close = ()=>{
      setEditing(cardId, false);
      showActions(prefix, "view");
    };

    const commit = ()=>{
      const n = Math.max(0, Number(input.value || 0) || 0);
      const ov = readOverrides();
      onSave({ n, ov });
      writeOverrides(ov);
      close();
      CORE.fetchBrain?.();
      CORE.paintAll();
    };

    edit && edit.addEventListener("click", open);
    cancel && cancel.addEventListener("click", ()=>{ close(); CORE.paintAll(); });
    save && save.addEventListener("click", commit);

    input.addEventListener("keydown", (e)=>{
      if (e.key === "Enter") commit();
      if (e.key === "Escape") { close(); CORE.paintAll(); }
    });
  }

  function wireCreditSlider(){
    const slider = document.getElementById("score-slider");
    const save = document.getElementById("kpi-score-save");
    const cancel = document.getElementById("kpi-score-cancel");
    if (!slider || !save || !cancel) return;

    let baseline = null;

    function enterEdit(){ save.style.display = ""; cancel.style.display = ""; }
    function exitEdit(){ save.style.display = "none"; cancel.style.display = "none"; baseline = null; }

    slider.addEventListener("pointerdown", ()=>{
      const s = CORE.snapshotFromBridge();
      baseline = Number(s.creditScore) || 720;
      enterEdit();
    });

    slider.addEventListener("input", ()=>{
      const liveDraft = Number(slider.value) || 720;
      const ov = readOverrides();
      ov.creditScore = clamp(liveDraft, 300, 850);
      writeOverrides(ov);
      CORE.fetchBrain?.();
      CORE.paintAll();
    });

    save.addEventListener("click", ()=>{ exitEdit(); CORE.paintAll(); });

    cancel.addEventListener("click", ()=>{
      const ov = readOverrides();
      if (baseline != null) ov.creditScore = clamp(baseline, 300, 850);
      else delete ov.creditScore;
      writeOverrides(ov);
      CORE.fetchBrain?.();
      exitEdit();
      CORE.paintAll();
    });
  }

  // ============================================================
  // //#13 — 2B Monthly Expenses Chart (NO Housing bucket)
  // ============================================================
  const EXP_STORE_KEY = "realtysass.expense_buckets.v1";
  const EXP_HISTORY_KEY = "realtysass.expense_history.v1";

  const BUCKETS = ["Utilities","Debt","Transportation","Food","Health","Entertainment","Other"];

  function getCityUtilitiesAvg(){
    try{
      const b = CORE.bridge || {};
      const beds = Number(b.bedrooms || b.beds || 4) || 4;

      const city = extractCityFromBrain(CORE.brain) || {};
      const raw = city.raw || {};

      const byBed =
        city.by_bedroom || raw.by_bedroom ||
        city.bedrooms || raw.bedrooms ||
        null;

      const blk = byBed ? (byBed[String(beds)] || byBed[beds]) : null;
      const u = blk && blk.utilities ? blk.utilities : null;

      const avg = u && u.total ? Number(u.total.avg || 0) : 0;
      if (avg > 0) return avg;

      const low = u && u.total ? Number(u.total.low || 0) : 0;
      const high= u && u.total ? Number(u.total.high || 0) : 0;
      if (low>0 && high>0) return (low+high)/2;
    }catch(_){}
    return 0;
  }

  function safeParseJSON(s){ try{ return JSON.parse(s); }catch(_){ return null; } }

  function buildExpenseModel(seedTotal){
    const util = Math.max(0, getCityUtilitiesAvg() || 0);
    const target = Math.max(Math.max(0,n0(seedTotal)), util);
    const remain = Math.max(0, target - util);

    const ratios = { Debt:0.22, Transportation:0.18, Food:0.28, Health:0.14, Entertainment:0.10, Other:0.08 };

    return {
      Utilities: util,
      Debt: remain * ratios.Debt,
      Transportation: remain * ratios.Transportation,
      Food: remain * ratios.Food,
      Health: remain * ratios.Health,
      Entertainment: remain * ratios.Entertainment,
      Other: remain * ratios.Other
    };
  }

  function loadExpenseStore(){
    const saved = safeParseJSON(localStorage.getItem(EXP_STORE_KEY) || "null");
    if (saved && saved.buckets) return saved;
    return null;
  }

  function saveExpenseStore(model, meta){
    const buckets = {};
    for (const k of BUCKETS) buckets[k] = Math.round(Math.max(0, n0(model[k])));
    const total = BUCKETS.reduce((a,k)=>a + buckets[k], 0);

    const payload = {
      total,
      buckets,
      meta: meta || {},
      updatedAt: new Date().toISOString()
    };
    try{ localStorage.setItem(EXP_STORE_KEY, JSON.stringify(payload)); }catch(_){}
    return payload;
  }

  function pushExpenseHistory(store){
    try{
      const now = new Date();
      const key = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;

      const arr = safeParseJSON(localStorage.getItem(EXP_HISTORY_KEY) || "[]") || [];
      const filtered = arr.filter(x => x && x.month !== key);

      filtered.push({ month:key, buckets: store.buckets, total: store.total, ts: Date.now() });

      // keep last 18 months
      filtered.sort((a,b)=> (a.month>b.month?1:-1));
      const trimmed = filtered.slice(-18);

      localStorage.setItem(EXP_HISTORY_KEY, JSON.stringify(trimmed));
    }catch(_){}
  }

  function computeYMaxAbs(model){
    const maxV = Math.max(...BUCKETS.map(k=>n0(model[k])), 0);
    return Math.max(500, Math.ceil((maxV * 1.25)/50)*50);
  }

  // Value label plugin (inside bars)
  const rsValueLabels = {
    id: "rsValueLabels",
    afterDatasetsDraw(chart, _args, pluginOptions){
      try{
        const mode = CORE.state?.barMode || "abs";
        const view = CORE.state?.barView || "monthly";
        if (!(mode==="abs" && view==="monthly")) return;

        const dsIndex = 0;
        const meta = chart.getDatasetMeta(dsIndex);
        if (!meta?.data?.length) return;

        const ctx = chart.ctx;
        const values = chart.data?.datasets?.[dsIndex]?.data || [];

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "800 11px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "rgba(0,0,0,.65)";
        ctx.lineWidth = 3;

        for (let i = 0; i < meta.data.length; i++){
          const el = meta.data[i];
          const raw = Number(values[i]) || 0;
          if (raw <= 0) continue;

          const x = el.x;
          const yTop = el.y;
          const yBase = el.base;
          const barH = Math.abs(yBase - yTop);

          const label = cur(raw, 0);

          let y = yTop + 14;
          let drawInside = true;

          if (barH < 26){
            y = yTop - 10;
            drawInside = false;
          }
          if (drawInside) y = Math.min(y, yBase - 10);

          ctx.strokeText(label, x, y);
          ctx.fillText(label, x, y);
        }
        ctx.restore();
      }catch(_){}
    }
  };

  function initExpenseChart(){
    const canvas = document.getElementById("fid-bars");
    if (!canvas || !window.Chart) return null;

    const ctx = canvas.getContext("2d");
    const chart = new Chart(ctx,{
      type:"bar",
      data:{
        labels: BUCKETS.slice(),
        datasets: [{
          label: "This Month",
          data: BUCKETS.map(()=>0),
          borderWidth: 0,
          borderRadius: 10
        }]
      },
      plugins: [rsValueLabels],
      options:{
        animation: { duration: 0 },
        plugins:{
          legend:{ display:true, labels:{ color:"#fff", boxWidth:12 } },
          tooltip:{
            callbacks:{
              label:(c)=>{
                const mode = CORE.state?.barMode || "abs";
                return mode==="pct" ? `${c.label}: ${Math.round(c.raw)}%` : `${c.label}: ${cur(c.raw,0)}`;
              }
            }
          }
        },
        scales:{
          x:{ ticks:{ color:"#fff" }, grid:{ color:"rgba(255,255,255,.06)" } },
          y:{
            beginAtZero:true,
            ticks:{ color:"#fff" },
            grid:{ color:"rgba(255,255,255,.06)" }
          }
        },
        responsive:true,
        maintainAspectRatio:false
      }
    });

    // Resize resilience
    const holder = canvas.closest(".chart-holder");
    if (holder){
      const ro = new ResizeObserver(()=> chart.resize());
      ro.observe(holder);
    }

    return chart;
  }

  function paintExpenseChart(){
    if (!CORE.state.barChart) return;
    const chart = CORE.state.barChart;
    const model = CORE.state.__expModel || buildExpenseModel(CORE.snapshotFromBridge().expenses);

    const mode = CORE.state.barMode || "abs";
    const view = CORE.state.barView || "monthly";

    if (view === "monthly"){
      chart.options.scales.x.stacked = false;
      chart.options.scales.y.stacked = false;

      chart.data.labels = BUCKETS.slice();

      const total = BUCKETS.reduce((a,k)=>a + Math.max(0,n0(model[k])), 0) || 1;
      const data = (mode==="pct")
        ? BUCKETS.map(k => Math.round((Math.max(0,n0(model[k]))/total)*100))
        : BUCKETS.map(k => Math.round(Math.max(0,n0(model[k]))));

      chart.data.datasets = [{
        label: (mode==="pct" ? "% Composition" : "This Month"),
        data,
        borderWidth: 0,
        borderRadius: 10
      }];

      chart.options.scales.y.max = (mode==="pct") ? 100 : computeYMaxAbs(model);
      chart.update("none");
      return;
    }

    // Yearly (stacked by month)
    const hist = safeParseJSON(localStorage.getItem(EXP_HISTORY_KEY) || "[]") || [];
    const months = hist.map(x=>x.month);
    if (!months.length){
      // fallback: show monthly if no history
      CORE.state.barView = "monthly";
      paintExpenseChart();
      return;
    }

    chart.options.scales.x.stacked = true;
    chart.options.scales.y.stacked = true;

    chart.data.labels = months;

    const totalsByMonth = hist.map(h => BUCKETS.reduce((a,k)=> a + Math.max(0,n0(h.buckets?.[k])), 0) || 1);

    chart.data.datasets = BUCKETS.map((k)=>({
      label: k,
      data: hist.map((h, idx)=>{
        const v = Math.max(0,n0(h.buckets?.[k]));
        if (mode==="pct") return Math.round((v / totalsByMonth[idx]) * 100);
        return Math.round(v);
      }),
      borderWidth: 0,
      borderRadius: 6
    }));

    chart.options.scales.y.max = (mode==="pct") ? 100 : undefined;
    chart.update("none");
  }

  // Drag + scroll adjust (monthly only)
  function wireExpenseDrag(){
    const chart = CORE.state.barChart;
    if (!chart || chart.__dragWired) return;
    chart.__dragWired = true;

    const canvas = chart.canvas;
    canvas.style.touchAction = "none";

    const drag = { active:false, idx:-1 };

    function relPos(ev){
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function nearestIndexFromX(px){
      const xScale = chart.scales.x;
      let best = -1, bestD = Infinity;
      for (let i=0; i<BUCKETS.length; i++){
        const cx = xScale.getPixelForValue(i);
        const d = Math.abs(px - cx);
        if (d < bestD){ bestD = d; best = i; }
      }
      return best;
    }

    function yPixelToValue(py){
      const yScale = chart.scales.y;
      return yScale.getValueForPixel(py);
    }

    function applyValue(idx, nextVal){
      if ((CORE.state.barView||"monthly") !== "monthly") return;
      const model = CORE.state.__expModel;
      if (!model) return;

      const label = BUCKETS[idx];
      if (!label) return;

      // If viewing pct, still edit underlying $ values
      const yMax = computeYMaxAbs(model);
      const v = clamp(Math.max(0, nextVal), 0, yMax * 1.5);

      model[label] = v;

      // Utilities becomes user-edited once touched
      if (label === "Utilities") CORE.state.__utilitiesUserEdited = true;

      const store = saveExpenseStore(model, {
        utilitiesBaseline: Math.round(getCityUtilitiesAvg()||0),
        utilitiesUserEdited: !!CORE.state.__utilitiesUserEdited
      });

      // Update total expense in KPI system when user adjusts bars
      // (We do NOT include mortgage here; this is monthly expenses only)
      const total = store.total;
      const ov = readOverrides();
      ov.expensesOverride = total;
      writeOverrides(ov);

      paintExpenseChart();
      CORE.fetchBrain?.();
      CORE.paintAll();
    }

    function setCursor(ev){
      const mode = CORE.state.barMode || "abs";
      const view = CORE.state.barView || "monthly";
      if (view !== "monthly"){ canvas.style.cursor = "default"; return; }

      const { x } = relPos(ev);
      const idx = nearestIndexFromX(x);
      canvas.style.cursor = (idx>=0 ? (mode==="pct" ? "ns-resize" : "ns-resize") : "default");
    }

    canvas.addEventListener("pointermove", (ev)=>{ if (!drag.active) setCursor(ev); });

    canvas.addEventListener("pointerdown", (ev)=>{
      if ((CORE.state.barView||"monthly") !== "monthly") return;
      const { x, y } = relPos(ev);
      const idx = nearestIndexFromX(x);
      if (idx<0) return;

      drag.active = true;
      drag.idx = idx;
      canvas.setPointerCapture(ev.pointerId);

      const v = yPixelToValue(y);
      applyValue(idx, v);
      ev.preventDefault();
    });

    canvas.addEventListener("pointermove", (ev)=>{
      if (!drag.active) return;
      const { y } = relPos(ev);
      const v = yPixelToValue(y);
      applyValue(drag.idx, v);
      ev.preventDefault();
    });

    function end(ev){
      if (!drag.active) return;
      drag.active = false;
      drag.idx = -1;
      try{ canvas.releasePointerCapture(ev.pointerId); }catch(_){}
      setCursor(ev);
      ev.preventDefault();
    }

    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", (ev)=>{ if (drag.active) end(ev); });

    // Scroll wheel adjust
    canvas.addEventListener("wheel", (ev)=>{
      try{
        if ((CORE.state.barView||"monthly") !== "monthly") return;

        const { x } = relPos(ev);
        const idx = nearestIndexFromX(x);
        if (idx<0) return;

        const model = CORE.state.__expModel;
        if (!model) return;

        const label = BUCKETS[idx];
        const current = Math.max(0, Number(model[label])||0);

        const stepBase = ev.shiftKey ? 250 : (ev.altKey || ev.metaKey) ? 10 : 50;
        const dir = (ev.deltaY < 0) ? +1 : -1; // wheel up increases
        const next = current + (dir * stepBase);

        applyValue(idx, next);
        ev.preventDefault();
      }catch(_){}
    }, { passive:false });
  }

  function wireExpenseControls(){
    const absBtn = document.getElementById("mode-abs");
    const pctBtn = document.getElementById("mode-pct");
    const viewSel = document.getElementById("exp-view");

    if (absBtn && !absBtn.__wired){
      absBtn.__wired = true;
      absBtn.addEventListener("click", ()=>{
        CORE.state.barMode = "abs";
        absBtn.setAttribute("aria-pressed","true");
        pctBtn && pctBtn.setAttribute("aria-pressed","false");
        paintExpenseChart();
      });
    }

    if (pctBtn && !pctBtn.__wired){
      pctBtn.__wired = true;
      pctBtn.addEventListener("click", ()=>{
        CORE.state.barMode = "pct";
        pctBtn.setAttribute("aria-pressed","true");
        absBtn && absBtn.setAttribute("aria-pressed","false");
        paintExpenseChart();
      });
    }

    if (viewSel && !viewSel.__wired){
      viewSel.__wired = true;
      viewSel.addEventListener("change", ()=>{
        CORE.state.barView = viewSel.value === "yearly" ? "yearly" : "monthly";
        paintExpenseChart();
      });
    }
  }

  // ============================================================
  // //#14 — 2C City Targets
  // ============================================================
  function solveTargetHomePrice({ income, dpAmtFixed, creditScore, termYears, city, capPct }){
    income = Math.max(0, n0(income));
    if (income <= 0) return 0;

    const cap = income * (capPct || 0.33);
    const apr = scoreAPR(creditScore);
    const mRate = (apr/100)/12;
    const N = Math.max(1, (n0(termYears)||30)*12);

    function monthlyForPrice(price){
      price = Math.max(0, n0(price));
      if (price <= 0) return 0;

      // If dp not provided, assume 5% of price
      const dp = (dpAmtFixed>0 ? Math.min(dpAmtFixed, price*0.35) : price*0.05);
      const loan = Math.max(0, price - dp);

      const pAndI = pmti(loan, mRate, N);
      let tax = cityTaxMonthly(price, city);
      let ins = cityInsuranceMonthly(price, city);
      let hoa = cityHoaMonthly(city);

      ins = normalizeInsuranceMonthlyValue(ins, price, city);

      return pAndI + tax + ins + hoa;
    }

    // Binary search price so monthly <= cap
    let lo = 50000;
    let hi = 2000000;

    // If dp is big, raise low
    if (dpAmtFixed > 0) lo = Math.max(lo, dpAmtFixed + 50000);

    for (let i=0; i<40; i++){
      const mid = (lo + hi)/2;
      const m = monthlyForPrice(mid);
      if (m > cap) hi = mid;
      else lo = mid;
    }
    return Math.round(lo/1000)*1000;
  }

  function paintCityTargets(s){
    const city = s.__city || extractCityFromBrain(CORE.brain) || {};
    const beds = Number(CORE.bridge?.bedrooms || CORE.bridge?.beds || 4) || 4;

    const ctBeds = document.getElementById("ct-beds");
    if (ctBeds) ctBeds.textContent = String(beds);

    // Target Rent: prefer BAH when available
    let targetRent = n0(s.__brainBah);
    if (targetRent <= 0){
      // Try city rent targets
      const rent = n0(pickFirst(city, ["target_rent","targetRent","rent_target","rentTarget","avg_rent","average_rent","rentAvg","rent_avg"]));
      targetRent = rent > 0 ? rent : 0;
    }

    // Average Home Price
    const avgHome = cityAvgHome(city);

    // Target Home Price from cap
    const targetHome = solveTargetHomePrice({
      income: s.income,
      dpAmtFixed: s.dpAmt,
      creditScore: s.creditScore,
      termYears: s.termYears,
      city,
      capPct: 0.33
    });

    const gap = (avgHome>0 && targetHome>0) ? (avgHome - targetHome) : 0;

    const elRent = document.getElementById("ct-rent");
    const elHome = document.getElementById("ct-home");
    const elTarget = document.getElementById("ct-target-home");
    const elGap = document.getElementById("ct-gap");
    const elPill = document.getElementById("ct-gap-pill");

    if (elRent) elRent.textContent = (targetRent>0 ? cur(targetRent,0) : "$—");
    if (elHome) elHome.textContent = (avgHome>0 ? cur(avgHome,0) : "$—");
    if (elTarget) elTarget.textContent = (targetHome>0 ? cur(targetHome,0) : "$—");
    if (elGap) elGap.textContent = (avgHome>0 && targetHome>0 ? signed(gap) : "$—");

    if (elPill){
      elPill.classList.remove("good","bad");
      if (avgHome>0 && targetHome>0){
        if (gap <= 0){
          elPill.textContent = "MARKET ≤ TARGET";
          elPill.classList.add("good");
        } else {
          elPill.textContent = "MARKET ABOVE TARGET";
          elPill.classList.add("bad");
        }
      } else {
        elPill.textContent = "—";
      }
    }
  }

  // ============================================================
  // //#15 — 2C Rent vs Buy (Net Cost) line chart
  // ============================================================
  function initLineChart(){
    const canvas = document.getElementById("fid-line");
    if (!canvas || !window.Chart) return null;

    const ctx = canvas.getContext("2d");
    return new Chart(ctx,{
      type:"line",
      data:{
        labels: Array.from({length:11}, (_,i)=> String(i)),
        datasets:[
          { label:"Rent (Net Cost)", data: Array(11).fill(0), tension:0.25, borderWidth:2, pointRadius:2 },
          { label:"Buy (Net Cost)",  data: Array(11).fill(0), tension:0.25, borderWidth:2, pointRadius:2 }
        ]
      },
      options:{
        animation:{ duration:0 },
        plugins:{
          legend:{ display:true, labels:{ color:"#fff" } },
          tooltip:{
            callbacks:{
              label:(c)=> `${c.dataset.label}: ${cur(c.raw,0)}`
            }
          }
        },
        scales:{
          x:{ ticks:{ color:"#fff" }, grid:{ color:"rgba(255,255,255,.06)" }, title:{ display:true, text:"Years", color:"#fff" } },
          y:{ ticks:{ color:"#fff" }, grid:{ color:"rgba(255,255,255,.06)" } }
        },
        responsive:true,
        maintainAspectRatio:false
      }
    });
  }

  function computeNetCostsSeries(s, rentStart){
    const yearsMax = 10;

    const price = Math.max(0, n0(s.price));
    const dp = Math.max(0, n0(s.dpAmt));
    const loan = Math.max(0, price - (dp>0 ? Math.min(dp, price*0.35) : price*0.05));

    const apr = scoreAPR(n0(s.creditScore)||720);
    const r = (apr/100)/12;
    const termN = Math.max(1, (n0(s.termYears)||30)*12);

    // Use snapshot’s monthly breakdown (best available)
    const pAndI = Math.max(0, (loan>0 ? pmti(loan, r, termN) : 0));
    const tax = Math.max(0, n0(s.taxMo));
    const ins = Math.max(0, n0(s.insMo));
    const hoa = Math.max(0, n0(s.hoaMo));

    const mortgageAllIn = pAndI + tax + ins + hoa;

    // Assumptions (lightweight but consistent)
    const rentGrowth = 0.03;
    const homeApp = 0.03;
    const closingBuy = 0.03;     // buyer closing costs
    const sellingCost = 0.06;    // selling friction
    const maintenance = 0.01;    // annual % of purchase price

    const rentSeries = [];
    const buySeries = [];

    for (let y=0; y<=yearsMax; y++){
      // Rent net cost over y years
      let rentCost = 0;
      for (let i=0; i<y; i++){
        const annualRent = (rentStart * 12) * Math.pow(1+rentGrowth, i);
        rentCost += annualRent;
      }

      // Buy net cost over y years (cash out - net proceeds)
      let cashOut = 0;
      cashOut += (dp>0 ? dp : price*0.05);
      cashOut += price * closingBuy;
      cashOut += mortgageAllIn * 12 * y;
      cashOut += price * maintenance * y;

      const months = y*12;
      const bal = remainingBalance(loan, r, pAndI, months);
      const homeValue = price * Math.pow(1+homeApp, y);
      const netProceeds = Math.max(0, homeValue - (homeValue*sellingCost) - bal);

      const buyNetCost = cashOut - netProceeds;

      rentSeries.push(Math.round(rentCost));
      buySeries.push(Math.round(buyNetCost));
    }

    return { rentSeries, buySeries };
  }

  function buildRentOptions(s){
    const opts = [];
    const bah = Math.max(0, n0(s.__brainBah));
    const cityRent = (() => {
      const city = s.__city || extractCityFromBrain(CORE.brain) || {};
      const r = n0(pickFirst(city, ["target_rent","targetRent","rent_target","rentTarget","avg_rent","average_rent","rentAvg","rent_avg"]));
      return Math.max(0, r);
    })();

    const base = bah>0 ? bah : (cityRent>0 ? cityRent : 1800);

    const candidates = [
      { label:"Target", value: base },
      { label:"Conservative (-10%)", value: Math.round(base*0.90) },
      { label:"Aggressive (+10%)", value: Math.round(base*1.10) }
    ];

    // If both exist and different, include BAH explicitly
    if (bah>0 && Math.abs(bah - base) > 50) candidates.unshift({ label:"BAH", value: bah });
    if (cityRent>0 && Math.abs(cityRent - base) > 50) candidates.push({ label:"Market Avg Rent", value: cityRent });

    // Dedup
    const seen = new Set();
    for (const c of candidates){
      const v = Math.round(c.value);
      if (v<=0) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      opts.push({ label:`${c.label} • ${cur(v,0)}`, value:v });
    }
    return opts.slice(0, 6);
  }

  function paintRentVsBuy(s){
    if (!CORE.state.lineChart){
      CORE.state.lineChart = initLineChart();
      if (!CORE.state.lineChart) return;
    }

    const rentSel = document.getElementById("rent-select");

    // Populate select once per session (or when cleared)
    if (rentSel && !rentSel.__filled){
      const options = buildRentOptions(s);
      rentSel.innerHTML = "";
      for (const o of options){
        const opt = document.createElement("option");
        opt.value = String(o.value);
        opt.textContent = o.label;
        rentSel.appendChild(opt);
      }

      rentSel.__filled = true;

      // set initial selection from state override
      if (CORE.state.rentStartOverride != null){
        rentSel.value = String(CORE.state.rentStartOverride);
      } else {
        CORE.state.rentStartOverride = Number(rentSel.value) || null;
      }

      rentSel.addEventListener("change", ()=>{
        CORE.state.rentStartOverride = Number(rentSel.value) || null;
        CORE.paintAll();
      });
    }

    const rentStart = Math.max(0, Number(CORE.state.rentStartOverride) || 0) || 1800;
    const { rentSeries, buySeries } = computeNetCostsSeries(s, rentStart);

    const chart = CORE.state.lineChart;
    chart.data.labels = Array.from({length:11}, (_,i)=> String(i));
    chart.data.datasets[0].data = rentSeries;
    chart.data.datasets[1].data = buySeries;
    chart.update("none");

    // Break-even years
    let be = "—";
    for (let y=1; y<=10; y++){
      if (buySeries[y] <= rentSeries[y]) { be = String(y); break; }
    }
    const beEl = document.getElementById("be-yrs");
    if (beEl) beEl.textContent = be;
  }

  // ============================================================
  // //#16 — Core paintAll
  // ============================================================
  CORE.state = CORE.state || {
    barMode:"abs",
    barView:"monthly",
    rentStartOverride:null,
    barChart:null,
    lineChart:null,
    __expModel:null,
    __utilitiesUserEdited:false
  };

  CORE.paintAll = function paintAll(){
    const s = CORE.snapshotFromBridge();

    // Keep KPI inputs aligned when not editing
    const ov = getOv();
    const addIn = document.getElementById("in-addIncome");
    const exIn  = document.getElementById("in-expensesOverride");
    const hoIn  = document.getElementById("in-housingOverride");
    const saIn  = document.getElementById("in-savingsOverride");

    if (addIn && !document.getElementById("kpi-income")?.classList.contains("is-editing")) addIn.value = String(ov.addIncome || 0);
    if (exIn  && !document.getElementById("kpi-expense")?.classList.contains("is-editing")) exIn.value  = String(ov.expenses==null ? "" : ov.expenses);
    if (hoIn  && !document.getElementById("kpi-mtg")?.classList.contains("is-editing"))    hoIn.value  = String(ov.housing==null ? "" : ov.housing);
    if (saIn  && !document.getElementById("kpi-save")?.classList.contains("is-editing"))   saIn.value  = String(ov.savings==null ? "" : ov.savings);

    paintKpis(s);
    paintFeasibility(s);

    // Expense model seed/update
    if (!CORE.state.barChart){
      CORE.state.barChart = initExpenseChart();
      if (CORE.state.barChart){
        wireExpenseControls();
        wireExpenseDrag();
      }
    }

    if (!CORE.state.__expModel){
      const store = loadExpenseStore();
      if (store?.buckets){
        CORE.state.__expModel = Object.assign({}, store.buckets);
        CORE.state.__utilitiesUserEdited = !!store?.meta?.utilitiesUserEdited;
      } else {
        CORE.state.__expModel = buildExpenseModel(s.expenses);
        CORE.state.__utilitiesUserEdited = false;
        saveExpenseStore(CORE.state.__expModel, {
          utilitiesBaseline: Math.round(getCityUtilitiesAvg()||0),
          utilitiesUserEdited: false
        });
      }
    } else {
      // If Utilities was never edited, re-seed to city avg each paint
      if (!CORE.state.__utilitiesUserEdited){
        const util = Math.max(0, getCityUtilitiesAvg()||0);
        if (util>0) CORE.state.__expModel.Utilities = util;
      }
    }

    if (CORE.state.barChart) paintExpenseChart();

    // City targets + rent vs buy
    paintCityTargets(s);
    paintRentVsBuy(s);

    // Publish feasibility & derived mortgage store
    publishFeasibility(s);
  };

  // ============================================================
  // //#17 — Boot
  // ============================================================
  onReady(async ()=>{
    loadBridge();

    wireMoneyKpi({
      cardId:"kpi-income", prefix:"kpi-income",
      inputId:"in-addIncome",
      onOpenFill: ({ov}) => n0(pickFirst(ov, ["addIncome","add_income"]) || 0),
      onSave: ({n, ov}) => { ov.addIncome = Math.max(0, n); }
    });

    wireMoneyKpi({
      cardId:"kpi-expense", prefix:"kpi-expense",
      inputId:"in-expensesOverride",
      onOpenFill: ({ov, s}) => {
        const v = numOrNull(pickFirst(ov, ["expensesOverride","expenses","monthlyExpenses"]));
        return (v==null ? s.expenses : v);
      },
      onSave: ({n, ov}) => { ov.expensesOverride = Math.max(0, n); }
    });

    wireMoneyKpi({
      cardId:"kpi-mtg", prefix:"kpi-mtg",
      inputId:"in-housingOverride",
      onOpenFill: ({ov, s}) => {
        const v = numOrNull(pickFirst(ov, ["housingOverride","housing","homePrice","priceOverride"]));
        return (v==null ? s.price : v);
      },
      onSave: ({n, ov}) => { ov.housingOverride = Math.max(0, n); }
    });

    wireMoneyKpi({
      cardId:"kpi-save", prefix:"kpi-save",
      inputId:"in-savingsOverride",
      onOpenFill: ({ov, s}) => {
        const v = numOrNull(pickFirst(ov, ["savingsOverride","savings","downpayment","dpAmt"]));
        return (v==null ? s.dpAmt : v);
      },
      onSave: ({n, ov}) => { ov.savingsOverride = Math.max(0, n); }
    });

    wireCreditSlider();

    await CORE.fetchBrain();
    CORE.__booted = true;

    // Warm mortgage cache immediately (non-blocking) so first paint is fast
    try{
      const b = CORE.bridge || {};
      const ov = getOv();
      const price =
        (ov.housing != null ? n0(ov.housing) : n0(b.housing || b.price || b.homePrice || b.purchasePrice || 0));
      const dpAmt =
        n0(b.dpAmt || b.downPayment || b.downPaymentAmt || b.down_payment || 0) ||
        n0(ov.savings != null ? ov.savings : b.savings);
      const creditScore = (ov.creditScore==null ? (Number(b.creditScore)||720) : clamp(ov.creditScore, 300, 850));
      const termYears = n0(b.termYears) || 30;
      const cityKey = b.cityKey || b.city || "SanAntonio";
      const bedrooms = n0(b.bedrooms || b.beds || 4) || 4;

      if (price>0){
        scheduleMortgageRefresh({
          price: Math.max(0, n0(price)),
          down: Math.max(0, n0(dpAmt)),
          creditScore: Number(creditScore)||720,
          termYears: Math.round(n0(termYears)||30),
          cityKey,
          bedrooms
        }, "boot");
      }
    }catch(_){}

    CORE.paintAll();

    // If user changes Housing Cost or Downpayment, refresh brain + repaint
    // (keeps it responsive without adding UI elements)
    window.addEventListener("storage", (e)=>{
      if (e.key === OV_KEY || e.key === "realtysass.bridge") {
        try{ loadBridge(); }catch(_){}
        CORE.fetchBrain?.();
        CORE.paintAll();
      }
    });
  });

})();
</script>

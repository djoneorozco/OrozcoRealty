<!-- =========================================================
  RealtySaSS • Premium Signup + Email Verify (All-in-One) v5.0
  - Uses /api/register, /api/send-code, /api/verify-code
  - Saves identity (NO password) to localStorage.realtysass.identity
  - Inline Verify card appears after "Create Premium Account"
========================================================= -->
<div id="sass-signup" style="all: initial;">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;900&display=swap" rel="stylesheet"/>

  <style>
    #sass-signup, #sass-signup * {
      box-sizing: border-box;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }

    /* ===== OUTER WRAPPER (DESIGNED FOR ~900px CONTAINER) ===== */
    #outer-wrapper {
      width: 100%;
      max-width: 900px;
      display: flex;
      justify-content: center;
      padding: 20px 10px;
      background: transparent !important;
      margin: 0 auto;
      flex-direction: column;
      gap: 16px;
    }

    #signup-container {
      width: 100%;
      max-width: 820px;
      background: transparent !important;
      padding: 20px 18px 24px;
      border-radius: 14px;
    }

    .signup-title {
      font-size: 30px;
      font-weight: 900;
      color: #0b0e1a;
      line-height: 1.15;
      margin-bottom: 6px;
    }

    .signup-desc {
      font-size: 13px;
      color: #444;
      max-width: 600px;
      margin-bottom: 18px;
      line-height: 1.55;
    }

    /* ===== ACTIVE DUTY / VETERAN TOGGLE ===== */
    #mode-row {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }

    .mode-btn {
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .08em;
      font-weight: 700;
      cursor: pointer;
      border: 1px solid rgba(0,0,0,.10);
      background: rgba(255,255,255,0.55);
      backdrop-filter: blur(5px);
      color: #0b0e1a;
      transition: 0.15s ease;
    }

    .mode-btn-active {
      background: radial-gradient(circle at top left, #8ef3c5, #6aa7ff);
      border-color: transparent;
      color: #050712 !important;
      box-shadow: 0 6px 14px rgba(0,0,0,.10);
    }

    /* ===== FORM FIELDS ===== */
    #signup-form {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .field-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: #6a7189;
      margin-bottom: 4px;
    }

    .sass-input, .sass-select, .sass-textarea {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      border-radius: 10px;
      border: 1px solid rgba(0,0,0,.08);
      background: rgba(255,255,255,0.55);
      backdrop-filter: blur(6px);
      color: #0b0e1a;
      box-shadow: 0 4px 12px rgba(0,0,0,.05);
      outline: none;
      transition: 0.15s ease;
    }

    .sass-input:focus,
    .sass-select:focus,
    .sass-textarea:focus {
      border-color: #6aa7ff;
      box-shadow: 0 0 0 2px rgba(142,243,197,.25);
    }

    .sass-select {
      appearance: none;
      background-image:
        linear-gradient(45deg, transparent 50%, #8ef3c5 60%),
        linear-gradient(135deg, #8ef3c5 40%, transparent 50%);
      background-position: calc(100% - 14px) calc(1em + 2px),
                           calc(100% - 10px) calc(1em + 2px);
      background-size: 6px 6px;
      background-repeat: no-repeat;
      cursor: pointer;
    }

    .sass-textarea {
      height: 100px;
      resize: vertical;
    }

    .hidden-field {
      display: none !important;
    }

    /* ===== SUBMIT BUTTON ===== */
    #signup-btn {
      width: 100%;
      padding: 12px;
      margin-top: 10px;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      background: radial-gradient(circle at top left, #8ef3c5, #6aa7ff);
      color: #050712;
      box-shadow: 0 14px 30px rgba(0,0,0,.15);
      transition: 0.15s ease;
    }

    #signup-btn:hover {
      transform: translateY(-2px);
      filter: brightness(1.05);
    }

    /* ===== INLINE VERIFY CARD ===== */
    #verify-container {
      width: 100%;
      max-width: 820px;
      margin: 0 auto 0;
    }

    #verify-card {
      max-width: 560px;
      margin: 8px auto 0;
      background: #181d2f;
      color: #e9ecff;
      border-radius: 12px;
      padding: 22px 20px;
      text-align: center;
      border: 1px solid #2a2f45;
      font-family: Inter, system-ui, sans-serif;
    }

    #verify-card.hidden {
      display: none !important;
    }

    #verify-card h2 {
      font-size: 20px;
      margin: 0 0 6px;
      font-weight: 800;
    }

    #verify-greet {
      margin: 6px 0 10px;
      font-weight: 700;
    }

    #verify-card p {
      color: #a8b0d6;
      font-size: 13px;
      line-height: 1.5;
      margin: 0 0 12px;
    }

    #verify-email,
    #verify-code {
      width: 100%;
      background: #0f1320;
      color: #e9ecff;
      border: 1px solid #31364a;
      border-radius: 8px;
      padding: 10px 12px;
      margin: 6px 0;
      font-size: 14px;
    }

    #verify-code {
      text-align: center;
      letter-spacing: 8px;
      font-size: 18px;
    }

    #btn-send-code,
    #btn-verify-code {
      width: 100%;
      padding: 10px;
      margin-top: 8px;
      border: 0;
      border-radius: 8px;
      background: #6a88ff;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      font-size: 14px;
    }

    #btn-send-code:disabled,
    #btn-verify-code:disabled {
      opacity: .6;
      cursor: not-allowed;
    }

    #verify-error {
      color: #ff8787;
      font-size: 13px;
      margin-top: 6px;
      min-height: 18px;
    }
  </style>

  <!-- ================== HTML STRUCTURE ================== -->
  <div id="outer-wrapper">
    <!-- SIGNUP PANEL -->
    <div id="signup-container">

      <div class="signup-title">
        Welcome to OrozcoRealty<br>Create your Premium Account.
      </div>

      <div class="signup-desc">
        Premium Accounts are Free for Veterans, Active Duty and their immediate families.
        Premium accounts are paid for by licensed Realtors. OrozcoRealty will never request fees.
      </div>

      <div id="mode-row">
        <button id="mode-ad" class="mode-btn mode-btn-active">Active Duty</button>
        <button id="mode-vet" class="mode-btn">Veteran</button>
      </div>

      <div id="signup-form">

        <div>
          <div class="field-label">Full Name</div>
          <input id="full-name" class="sass-input" type="text" />
        </div>

        <div>
          <div class="field-label">Email Address</div>
          <input id="email" class="sass-input" type="email" />
        </div>

        <!-- PASSWORD FIELD -->
        <div>
          <div class="field-label">Password (8 characters minimum)</div>
          <input id="password" class="sass-input" type="password" minlength="8" />
        </div>

        <div>
          <div class="field-label">Phone Number</div>
          <input id="phone" class="sass-input" type="text" />
        </div>

        <div id="rank-wrap">
          <div class="field-label">Rank</div>
          <select id="rank" class="sass-select">
            <optgroup label="Enlisted">
              <option value="E-1">E-1</option>
              <option value="E-2">E-2</option>
              <option value="E-3">E-3</option>
              <option value="E-4">E-4</option>
              <option value="E-5">E-5</option>
              <option value="E-6">E-6</option>
              <option value="E-7">E-7</option>
              <option value="E-8">E-8</option>
              <option value="E-9">E-9</option>
            </optgroup>
            <optgroup label="Officers">
              <option value="O-1">O-1</option>
              <option value="O-2">O-2</option>
              <option value="O-3">O-3</option>
              <option value="O-4">O-4</option>
              <option value="O-5">O-5</option>
              <option value="O-6">O-6</option>
              <option value="O-7">O-7</option>
              <option value="O-8">O-8</option>
              <option value="O-9">O-9</option>
              <option value="O-10">O-10</option>
            </optgroup>
          </select>
        </div>

        <div id="va-wrap" class="hidden-field">
          <div class="field-label">VA Disability %</div>
          <select id="va" class="sass-select">
            <option value="0">0%</option>
            <option value="10">10%</option>
            <option value="20">20%</option>
            <option value="30">30%</option>
            <option value="40">40%</option>
            <option value="50">50%</option>
            <option value="60">60%</option>
            <option value="70">70%</option>
            <option value="80">80%</option>
            <option value="90">90%</option>
            <option value="100">100%</option>
          </select>
        </div>

        <div>
          <div class="field-label">Years of Service</div>
          <select id="yos" class="sass-select">
            <option value="2">2 Years</option>
            <option value="4">4 Years</option>
            <option value="6">6 Years</option>
            <option value="8">8 Years</option>
            <option value="10">10 Years</option>
            <option value="12">12 Years</option>
            <option value="14">14 Years</option>
            <option value="16">16 Years</option>
            <option value="18">18 Years</option>
            <option value="20">20 Years</option>
            <option value="22">22 Years</option>
            <option value="24">24 Years</option>
            <option value="26">26 Years</option>
            <option value="28">28 Years</option>
            <option value="30">30 Years</option>
          </select>
        </div>

        <div>
          <div class="field-label">Family Size</div>
          <select id="family" class="sass-select">
            <option value="1">1 Person</option>
            <option value="2">2 People</option>
            <option value="3">3 People</option>
            <option value="4">4 People</option>
            <option value="5">5 People</option>
            <option value="6">6 People</option>
            <option value="7">7 People</option>
            <option value="8">8 People</option>
          </select>
        </div>

        <div>
          <div class="field-label">Base Location</div>
         

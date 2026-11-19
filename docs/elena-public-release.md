# Public Elena release

Elena uses TOR's existing panels and a single public endpoint. TheWing calculates; Elena explains. No account, email verification, Supabase connection, or saved profile is involved. Existing database records are untouched.

## What changed

- `ask-elena.js`: public Responses API gateway with GPT-6.2 Astra by default, low reasoning effort, strict structured output, server-filled financial figures, bounded history, no OpenAI response storage, provider timeout and guided fallback. Override the model with `ELENA_OPENAI_MODEL` only after checking that it supports reasoning and structured Responses output.
- `_shared/thewing.js`: strict adapters to the deployed TheWing mortgage, budget and compensation services. Missing numeric inputs stay missing; explicit zero remains valid. Browser result objects and profile claims are ignored. Model text cannot introduce numeric figures; selected facts are formatted by the server. This prevents unverified numeric figures, but it is not a guarantee of semantic correctness: live answer quality still needs evaluation.
- `_shared/knowledge.js`: loads the real `data/market/san-antonio.json` directory, uses a controlled source catalog, and withholds stale/mixed-geography market statistics. No claim of live listings, live mortgage rates, or refreshed local market data.
- Seven page callers share `js/ask-elena.js`: homepage, both active Elena pages, About, Resources, Resources Page, and Realty Intelligence. The existing panels, link menus, and circular avatars remain; no full portrait or screenshot panel was added. The homepage uses the existing `images/ElenaProfile.jpg` headshot. Launchers no longer require finishing a video. Fixed overlays escape transformed Webflow containers.
- Conversations remain in page memory. Users can reset, retry failed questions, and switch between English and Spanish. Calculator messages require the expected origin, registered iframe window, version, tool and increasing revision. A change while a reply is pending discards that reply.
- Paused account/profile handlers and their active callers are removed. Old `/api/` account routes return a public 410 retirement message. Removed direct `/.netlify/functions/` account routes return 404; Netlify reserves those paths and does not allow redirect rules for them. Git preserves the old code. No records are deleted and no Supabase service is contacted.
- Realty Intelligence's retired local mortgage fallback is replaced with the shared TheWing calculator. The existing Resources intake retains its local calculator handoff but no longer saves to a remote account.
- Function packaging uses ESM consistently. The static publish directory is `dist/`, built from an explicit asset allowlist; backend code, tests, secrets and Git files are excluded. Removed unused account dependencies and the unrelated OpenAI-key fallback in the staging function.

## Request contract

POST JSON to `/api/ask-elena` (direct `/.netlify/functions/ask-elena` also supported):

```json
{
  "message": "Explain my mortgage estimate",
  "context": {
    "product": "tor",
    "version": 1,
    "stage": "discovery",
    "thread": [],
    "calculators": {
      "mortgage": {"inputs": {}},
      "finance": null
    }
  }
}
```

Use `null` when there is no current calculator result. Mortgage inputs must contain a complete TheWing legacy mortgage or `military-mortgage-v1` contract, including explicit interest rate, tax, insurance and HOA assumptions. Budget inputs are the `finance-budget-v1` input fields, with gross income separate from take-home income and review status. The server recomputes inputs through TheWing. Chat does not calculate from numbers typed into prose.

Response: `ok`, `reply`, `facts`, `citations`, `explanation_mode`, `calculations`, `issues`. A `guided_fallback` response means the AI explanation was unavailable or failed validation; it is not a completed answer. Clients retain the question for retry. `elena-agent` is a deterministic public context endpoint. Direct `mortgage`/`mortgage-calculator` and `pay-tables` callers must use explicit inputs; old profile/default-filled contracts are retired. The secondary SEO endpoint also requires explicit mortgage assumptions instead of old city defaults.

## Configuration and deployment

- Netlify Functions secret: `OPENAI_API_KEY`. There is no browser API key.
- Optional `ELENA_OPENAI_MODEL`; default `gpt-6.2-astra`. The model upgrade changes API usage cost; a ChatGPT subscription does not configure this API key or fund API usage.
- Optional `ELENA_ALLOWED_ORIGINS`: comma-separated exact origins. Built-ins are TOR's `theorozcorealty.com` / `www` domain, TOR Netlify, Webflow staging, and TOR deploy previews. Localhost is permitted outside production.
- Platform rate limiting is configured per IP/domain: chat 12 requests per minute, context 20, calculation adapters 30. This is not an absolute account-wide spending cap. Set project usage alerts/budgets in the provider dashboard.
- Deploy the companion TheWing change allowing TOR production/preview origins in `public/ask-amy/tor-calculator-bridge.js`. Sharing still requires `?amy=tor`; formulas and other Amy clients are unchanged.
- Review a Netlify deploy preview with the real API environment before production. Confirm `ai_grounded`, Spanish replies, normal latency, genuine failure fallback, and connected calculations. Never put the API key in a test artifact or PR.
- GitHub/Webflow are separate. Updating this repository does not replace or publish Webflow custom embeds. Existing Webflow installations need the revised markup/client integration; reference the deployed `/js/ask-elena.js` and `/css/ask-elena.css` by absolute TOR Netlify URL when embedding there. Webflow publication is a separate step.
- Rollback: revert the release commit/PR, and the companion bridge PR if needed. Do not restore unauthenticated profile endpoints without a separate review.

## Validation and limits

`npm test`, `npm run check`, `npm run build`, `npm run test:browser`.

Backend fixtures were generated directly from TheWing commit `2658c68f10780f75478430220b768fad70346d52` with synthetic data. Live read-only checks of TheWing's deployed mortgage (two contracts), budget and compensation services matched the relevant reference outputs on November 19, 2026. A fractional-years compensation request was handled by the official shared engine instead of the old maximum bracket.

Browser checks cover all seven panels at 1440px and 390px, send/reset/retry, bounded history, safe text rendering, modal focus, cross-frame source checks, positive calculator transport and stale-result rejection. Remote media/analytics and model replies are mocked in automated browser checks. Native imports, inline script syntax, Node 22 bundles and Netlify function packaging were also exercised locally. No OpenAI API key was available locally: these tests validate contracts and safeguards, not live model latency or answer quality.

The secondary SEO/AIOU/report/staging features and historical city/pay datasets are not comprehensively modernized in this release. Elena's active path does not consume their independent calculations. Broader knowledge refresh and an evaluated question set are follow-up work.

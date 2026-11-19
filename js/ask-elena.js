/* Public Elena client. No account lookup, persistent chat storage or automatic AI calls. */
(() => {
  'use strict';
  function boot() {
    const root = document.querySelector('#tor-ask-amy, #ask-elena-shell, #ask-elena-widget, #tor-ask-elena-command-widget');
    if (!root || root.dataset.elenaReady) return;
    root.dataset.elenaReady = '1';
    const byId = id => document.getElementById(id);
    const home = root.id === 'tor-ask-amy', command = root.id === 'tor-ask-elena-command-widget';
    const prefix = home ? 'tor-amy-' : command ? 'tor-elena-' : 'ae-';
    const chat = byId(prefix + 'chat'), input = byId(prefix + 'input'), send = byId(prefix + 'send');
    if (!chat || !input || !send) return;
    const dialog = byId('tor-amy-dialog'), modal = byId('ask-elena-modal'), hud = byId(prefix + 'hud');
    const surface = dialog || modal || hud;
    // Fixed overlays belong at the document root, outside transformed Webflow sections.
    if (command || root.id === 'ask-elena-widget') document.body.append(root);
    if (modal && modal.parentElement !== document.body) document.body.append(modal);
    const launcher = byId('tor-amy-launcher') || byId('ask-elena-launcher') || byId('ae-openBtn');
    const close = byId('tor-amy-close') || byId('ask-elena-modal-close') || byId('ae-closeBtn') || byId('tor-elena-close');
    const toolDialog = byId('tl-tool-dialog');
    const api = location.hostname.endsWith('.webflow.io') ? 'https://theorozcorealty.netlify.app/api/ask-elena' : '/api/ask-elena';
    const toolOrigin = 'https://thewing.netlify.app';
    const thread = [], calculators = { mortgage: null, finance: null }, frames = new Map();
    const labels = { discovery: 'Discovery & Qualification', buying: 'Homebuying Education & Journey', ownership: 'Lifetime Ownership' };
    let stage = null, generation = 0, busy = false, controller, opener = launcher, oldOverflow;
    const status = byId('tor-amy-status') || document.createElement('p');
    if (!status.id) { status.className = 'elena-status'; status.setAttribute('role', 'status'); input.parentElement.after(status); }
    const privacy = home ? byId('tor-amy-sharing') : document.createElement('p');
    privacy.textContent = 'No account or email needed. Sending shares your question and connected calculator inputs with TOR, TheWing calculation services, and OpenAI for an explanation. Chat stays in page memory; reload to clear it.';
    if (!home) { privacy.className = 'elena-privacy'; status.after(privacy); }
    const reset = byId('tor-amy-reset') || document.createElement('button');
    if (!reset.id) { reset.type = 'button'; reset.textContent = 'Start a new conversation'; reset.className = 'elena-reset'; privacy.after(reset); }
    chat.setAttribute('role', 'log'); chat.setAttribute('aria-live', 'polite'); chat.setAttribute('aria-relevant', 'additions');
    chat.setAttribute('aria-label', 'Conversation with Elena');
    input.maxLength = 3000; input.setAttribute('aria-label', 'Your question for Elena');
    function note(text, role = 'assistant', citations = []) {
      const article = document.createElement('article');
      article.className = home ? 'tor-amy-message' : command ? 'tor-elena-msg ' + (role === 'user' ? 'tor-elena-user' : 'tor-elena-bot') : 'ae-msg ' + (role === 'user' ? 'ae-user' : 'ae-bot');
      article.dataset.role = role;
      const name = document.createElement('strong'), copy = document.createElement('p');
      name.textContent = role === 'user' ? 'You' : 'Elena'; copy.textContent = text; copy.style.whiteSpace = 'pre-wrap';
      article.append(name, copy);
      for (const source of citations.slice(0, 3)) {
        try {
          const url = new URL(source.url);
          if (url.protocol !== 'https:') continue;
          const link = document.createElement('a'); link.href = url.href; link.textContent = source.title; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'elena-source'; article.append(link);
        } catch { /* Ignore malformed links. */ }
      }
      chat.append(article); chat.scrollTop = chat.scrollHeight;
    }
    function welcome() { note('I’m Elena, your San Antonio homeownership guide. Ask about buying, selling, or owning a home. I can explain connected calculator results. También puedo ayudarle en español.'); }
    function contextView() {
      if (byId('tor-amy-stage')) byId('tor-amy-stage').textContent = labels[stage] || 'Your homeownership journey';
      for (const tool of ['mortgage', 'finance']) {
        const indicator = byId('tor-amy-' + tool + '-state');
        if (indicator) indicator.textContent = (tool === 'finance' ? 'Budget' : 'Mortgage') + (calculators[tool] ? ' · inputs ready to check' : ' · no current result');
      }
    }
    function typeForFrame(frame) {
      try {
        const url = new URL(frame.src);
        if (url.origin !== toolOrigin || url.searchParams.get('amy') !== 'tor') return null;
        return /^\/Finance-UX\/$/i.test(url.pathname) ? 'finance' : /^\/(?:Mortgage-Calculator|Military-Mortgage)\/$/i.test(url.pathname) ? 'mortgage' : null;
      } catch { return null; }
    }
    function requestContext(frame) { frame.contentWindow?.postMessage({ source: 'tor-amy-host', version: 1, type: 'tor:context-request' }, toolOrigin); }
    function scanFrames() {
      for (const [frame, record] of frames) if (!frame.isConnected || typeForFrame(frame) !== record.tool) { calculators[record.tool] = null; frames.delete(frame); }
      document.querySelectorAll('iframe').forEach(frame => {
        const tool = typeForFrame(frame); if (!tool || frames.has(frame)) return;
        frames.set(frame, { tool, revision: -1 }); calculators[tool] = null;
        frame.addEventListener('load', () => { const r = frames.get(frame); if (!r) return; r.revision = -1; calculators[tool] = null; contextView(); requestContext(frame); });
        requestContext(frame);
      }); contextView();
    }
    window.addEventListener('message', event => {
      const d = event.data;
      if (event.origin !== toolOrigin || !d || d.source !== 'tor-calculator' || d.version !== 1) return;
      const entry = [...frames].find(([frame]) => frame.contentWindow === event.source);
      if (!entry) return;
      const [frame, record] = entry;
      if (d.tool !== record.tool || typeForFrame(frame) !== record.tool) return;
      if (d.type === 'tor:calculator-close') { if (toolDialog?.open && !dialog?.open) toolDialog.close(); return; }
      if (d.type !== 'tor:calculator-context' || !Number.isSafeInteger(d.revision) || d.revision <= record.revision) return;
      record.revision = d.revision;
      calculators[record.tool] = d.snapshot?.inputs && typeof d.snapshot.inputs === 'object' && !Array.isArray(d.snapshot.inputs) ? { inputs: d.snapshot.inputs } : null;
      contextView();
    });
    function readStage() {
      const value = document.querySelector('#tl-journey .tl-stage-card[aria-expanded="true"]')?.getAttribute('href')?.replace('#tl-', '');
      stage = Object.hasOwn(labels, value) ? value : null; contextView();
    }
    function isOpen() { return dialog ? dialog.open : modal ? modal.style.display === 'flex' : hud ? hud.dataset.open === '1' : true; }
    function open(from) {
      opener = from || launcher; scanFrames(); readStage();
      if (!isOpen() && surface) { oldOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden'; }
      if (dialog && !dialog.open) dialog.showModal();
      if (modal) modal.style.display = 'flex';
      if (hud) hud.dataset.open = '1';
      launcher?.setAttribute('aria-expanded', 'true'); input.focus();
    }
    function restoreFocus() { launcher?.setAttribute('aria-expanded', 'false'); if (oldOverflow !== undefined) document.documentElement.style.overflow = oldOverflow; opener?.focus({ preventScroll: true }); }
    function shut() {
      if (dialog?.open) dialog.close();
      if (modal) modal.style.display = 'none';
      if (hud) hud.dataset.open = '0';
      restoreFocus();
    }
    // The chat launcher must not depend on finishing a promotional video.
    if (launcher) {
      launcher.style.opacity = '1'; launcher.style.pointerEvents = 'auto'; launcher.style.transform = 'none';
      if (launcher.tagName !== 'BUTTON') {
        launcher.setAttribute('role', 'button'); launcher.tabIndex = 0;
        launcher.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(launcher); } });
      }
    }
    launcher?.addEventListener('click', () => open(launcher)); close?.addEventListener('click', shut);
    dialog?.addEventListener('close', restoreFocus);
    modal?.addEventListener('click', e => { if (e.target === modal) shut(); });
    if (surface) {
      if (!dialog) { surface.setAttribute('role', 'dialog'); surface.setAttribute('aria-label', 'Ask Elena'); }
      surface.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopPropagation(); shut(); }
        if (e.key === 'Tab' && !dialog && isOpen()) {
          const list = [...surface.querySelectorAll('button, input, textarea, a[href], [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
          if (!list.length) return;
          if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list.at(-1).focus(); }
          else if (!e.shiftKey && document.activeElement === list.at(-1)) { e.preventDefault(); list[0].focus(); }
        }
      });
    }
    document.querySelectorAll('[data-tor-open-amy]').forEach(button => button.addEventListener('click', e => { e.preventDefault(); open(button); }));
    window.OrozcoAskElena = { open: () => open(), close: shut, toggle: () => isOpen() ? shut() : open() };
    if (toolDialog && home) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tor-amy-tool-trigger'; button.textContent = 'Ask Elena';
      byId('tl-tool-close')?.before(button); button.addEventListener('click', () => open(button));
    }
    const signature = () => JSON.stringify({ stage, calculators });
    function setBusy(value) { busy = value; send.disabled = value; input.disabled = value; chat.setAttribute('aria-busy', String(value)); }
    async function ask(raw) {
      const message = raw.trim().slice(0, 3000); if (busy || !message) return;
      setBusy(true); note(message, 'user'); input.value = ''; status.textContent = 'Elena is reviewing your question…';
      const id = ++generation, contextSignature = signature();
      controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 40000);
      try {
        const response = await fetch(api, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ message, context: { product: 'tor', version: 1, stage, calculators, thread: thread.slice(-12) } }) });
        if (response.status === 429) throw Error('rate_limit');
        const data = await response.json(); if (id !== generation) return;
        if (!response.ok || !data.ok || typeof data.reply !== 'string') throw Error('unavailable');
        if (contextSignature !== signature()) { input.value = message; status.textContent = 'Your calculator inputs changed. Send again to use the current results.'; return; }
        note(data.reply, 'assistant', Array.isArray(data.citations) ? data.citations : []);
        // A fallback is not a completed conversation turn. Keep the original question ready to retry.
        if (data.explanation_mode === 'guided_fallback') { input.value = message; status.textContent = 'AI explanation unavailable. Your question is ready to retry.'; }
        else {
          thread.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply.slice(0, 4000) });
          while (thread.length > 12 || thread.reduce((n, t) => n + t.content.length, 0) > 18000) thread.splice(0, 2);
          status.textContent = 'Answered using your current context.';
        }
      } catch (error) {
        if (id !== generation) return;
        input.value = message;
        status.textContent = error.message === 'rate_limit' ? 'Please wait a minute before sending again. Your question is saved here.' : 'Elena could not finish. Your question is ready to retry.';
      } finally { clearTimeout(timer); if (id === generation) { setBusy(false); if (isOpen()) input.focus(); } }
    }
    const form = byId('tor-amy-form');
    if (form) form.addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
    else { send.type = 'button'; send.addEventListener('click', () => ask(input.value)); }
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });
    byId('ae-dockSend')?.addEventListener('click', () => { const dock = byId('ae-dockInput'); open(); ask(dock.value); dock.value = ''; });
    byId('ae-dockInput')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); byId('ae-dockSend').click(); } });
    root.querySelectorAll('[data-tor-amy-question]').forEach(button => button.addEventListener('click', () => { input.value = button.dataset.torAmyQuestion; input.focus(); }));
    reset.addEventListener('click', () => { generation++; controller?.abort(); thread.length = 0; chat.replaceChildren(); input.value = ''; setBusy(false); status.textContent = 'New conversation. Current calculator inputs remain connected.'; welcome(); input.focus(); });
    const journey = byId('tl-journey'); if (journey) new MutationObserver(readStage).observe(journey, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
    // Only observe calculator hosts, not the changing chat log.
    for (const host of [byId('tl-tool-body'), byId('elena-mortgage-workspace')].filter(Boolean)) new MutationObserver(scanFrames).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    chat.replaceChildren(); welcome(); scanFrames(); readStage();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();

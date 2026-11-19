import { test, expect } from '@playwright/test';
const pages = ['index.html','ask-elena.html','ask-elena-copy.html','about-us.html','resources.html','resources-page.html','realty-intelligence.html'];
const response = { ok: true, reply: 'Elena is ready to help you compare your options.', facts: [], citations: [{ title:'Homebuying resources',url:'https://www.consumerfinance.gov/owning-a-home/' }], explanation_mode: 'ai_grounded' };
async function prepare(page) {
  // Isolate third-party Webflow analytics, images, and calculators. API and iframe transport are mocked deliberately.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.route('**/api/ask-elena', route => route.fulfill({json:response}));
}
async function open(page, name) {
  await page.goto('/'+name, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-elena-ready="1"]')).toHaveCount(1);
  if(name==='index.html') await page.locator('#tor-amy-launcher').click();
  else if(['about-us.html','resources.html'].includes(name)) await page.locator('#ask-elena-launcher').click();
  else if(name==='resources-page.html') await page.evaluate(()=>window.OrozcoAskElena.open());
  else if(name==='realty-intelligence.html') await page.locator('#ae-openBtn').click();
  return page.locator(name==='index.html'?'#tor-amy-input':name==='resources-page.html'?'#tor-elena-input':'#ae-input');
}
for(const width of [1440,390]) for(const name of pages) test(`${name} public chat at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900}); await prepare(page); const input=await open(page,name);
  await expect(input).toBeVisible(); await expect(page.locator('#ae-email,#ae-verify,#tor-elena-email,#rs-lock-overlay')).toHaveCount(0);
  await input.fill('What should I ask my lender?'); await input.press('Enter');
  await expect(page.getByText(response.reply,{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Homebuying resources',exact:true})).toBeVisible();
  await expect.poll(async()=>{const b=await input.boundingBox();return b.x+b.width;}).toBeLessThanOrEqual(width+1);
  const box=await input.boundingBox(); expect(box.width).toBeGreaterThan(90); expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x+box.width).toBeLessThanOrEqual(width+1);
  if(name==='index.html'||name==='resources-page.html'||name==='realty-intelligence.html'||name==='about-us.html'||name==='resources.html') expect(box.y+box.height).toBeLessThanOrEqual(901);
  const stored=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>/elena.*(?:thread|memory|cid|profile|email)/i.test(key))); expect(stored).toEqual([]);
  await page.getByRole('button',{name:'Start a new conversation',exact:true}).click(); await expect(page.getByText(response.reply,{exact:true})).toHaveCount(0);
  if(name==='index.html'){await input.press('Escape');await expect(page.locator('#tor-amy-dialog')).not.toBeVisible();await expect(page.locator('#tor-amy-launcher')).toBeFocused();}
});
test('network failure retains the question and successful follow-up carries bounded history',async({page})=>{
 await prepare(page);const input=await open(page,'index.html');let count=0;const payloads=[];
 await page.route('**/api/ask-elena',route=>{payloads.push(route.request().postDataJSON());if(count++===0)return route.abort();return route.fulfill({json:response});});
 await input.fill('Explain closing costs');await input.press('Enter');await expect(input).toHaveValue('Explain closing costs');await expect(page.locator('#tor-amy-status')).toContainText('retry');
 await input.press('Enter');await expect(page.getByText(response.reply,{exact:true})).toBeVisible();await input.fill('What comes next?');await input.press('Enter');
 await expect(page.getByText(response.reply,{exact:true})).toHaveCount(2);expect(payloads.at(-1).context.thread).toHaveLength(2);
});
test('reset aborts an in-flight answer; unsafe markup is rendered as text',async({page})=>{
 await prepare(page);const input=await open(page,'ask-elena.html');let release;const gate=new Promise(r=>release=r);
 await page.route('**/api/ask-elena',async route=>{await gate;await route.fulfill({json:{...response,reply:'<img src=x onerror="window.pwned=true">'}}).catch(()=>{});});
 await input.fill('Hello');await input.press('Enter');await page.getByRole('button',{name:'Start a new conversation',exact:true}).click();release();
 await expect(page.locator('#ae-chat')).not.toContainText('<img');await expect(input).toBeEnabled();
 await page.unroute('**/api/ask-elena');await page.route('**/api/ask-elena',route=>route.fulfill({json:{...response,reply:'<img src=x onerror="window.pwned=true">'}}));
 await input.fill('Hello again');await input.press('Enter');await expect(page.locator('#ae-chat')).toContainText('<img');expect(await page.evaluate(()=>window.pwned)).toBeUndefined();
});
test('unregistered frame messages cannot inject calculator figures and changed context discards pending answers',async({page})=>{
 await prepare(page);const input=await open(page,'index.html');let pending;const gate=new Promise(r=>pending=r);const payloads=[];
 await page.route('**/api/ask-elena',async route=>{payloads.push(route.request().postDataJSON());await gate;await route.fulfill({json:response});});
 await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://thewing.netlify.app',source:window,data:{source:'tor-calculator',version:1,type:'tor:calculator-context',tool:'mortgage',revision:9,snapshot:{inputs:{price:1}}}})));
 await input.fill('Explain the estimate');await input.press('Enter');await expect.poll(()=>payloads.length).toBe(1);expect(payloads[0].context.calculators.mortgage).toBeNull();
 await page.evaluate(()=>document.querySelector('#tl-journey .tl-stage-card').setAttribute('aria-expanded','true'));pending();
 await expect(page.locator('#tor-amy-status')).toContainText('inputs changed');await expect(page.getByText(response.reply,{exact:true})).toHaveCount(0);await expect(input).toHaveValue('Explain the estimate');
});
test('registered calculator frames send inputs only; invalidation blocks a stale answer',async({page})=>{
 await prepare(page);
 await page.route('https://thewing.netlify.app/Military-Mortgage/?amy=tor',route=>route.fulfill({contentType:'text/html',body:`<script>
 let revision=0;
 function publish(snapshot){parent.postMessage({source:'tor-calculator',version:1,type:'tor:calculator-context',tool:'mortgage',revision:++revision,snapshot},'http://127.0.0.1:4178');}
 window.addEventListener('message',e=>{if(e.data.type==='tor:context-request')publish({inputs:{contract:'military-mortgage-v1',homePrice:300000},result:{monthly:{allIn:1}}});});
 window.invalidate=()=>publish(null);
 </script>`}));
 const input=await open(page,'index.html');
 await page.evaluate(()=>{const f=document.createElement('iframe');f.id='test-calculator';f.src='https://thewing.netlify.app/Military-Mortgage/?amy=tor';document.getElementById('tl-tool-body').append(f);});
 await expect(page.locator('#tor-amy-mortgage-state')).toContainText('inputs ready');
 let pending;const gate=new Promise(r=>pending=r);let payload;
 await page.route('**/api/ask-elena',async route=>{payload=route.request().postDataJSON();await gate;await route.fulfill({json:response});});
 await input.fill('Explain my mortgage');await input.press('Enter');await expect.poll(()=>!!payload).toBe(true);
 expect(payload.context.calculators.mortgage.inputs.homePrice).toBe(300000);expect(payload.context.calculators.mortgage.result).toBeUndefined();
 const frame=page.frames().find(f=>f.url().includes('/Military-Mortgage/'));await frame.evaluate(()=>window.invalidate());
 await expect(page.locator('#tor-amy-mortgage-state')).toContainText('no current result');pending();
 await expect(page.locator('#tor-amy-status')).toContainText('inputs changed');await expect(page.getByText(response.reply,{exact:true})).toHaveCount(0);
});

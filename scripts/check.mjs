import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Script } from 'node:vm';
import { build } from 'esbuild';
const functions = readdirSync('netlify/functions').filter(f => f.endsWith('.js')).map(f => `netlify/functions/${f}`);
for (const file of functions) { execFileSync(process.execPath, ['--check', file]); await import(`../${file}`); }
for (const file of ['js/ask-elena.js', ...readdirSync('netlify/functions/_shared').map(f => `netlify/functions/_shared/${f}`)]) execFileSync(process.execPath, ['--check', file]);
const pages = ['index.html','ask-elena.html','ask-elena-copy.html','about-us.html','resources.html','resources-page.html','realty-intelligence.html','create-account.html','military/create-account.html'];
let scripts = 0;
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/type=["'](?:application\/ld\+json|application\/json|module)/i.test(match[1]) || !match[2].trim()) continue;
    new Script(match[2], { filename: `${file} inline script ${++scripts}` });
    if (/fetch\([^)]*(?:profile-by-email|verify-code|\/api\/login)/.test(match[2])) throw Error(`Legacy account caller: ${file}`);
  }
}
await build({ entryPoints: functions, bundle: true, platform: 'node', target: 'node22', format: 'esm', outdir: '.netlify/check-bundle', logLevel: 'warning' });
console.log(`Checked ${functions.length} function imports, ${scripts} inline scripts, and Node 22 bundles.`);

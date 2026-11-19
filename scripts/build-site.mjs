import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
// Publish only exported site assets, never backend source, tests, credentials, or Git history.
rmSync('dist', { recursive: true, force: true }); mkdirSync('dist');
for (const file of readdirSync('.')) if (/\.html$/.test(file) || ['CNAME','robots.txt','sitemap.xml','favicon.ico','_redirects'].includes(file)) cpSync(file, `dist/${file}`);
for (const dir of ['css','js','images','videos','fonts','documents','market','military','contact-us','listings','blogs','utilities'])
  if (existsSync(dir)) cpSync(dir, `dist/${dir}`, { recursive: true });
console.log('Built public site in dist/; server code and tests excluded.');

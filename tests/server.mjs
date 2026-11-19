import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('dist');
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp', '.woff2':'font/woff2' };
http.createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(file); res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream'}).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(4178,'127.0.0.1');

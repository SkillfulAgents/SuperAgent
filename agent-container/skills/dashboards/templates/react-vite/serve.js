import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.DASHBOARD_PORT || 3000;
const distDir = path.join(__dirname, 'dist');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(pathname) {
  let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    // File not found — serve index.html for SPA client-side routing,
    // but only for non-API paths (API misses should 404, not return HTML)
    if (pathname.startsWith('/api/') || pathname.startsWith('/api')) {
      return new Response('Not Found', { status: 404 });
    }
    filePath = path.join(distDir, 'index.html');
  }

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    return new Response(content, {
      headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    // --- Add API routes here ---
    // Example:
    //   if (url.pathname === '/api/data') {
    //     return Response.json({ items: [1, 2, 3] });
    //   }

    return serveStatic(url.pathname);
  },
});

console.log(`Dashboard server running on http://localhost:${port}`);

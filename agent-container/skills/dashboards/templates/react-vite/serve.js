import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.DASHBOARD_PORT || 3000;
const distDir = path.join(__dirname, 'dist');
const publicBasePath = process.env.DASHBOARD_BASE_PATH || '';

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function stripPublicBase(pathname) {
  if (!publicBasePath) return pathname;
  const mount = publicBasePath.endsWith('/') ? publicBasePath.slice(0, -1) : publicBasePath;
  if (pathname === mount) return '/';
  if (pathname.startsWith(`${mount}/`)) return pathname.slice(mount.length) || '/';
  return pathname;
}

function cacheControl(filePath) {
  if (filePath.endsWith('index.html')) return 'no-cache';
  if (/[/\\]assets[/\\].+-[A-Za-z0-9_-]{8,}\.[^/\\]+$/.test(filePath)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function escapeHtmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function withDocumentBase(html) {
  if (/<base\b[^>]*>/i.test(html)) return html;
  const href = publicBasePath || '/';
  const tag = `<base data-gamut-dashboard-base href="${escapeHtmlAttribute(href)}">`;
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${tag}`);
}

function responseForFile(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const file = fs.readFileSync(filePath);
    const content = ext === '.html' ? withDocumentBase(file.toString('utf8')) : file;
    return new Response(content, {
      headers: {
        'Cache-Control': cacheControl(filePath),
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

function serveStatic(request, rawPathname) {
  const pathname = stripPublicBase(rawPathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.resolve(distDir, relativePath);

  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    // Only document navigations receive SPA fallback. A missing module, style,
    // image, worker, or API route must be a real 404 rather than index.html with
    // a misleading text/html MIME type.
    const acceptsHtml = request.headers.get('accept')?.includes('text/html');
    if (request.method !== 'GET' || !acceptsHtml || pathname.startsWith('/api')) {
      return new Response('Not Found', { status: 404 });
    }
    filePath = path.join(distDir, 'index.html');
  }

  return responseForFile(filePath);
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

    return serveStatic(req, url.pathname);
  },
});

console.log(`Dashboard server running on http://localhost:${port}`);

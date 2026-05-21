#!/usr/bin/env node
// Pass-through proxy for capturing the first /v1/messages request per model
// emitted by SuperAgent's agent-container (or any anthropic-sdk client).
// On first sighting of each model, dump body.tools / body.system / body.messages
// as readable .md files. Subsequent calls for the same model are forwarded
// without capture.

import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { URL } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const PORT = Number(args.port || process.env.PORT || 9876);
const UPSTREAM = (args.upstream || process.env.UPSTREAM || 'https://api.anthropic.com').replace(/\/$/, '');
const OUT_DIR = resolve(args.out || process.env.OUT_DIR || './captures');
const RESET = args.reset === 'true' || args.reset === '';

mkdirSync(OUT_DIR, { recursive: true });
const seenFile = join(OUT_DIR, '.seen-models.json');
let seen = new Set();
if (!RESET && existsSync(seenFile)) {
  try { seen = new Set(JSON.parse(readFileSync(seenFile, 'utf8'))); } catch {}
}

const upstreamUrl = new URL(UPSTREAM);
const httpLib = upstreamUrl.protocol === 'https:' ? https : http;

function fence(lang, s) { return '```' + lang + '\n' + s + '\n```\n'; }

// Per-request volatile fields that change between identical builds and would
// otherwise pollute every cross-snapshot diff. `cch=<hex>` is Claude Code's
// per-request cache hash (header inside system[0]); it differs across every
// run for the same input. The capture timestamp lives in meta.json, never in
// the rendered .md.
function redact(text) {
  return String(text).replace(/cch=[0-9a-f]+/gi, 'cch=<redacted>');
}

function dumpCapture(model, body, ts) {
  const dir = join(OUT_DIR, sanitize(model));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'raw.json'), JSON.stringify(body, null, 2));

  const note = `> Model: \`${model}\`\n> Source: agent-container intercept proxy\n> Volatile fields redacted: \`cch=<redacted>\`; capture timestamp lives in meta.json.\n\n---\n\n`;

  // system.md
  const sys = body.system;
  let sysMd = `# System Prompts\n\n${note}`;
  if (typeof sys === 'string') {
    sysMd += sys + '\n';
  } else if (Array.isArray(sys)) {
    sysMd += `\`body.system\` is an array of ${sys.length} blocks.\n\n`;
    sys.forEach((blk, i) => {
      sysMd += `## system[${i}] — type: \`${blk.type ?? '?'}\`\n`;
      if (blk.cache_control) sysMd += `_cache_control_: \`${JSON.stringify(blk.cache_control)}\`\n\n`;
      sysMd += redact(blk.text ?? JSON.stringify(blk, null, 2)) + '\n\n---\n\n';
    });
  } else {
    sysMd += '_(no system block)_\n';
  }
  writeFileSync(join(dir, 'system.md'), sysMd);

  // messages.md
  const msgs = body.messages || [];
  let msgMd = `# Messages\n\n${note}\`body.messages\` has ${msgs.length} message(s).\n\n`;
  msgs.forEach((m, i) => {
    msgMd += `## messages[${i}] — role: \`${m.role}\`\n\n`;
    const c = m.content;
    if (typeof c === 'string') { msgMd += c + '\n\n'; return; }
    if (!Array.isArray(c)) { msgMd += fence('json', JSON.stringify(c, null, 2)); return; }
    c.forEach((blk, j) => {
      msgMd += `### content[${j}] — type: \`${blk.type}\`\n`;
      if (blk.cache_control) msgMd += `_cache_control_: \`${JSON.stringify(blk.cache_control)}\`\n\n`;
      if (blk.type === 'text') msgMd += redact(blk.text ?? '') + '\n\n';
      else if (blk.type === 'tool_use') {
        msgMd += `**tool**: \`${blk.name}\` **id**: \`${blk.id}\`\n\n**input**:\n\n` + fence('json', JSON.stringify(blk.input ?? {}, null, 2));
      } else if (blk.type === 'tool_result') {
        msgMd += `**tool_use_id**: \`${blk.tool_use_id}\` **is_error**: \`${blk.is_error ?? false}\`\n\n`;
        const tc = blk.content;
        if (typeof tc === 'string') msgMd += fence('', tc);
        else if (Array.isArray(tc)) tc.forEach(x => msgMd += x.type === 'text' ? fence('', x.text ?? '') : fence('json', JSON.stringify(x, null, 2)));
      } else {
        msgMd += fence('json', JSON.stringify(blk, null, 2));
      }
    });
    msgMd += '\n---\n\n';
  });
  writeFileSync(join(dir, 'messages.md'), msgMd);

  // tools.md
  const tools = body.tools || [];
  let toolsMd = `# Tools\n\n${note}\`body.tools\` has **${tools.length}** definitions.\n\n## Index\n\n`;
  tools.forEach((t, i) => toolsMd += `- [${i + 1}. ${t.name}](#${i + 1}-${slugify(t.name)})\n`);
  toolsMd += '\n---\n\n';
  tools.forEach((t, i) => {
    toolsMd += `## ${i + 1}. ${t.name}\n\n`;
    if (t.description) toolsMd += t.description.trim() + '\n\n';
    toolsMd += `**input_schema**:\n\n` + fence('json', JSON.stringify(t.input_schema ?? {}, null, 2)) + '\n---\n\n';
  });
  writeFileSync(join(dir, 'tools.md'), toolsMd);

  console.log(`[capture] ${model} → ${dir} (system ${sys?.length ?? 0}, messages ${msgs.length}, tools ${tools.length})`);
}

function sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80); }
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    // Try to capture; failures must not block forwarding
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      try {
        const body = JSON.parse(raw.toString('utf8'));
        const model = body.model || 'unknown';
        if (!seen.has(model)) {
          seen.add(model);
          writeFileSync(seenFile, JSON.stringify([...seen], null, 2));
          dumpCapture(model, body, new Date().toISOString());
        } else {
          console.log(`[skip] ${model} already captured`);
        }
      } catch (e) {
        console.error('[capture-error]', e.message);
      }
    }

    // Forward to upstream
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    headers.host = upstreamUrl.host;

    const fwd = httpLib.request({
      protocol: upstreamUrl.protocol,
      host: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });

    fwd.on('error', (e) => {
      console.error('[upstream-error]', e.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream error: ' + e.message);
    });

    if (raw.length) fwd.write(raw);
    fwd.end();
  });
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on http://localhost:${PORT}`);
  console.log(`[proxy] upstream  ${UPSTREAM}`);
  console.log(`[proxy] out dir   ${OUT_DIR}`);
  console.log(`[proxy] seen so far: ${[...seen].join(', ') || '(none)'}`);
});

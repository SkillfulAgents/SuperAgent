import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { SessionManager } from './session-manager';
import { CreateSessionRequest, SendMessageRequest } from './types';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as dns from 'dns';
import { inputManager } from './input-manager';
import { dashboardManager } from './dashboard-manager';

// Global error handlers to prevent crashes from AbortError during interrupts
// The SDK throws AbortError when queries are aborted, which can propagate uncaught
process.on('uncaughtException', (error: Error) => {
  // AbortError is expected during interrupt operations - don't crash
  if (error.name === 'AbortError' || error.message?.includes('aborted')) {
    console.log('[Server] Caught AbortError (expected during interrupt):', error.message);
    return;
  }
  console.error('[Server] Uncaught exception:', error);
  // For other errors, log but don't exit - let the container stay alive
});

process.on('unhandledRejection', (reason: unknown) => {
  // AbortError is expected during interrupt operations - don't crash
  if (reason instanceof Error) {
    if (reason.name === 'AbortError' || reason.message?.includes('aborted')) {
      console.log('[Server] Caught unhandled AbortError (expected during interrupt):', reason.message);
      return;
    }
  }
  console.error('[Server] Unhandled rejection:', reason);
  // Don't exit - let the container stay alive
});

const app = new Hono();
const sessionManager = new SessionManager();

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Session endpoints
app.post('/sessions', async (c) => {
  try {
    const body = await c.req.json<CreateSessionRequest>();

    if (!body.initialMessage) {
      return c.json({ error: 'initialMessage is required' }, 400);
    }

    const session = await sessionManager.createSession(body);
    return c.json(session, 201);
  } catch (error: any) {
    console.error('Error creating session:', error);
    return c.json({ error: error.message || 'Failed to create session' }, 500);
  }
});

app.get('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({
    ...session,
    isRunning: sessionManager.isSessionRunning(sessionId),
  });
});

app.get('/sessions', (c) => {
  const sessions = sessionManager.getAllSessions();
  return c.json(sessions);
});

app.delete('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const deleted = await sessionManager.deleteSession(sessionId);

  if (!deleted) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ success: true });
});

app.post('/sessions/:id/interrupt', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const interrupted = await sessionManager.interruptSession(sessionId);

    if (!interrupted) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error interrupting session:', error);
    return c.json({ error: error.message || 'Failed to interrupt session' }, 500);
  }
});

// Message endpoints
app.get('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const messages = sessionManager.getMessages(sessionId);
  return c.json(messages);
});

app.post('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    const body = await c.req.json<SendMessageRequest>();
    const content = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);

    await sessionManager.sendMessage(sessionId, content);

    return c.json({ success: true }, 201);
  } catch (error: any) {
    console.error('Error sending message:', error);
    return c.json({ error: error.message || 'Failed to send message' }, 500);
  }
});

// File system endpoints
app.get('/files/*', async (c) => {
  const filePath = c.req.param('*') || '';
  const fullPath = path.join('/workspace', filePath);

  try {
    const stats = await fs.promises.stat(fullPath);

    if (stats.isDirectory()) {
      const files = await fs.promises.readdir(fullPath);
      const fileInfos = await Promise.all(
        files.map(async (file) => {
          const fileFullPath = path.join(fullPath, file);
          const fileStats = await fs.promises.stat(fileFullPath);
          return {
            name: file,
            path: path.join(filePath, file),
            type: fileStats.isDirectory() ? 'directory' : 'file',
            size: fileStats.isFile() ? fileStats.size : undefined,
            modifiedAt: fileStats.mtime,
          };
        })
      );
      return c.json(fileInfos);
    } else {
      return c.json({
        name: path.basename(filePath),
        path: filePath,
        type: 'file',
        size: stats.size,
        modifiedAt: stats.mtime,
      });
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File or directory not found' }, 404);
    }
    console.error('Error accessing file:', error);
    return c.json({ error: error.message || 'Failed to access file' }, 500);
  }
});

app.get('/files/*/content', async (c) => {
  const filePath = (c.req.param('*') || '').replace('/content', '');
  const fullPath = path.join('/workspace', filePath);

  try {
    const content = await fs.promises.readFile(fullPath, 'utf-8');
    return c.text(content);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File not found' }, 404);
    }
    console.error('Error reading file:', error);
    return c.json({ error: error.message || 'Failed to read file' }, 500);
  }
});

app.post('/files/*/upload', async (c) => {
  const filePath = (c.req.param('*') || '').replace('/upload', '');
  const fullPath = path.join('/workspace', filePath);

  try {
    const body = await c.req.text();
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, body);
    return c.json({ success: true, path: filePath });
  } catch (error: any) {
    console.error('Error uploading file:', error);
    return c.json({ error: error.message || 'Failed to upload file' }, 500);
  }
});

app.delete('/files/*', async (c) => {
  const filePath = c.req.param('*') || '';
  const fullPath = path.join('/workspace', filePath);

  try {
    const stats = await fs.promises.stat(fullPath);
    if (stats.isDirectory()) {
      await fs.promises.rm(fullPath, { recursive: true });
    } else {
      await fs.promises.unlink(fullPath);
    }
    return c.json({ success: true });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File or directory not found' }, 404);
    }
    console.error('Error deleting file:', error);
    return c.json({ error: error.message || 'Failed to delete file' }, 500);
  }
});

app.post('/files/*/mkdir', async (c) => {
  const dirPath = (c.req.param('*') || '').replace('/mkdir', '');
  const fullPath = path.join('/workspace', dirPath);

  try {
    await fs.promises.mkdir(fullPath, { recursive: true });
    return c.json({ success: true, path: dirPath });
  } catch (error: any) {
    console.error('Error creating directory:', error);
    return c.json({ error: error.message || 'Failed to create directory' }, 500);
  }
});

app.get('/files/tree', async (c) => {
  const depth = parseInt(c.req.query('depth') || '3');
  const startPath = c.req.query('path') || '';
  const fullPath = path.join('/workspace', startPath);

  try {
    const tree = await buildFileTree(fullPath, depth, 0);
    return c.json(tree);
  } catch (error: any) {
    console.error('Error building file tree:', error);
    return c.json({ error: error.message || 'Failed to build file tree' }, 500);
  }
});

// Input resolution endpoints - used by the server to resolve pending user input requests
// Requests are keyed by toolUseId (captured via PreToolUse hook)

// POST /inputs/:toolUseId/resolve - Resolve a pending input request with a value
app.post('/inputs/:toolUseId/resolve', async (c) => {
  const toolUseId = c.req.param('toolUseId');

  try {
    const body = await c.req.json<{ value: string | Record<string, string> }>();

    if (body.value === undefined || body.value === null) {
      return c.json({ error: 'value is required' }, 400);
    }

    if (inputManager.resolve(toolUseId, body.value)) {
      return c.json({ success: true });
    }

    return c.json({ error: 'No pending request found for this toolUseId' }, 404);
  } catch (error: any) {
    console.error('Error resolving input:', error);
    return c.json({ error: error.message || 'Failed to resolve input' }, 500);
  }
});

// POST /inputs/:toolUseId/reject - Reject a pending input request
app.post('/inputs/:toolUseId/reject', async (c) => {
  const toolUseId = c.req.param('toolUseId');

  try {
    const body = await c.req.json<{ reason?: string }>();
    const reason = body.reason || 'User declined';

    if (inputManager.reject(toolUseId, reason)) {
      return c.json({ success: true });
    }

    return c.json({ error: 'No pending request found for this toolUseId' }, 404);
  } catch (error: any) {
    console.error('Error rejecting input:', error);
    return c.json({ error: error.message || 'Failed to reject input' }, 500);
  }
});

// GET /inputs/pending - List all pending input requests (useful for debugging)
app.get('/inputs/pending', (c) => {
  return c.json(inputManager.getAllPending());
});

// Helper to update the .env file with a key-value pair
async function updateEnvFile(key: string, value: string): Promise<void> {
  const envFilePath = '/workspace/.env';

  try {
    // Read existing .env file or start fresh
    let envContent = '';
    try {
      envContent = await fs.promises.readFile(envFilePath, 'utf-8');
    } catch {
      // File doesn't exist yet, start fresh
    }

    // Parse existing entries
    const lines = envContent.split('\n');
    const entries = new Map<string, string>();

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const k = trimmed.substring(0, eqIndex);
          const v = trimmed.substring(eqIndex + 1);
          entries.set(k, v);
        }
      }
    }

    // Update or add the new entry (quote the value to handle special chars)
    entries.set(key, `"${value.replace(/"/g, '\\"')}"`);

    // Write back
    const newContent = Array.from(entries.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';

    await fs.promises.writeFile(envFilePath, newContent, { mode: 0o600 });
    console.log(`[ENV] Updated .env file with ${key}`);
  } catch (error) {
    console.error(`[ENV] Failed to update .env file:`, error);
    throw error;
  }
}

// POST /env - Set an environment variable at runtime
app.post('/env', async (c) => {
  try {
    const body = await c.req.json<{ key: string; value: string }>();

    if (!body.key || body.value === undefined) {
      console.error('[ENV] Missing key or value in request');
      return c.json({ error: 'key and value are required' }, 400);
    }

    // Validate the key is a valid environment variable name
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(body.key)) {
      console.error(`[ENV] Invalid env var name: ${body.key}`);
      return c.json({ error: 'Invalid environment variable name' }, 400);
    }

    // Set the environment variable in process.env (for Node.js code)
    process.env[body.key] = body.value;
    console.log(`[ENV] Set environment variable: ${body.key} (${body.value.length} chars)`);

    // Also write to .env file (for uv/python scripts)
    await updateEnvFile(body.key, body.value);

    // Verify it was set in process.env
    if (process.env[body.key] !== body.value) {
      console.error(`[ENV] Failed to verify env var was set: ${body.key}`);
      return c.json({ error: 'Failed to verify environment variable was set' }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[ENV] Error setting env var:', error);
    return c.json({ error: error.message || 'Failed to set environment variable' }, 500);
  }
});

// ============================================================
// Dashboard / Artifacts endpoints
// ============================================================

// GET /artifacts - List all dashboards
app.get('/artifacts', (c) => {
  const dashboards = dashboardManager.listDashboards();
  return c.json(dashboards);
});

// POST /artifacts/:slug/create - Scaffold a new dashboard
app.post('/artifacts/:slug/create', async (c) => {
  try {
    const slug = c.req.param('slug');
    const body = await c.req.json<{
      name: string;
      description?: string;
      framework?: 'plain' | 'react';
    }>();

    if (!body.name) {
      return c.json({ error: 'name is required' }, 400);
    }

    await dashboardManager.createDashboard(
      slug,
      body.name,
      body.description || '',
      body.framework || 'plain'
    );

    return c.json({ success: true, slug, path: `/workspace/artifacts/${slug}` });
  } catch (error: any) {
    console.error('[Artifacts] Error creating dashboard:', error);
    return c.json({ error: error.message || 'Failed to create dashboard' }, 500);
  }
});

// POST /artifacts/:slug/start - Start or restart a dashboard
app.post('/artifacts/:slug/start', async (c) => {
  try {
    const slug = c.req.param('slug');
    const info = await dashboardManager.startDashboard(slug);
    return c.json({
      success: true,
      slug: info.slug,
      name: info.name,
      status: info.status,
      port: info.port,
    });
  } catch (error: any) {
    console.error('[Artifacts] Error starting dashboard:', error);
    return c.json({ error: error.message || 'Failed to start dashboard' }, 500);
  }
});

// GET /artifacts/:slug/logs - Get dashboard logs
app.get('/artifacts/:slug/logs', async (c) => {
  try {
    const slug = c.req.param('slug');
    const clear = c.req.query('clear') === 'true';
    const logs = await dashboardManager.getDashboardLogs(slug, clear);
    return c.text(logs);
  } catch (error: any) {
    console.error('[Artifacts] Error getting logs:', error);
    return c.json({ error: error.message || 'Failed to get logs' }, 500);
  }
});

// Shared handler for proxying requests to a dashboard server
async function proxyToDashboard(c: any) {
  const slug = c.req.param('slug');
  const port = dashboardManager.getDashboardPort(slug);

  if (!port) {
    return c.json({ error: `Dashboard ${slug} is not running` }, 503);
  }

  const url = new URL(c.req.url);
  const prefixPattern = `/artifacts/${slug}`;
  const subPath = url.pathname.slice(url.pathname.indexOf(prefixPattern) + prefixPattern.length) || '/';
  const targetUrl = `http://localhost:${port}${subPath}${url.search}`;

  const headers = new Headers(c.req.header());
  headers.delete('host');

  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD'
      ? await c.req.arrayBuffer()
      : undefined,
  });

  return new Response(response.body, {
    status: response.status,
    headers: new Headers(response.headers),
  });
}

// ALL /artifacts/:slug/* - Proxy to dashboard server
app.all('/artifacts/:slug/*', async (c) => {
  try {
    return await proxyToDashboard(c);
  } catch (error: any) {
    console.error('[Artifacts] Proxy error:', error);
    return c.json({ error: error.message || 'Failed to proxy request' }, 502);
  }
});

// Also handle /artifacts/:slug (no trailing slash)
app.all('/artifacts/:slug', async (c) => {
  try {
    return await proxyToDashboard(c);
  } catch (error: any) {
    console.error('[Artifacts] Proxy error:', error);
    return c.json({ error: error.message || 'Failed to proxy request' }, 502);
  }
});

// ============================================================
// Browser automation endpoints (agent-browser tool proxy)
// ============================================================

interface BrowserState {
  active: boolean;
  sessionId: string | null;
  cdpUrl: string | null;
}

let browserState: BrowserState = { active: false, sessionId: null, cdpUrl: null };

const execFileAsync = promisify(execFile);

// Split a command string into arguments, respecting quoted strings.
// e.g. 'get text "hello world"' -> ['get', 'text', 'hello world']
function splitCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

// Execute an agent-browser CLI command and return the result.
// Uses execFile (no shell) to prevent command injection.
async function execBrowser(args: string[], cdpUrl?: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const fullArgs = cdpUrl ? ['--cdp', cdpUrl, ...args] : args;
    const { stdout } = await execFileAsync('agent-browser', fullArgs, {
      timeout: 30000,
      env: {
        ...process.env,
        AGENT_BROWSER_STREAM_PORT: process.env.AGENT_BROWSER_STREAM_PORT || '9223',
        AGENT_BROWSER_ARGS: process.env.AGENT_BROWSER_ARGS || '--no-sandbox,--disable-blink-features=AutomationControlled',
      },
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.trim() || error.message || 'Command failed',
      exitCode: error.code || 1,
    };
  }
}

// Launch the host browser via CDP if AGENT_BROWSER_USE_HOST is set.
// Returns the CDP WebSocket URL or undefined if not using host browser.
// Throws if host browser mode is enabled but the browser fails to launch.
async function launchHostBrowserIfNeeded(): Promise<string | undefined> {
  if (!process.env.AGENT_BROWSER_USE_HOST) {
    return undefined;
  }

  const hostAppUrl = process.env.HOST_APP_URL;
  if (!hostAppUrl) {
    throw new Error('Host browser mode is enabled but HOST_APP_URL is not configured');
  }

  const agentId = process.env.AGENT_ID;

  const response = await fetch(`${hostAppUrl}/api/browser/launch-host-browser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agentId || 'default' }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to launch host browser: ${body}`);
  }

  const data = await response.json() as { port: number };

  // Resolve host.docker.internal to its IP address. Chrome's CDP server
  // validates the Host header and only accepts "localhost" or IP addresses,
  // rejecting hostnames like "host.docker.internal". Using the resolved IP
  // ensures the Host header passes Chrome's check for both HTTP requests
  // and WebSocket connections from agent-browser.
  const hostDockerInternal = 'host.docker.internal';
  let cdpIp: string;
  try {
    const { address } = await dns.promises.lookup(hostDockerInternal);
    cdpIp = address;
  } catch {
    throw new Error(`Failed to resolve ${hostDockerInternal}`);
  }

  // Chrome's CDP requires connecting to the full debugger WebSocket URL
  // (ws://host:port/devtools/browser/<id>), not just ws://host:port.
  // Query Chrome's /json/version endpoint to discover it.
  const cdpHost = `${cdpIp}:${data.port}`;
  const versionRes = await fetch(`http://${cdpHost}/json/version`);
  if (!versionRes.ok) {
    throw new Error(`Failed to query CDP /json/version: ${versionRes.status}`);
  }
  const versionData = await versionRes.json() as { webSocketDebuggerUrl: string };

  // The URL returned by Chrome uses the IP we connected with, so it's
  // already usable. Replace the host portion just in case Chrome returns
  // localhost or a different address.
  const debuggerUrl = versionData.webSocketDebuggerUrl.replace(
    /^ws:\/\/[^/]+/,
    `ws://${cdpHost}`
  );
  return debuggerUrl;
}

// Tell the host to stop the Chrome process for this agent.
async function stopHostBrowserIfNeeded(): Promise<void> {
  if (!process.env.AGENT_BROWSER_USE_HOST) return;

  const hostAppUrl = process.env.HOST_APP_URL;
  if (!hostAppUrl) return;

  const agentId = process.env.AGENT_ID || 'default';

  try {
    await fetch(`${hostAppUrl}/api/browser/stop-host-browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
  } catch (error) {
    console.error('[Browser] Error stopping host browser:', error);
  }
}

// Broadcast a browser_active event to the owning session's WebSocket subscribers
function broadcastBrowserEvent(active: boolean): void {
  if (!browserState.sessionId) return;
  const sessionId = browserState.sessionId;

  // Broadcast through the session manager's subscriber system
  sessionManager.broadcast(sessionId, {
    type: 'browser_active',
    active,
    timestamp: new Date().toISOString(),
  });
}

// Validate that the requesting session owns the browser (or browser is not active)
function validateBrowserSession(requestSessionId: string): string | null {
  if (browserState.active && browserState.sessionId !== requestSessionId) {
    return `Browser is owned by session ${browserState.sessionId}`;
  }
  return null;
}

// GET /browser/status - Check if browser is running
app.get('/browser/status', (c) => {
  return c.json(browserState);
});

// POST /browser/open - Start browser and navigate to URL
app.post('/browser/open', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; url: string }>();

    if (!body.sessionId || !body.url) {
      return c.json({ error: 'sessionId and url are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    const cdpUrl = await launchHostBrowserIfNeeded();
    const profile = process.env.AGENT_BROWSER_PROFILE || '/workspace/.browser-profile';
    const result = await execBrowser(['open', body.url, '--profile', profile], cdpUrl);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    browserState = { active: true, sessionId: body.sessionId, cdpUrl: cdpUrl || null };
    broadcastBrowserEvent(true);

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error opening browser:', error);
    return c.json({ error: error.message || 'Failed to open browser' }, 500);
  }
});

// POST /browser/close - Stop browser
app.post('/browser/close', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    const result = await execBrowser(['close'], browserState.cdpUrl || undefined);

    // If using host browser, tell the host to kill the Chrome process
    await stopHostBrowserIfNeeded();

    broadcastBrowserEvent(false);
    browserState = { active: false, sessionId: null, cdpUrl: null };

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error closing browser:', error);
    return c.json({ error: error.message || 'Failed to close browser' }, 500);
  }
});

// POST /browser/notify-closed - Host browser was closed externally, clean up state
app.post('/browser/notify-closed', (c) => {
  if (browserState.active) {
    broadcastBrowserEvent(false);
    browserState = { active: false, sessionId: null, cdpUrl: null };
    console.log('[Browser] Browser closed externally, state cleaned up');
  }
  return c.json({ success: true });
});

// POST /browser/snapshot - Get accessibility tree snapshot
app.post('/browser/snapshot', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; interactive?: boolean; compact?: boolean }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const snapshotArgs = ['snapshot', '--json'];
    if (body.interactive !== false) snapshotArgs.push('-i');
    if (body.compact !== false) snapshotArgs.push('-c');

    const result = await execBrowser(snapshotArgs, browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    // Try to parse JSON output
    try {
      const parsed = JSON.parse(result.stdout);
      return c.json(parsed);
    } catch {
      // Return raw output if not valid JSON
      return c.json({ snapshot: result.stdout });
    }
  } catch (error: any) {
    console.error('[Browser] Error taking snapshot:', error);
    return c.json({ error: error.message || 'Failed to take snapshot' }, 500);
  }
});

// POST /browser/click - Click element by ref
app.post('/browser/click', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string }>();

    if (!body.sessionId || !body.ref) {
      return c.json({ error: 'sessionId and ref are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const result = await execBrowser(['click', body.ref], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error clicking:', error);
    return c.json({ error: error.message || 'Failed to click' }, 500);
  }
});

// POST /browser/fill - Fill input by ref
app.post('/browser/fill', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string; value: string }>();

    if (!body.sessionId || !body.ref || body.value === undefined) {
      return c.json({ error: 'sessionId, ref, and value are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const result = await execBrowser(['fill', body.ref, body.value], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error filling:', error);
    return c.json({ error: error.message || 'Failed to fill' }, 500);
  }
});

// POST /browser/scroll - Scroll page
app.post('/browser/scroll', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; direction: string; amount?: number }>();

    if (!body.sessionId || !body.direction) {
      return c.json({ error: 'sessionId and direction are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const scrollArgs = ['scroll', body.direction];
    if (body.amount !== undefined) scrollArgs.push(String(body.amount));

    const result = await execBrowser(scrollArgs, browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error scrolling:', error);
    return c.json({ error: error.message || 'Failed to scroll' }, 500);
  }
});

// POST /browser/wait - Wait for condition
app.post('/browser/wait', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; for: string }>();

    if (!body.sessionId || !body.for) {
      return c.json({ error: 'sessionId and for are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const result = await execBrowser(['wait', body.for], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error waiting:', error);
    return c.json({ error: error.message || 'Failed to wait' }, 500);
  }
});

// POST /browser/press - Press a keyboard key
app.post('/browser/press', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; key: string }>();

    if (!body.sessionId || !body.key) {
      return c.json({ error: 'sessionId and key are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const result = await execBrowser(['press', body.key], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error pressing key:', error);
    return c.json({ error: error.message || 'Failed to press key' }, 500);
  }
});

// POST /browser/screenshot - Take screenshot
app.post('/browser/screenshot', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; full?: boolean }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const screenshotArgs = ['screenshot'];
    if (body.full) screenshotArgs.push('--full');

    const result = await execBrowser(screenshotArgs, browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true, output: result.stdout });
  } catch (error: any) {
    console.error('[Browser] Error taking screenshot:', error);
    return c.json({ error: error.message || 'Failed to take screenshot' }, 500);
  }
});

// POST /browser/select - Select dropdown option by ref
app.post('/browser/select', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string; value: string }>();

    if (!body.sessionId || !body.ref || body.value === undefined) {
      return c.json({ error: 'sessionId, ref, and value are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const result = await execBrowser(['select', body.ref, body.value], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error selecting:', error);
    return c.json({ error: error.message || 'Failed to select' }, 500);
  }
});

// POST /browser/hover - Hover element by ref
app.post('/browser/hover', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string }>();

    if (!body.sessionId || !body.ref) {
      return c.json({ error: 'sessionId and ref are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const result = await execBrowser(['hover', body.ref], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error hovering:', error);
    return c.json({ error: error.message || 'Failed to hover' }, 500);
  }
});

// POST /browser/run - Generic catch-all for any agent-browser command
app.post('/browser/run', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; command: string }>();

    if (!body.sessionId || !body.command) {
      return c.json({ error: 'sessionId and command are required' }, 400);
    }

    const validationError = validateBrowserSession(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const commandArgs = splitCommandArgs(body.command);
    if (commandArgs.length === 0) {
      return c.json({ error: 'Empty command' }, 400);
    }

    const result = await execBrowser(commandArgs, browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    return c.json({ success: true, output: result.stdout });
  } catch (error: any) {
    console.error('[Browser] Error running command:', error);
    return c.json({ error: error.message || 'Failed to run browser command' }, 500);
  }
});

async function buildFileTree(
  dirPath: string,
  maxDepth: number,
  currentDepth: number
): Promise<any> {
  if (currentDepth >= maxDepth) {
    return null;
  }

  try {
    const stats = await fs.promises.stat(dirPath);
    const name = path.basename(dirPath);
    const relativePath = path.relative('/workspace', dirPath);

    if (!stats.isDirectory()) {
      return {
        name,
        path: relativePath,
        type: 'file',
        size: stats.size,
      };
    }

    const files = await fs.promises.readdir(dirPath);
    const children = await Promise.all(
      files.map((file) =>
        buildFileTree(path.join(dirPath, file), maxDepth, currentDepth + 1)
      )
    );

    return {
      name: name || 'workspace',
      path: relativePath,
      type: 'directory',
      children: children.filter((child) => child !== null),
    };
  } catch (error) {
    return null;
  }
}

// Start the server
const port = parseInt(process.env.PORT || '3000');
const server = serve({
  fetch: app.fetch,
  port,
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Create a separate WebSocket server for browser stream proxying
const browserWss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade
server.on('upgrade', (request: http.IncomingMessage, socket: any, head: Buffer) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const pathname = url.pathname;

  // Check if this is a session stream endpoint
  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)\/stream$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      handleWebSocketConnection(ws, sessionId);
    });
    return;
  }

  // Check if this is a browser stream endpoint
  if (pathname === '/browser/stream') {
    if (!browserState.active) {
      socket.destroy();
      return;
    }

    browserWss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      handleBrowserStreamConnection(ws);
    });
    return;
  }

  socket.destroy();
});

async function handleWebSocketConnection(ws: WebSocket, sessionId: string) {
  console.log(`WebSocket connection established for session ${sessionId}`);

  const session = await sessionManager.getSession(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close();
    return;
  }

  // Subscribe to session events (SDK messages)
  const unsubscribe = sessionManager.subscribe(sessionId, (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });

  // Handle incoming messages
  ws.on('message', async (data: Buffer) => {
    try {
      const payload = JSON.parse(data.toString());
      const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content);

      await sessionManager.sendMessage(sessionId, content);
    } catch (error: any) {
      console.error('Error handling WebSocket message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message || 'Failed to process message',
      }));
    }
  });

  // Handle connection close
  ws.on('close', () => {
    console.log(`WebSocket connection closed for session ${sessionId}`);
    unsubscribe();
  });

  // Handle errors
  ws.on('error', (error: Error) => {
    console.error(`WebSocket error for session ${sessionId}:`, error);
    unsubscribe();
  });

  // Send initial connection success message
  ws.send(JSON.stringify({
    type: 'status',
    data: { message: 'Connected to session stream' },
    timestamp: new Date(),
  }));
}

// Handle browser stream WebSocket proxy (bidirectional pipe to agent-browser stream server)
function handleBrowserStreamConnection(ws: WebSocket) {
  const streamPort = process.env.AGENT_BROWSER_STREAM_PORT || '9223';
  console.log(`[Browser] Proxying stream connection to ws://localhost:${streamPort}`);

  const upstream = new WebSocket(`ws://localhost:${streamPort}`);

  upstream.on('open', () => {
    console.log('[Browser] Upstream stream connection established');
  });

  // Forward frames from agent-browser to the client
  // Preserve text/binary framing so JSON text frames aren't converted to binary
  upstream.on('message', (data, isBinary) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data, { binary: isBinary });
    }
  });

  // Forward input events from client to agent-browser
  ws.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  upstream.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  ws.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });

  upstream.on('error', (error) => {
    console.error('[Browser] Upstream stream error:', error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  ws.on('error', (error) => {
    console.error('[Browser] Client stream error:', error);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });
}

// Start dashboard processes asynchronously (don't block server startup)
dashboardManager.scanAndStartAll().catch((error) => {
  console.error('[DashboardManager] Failed to scan and start dashboards:', error);
});

console.log(`Server running on http://localhost:${port}`);
console.log('Available endpoints:');
console.log('  POST   /sessions');
console.log('  GET    /sessions/:id');
console.log('  GET    /sessions');
console.log('  DELETE /sessions/:id');
console.log('  POST   /sessions/:id/interrupt');
console.log('  GET    /sessions/:id/messages');
console.log('  POST   /sessions/:id/messages');
console.log('  WS     /sessions/:id/stream');
console.log('  GET    /files/*');
console.log('  GET    /files/*/content');
console.log('  POST   /files/*/upload');
console.log('  DELETE /files/*');
console.log('  POST   /files/*/mkdir');
console.log('  GET    /files/tree');
console.log('  POST   /inputs/:toolUseId/resolve');
console.log('  POST   /inputs/:toolUseId/reject');
console.log('  GET    /inputs/pending');
console.log('  POST   /env');
console.log('  GET    /artifacts');
console.log('  POST   /artifacts/:slug/create');
console.log('  POST   /artifacts/:slug/start');
console.log('  GET    /artifacts/:slug/logs');
console.log('  ALL    /artifacts/:slug/*');
console.log('  GET    /browser/status');
console.log('  POST   /browser/open');
console.log('  POST   /browser/close');
console.log('  POST   /browser/snapshot');
console.log('  POST   /browser/click');
console.log('  POST   /browser/fill');
console.log('  POST   /browser/scroll');
console.log('  POST   /browser/wait');
console.log('  WS     /browser/stream');

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Close browser if active
  if (browserState.active) {
    try {
      await execBrowser(['close'], browserState.cdpUrl || undefined);
      await stopHostBrowserIfNeeded();
      browserState = { active: false, sessionId: null, cdpUrl: null };
    } catch (error) {
      console.error('Error closing browser:', error);
    }
  }

  // Stop all dashboard processes
  try {
    await dashboardManager.stopAll();
  } catch (error) {
    console.error('Error stopping dashboards:', error);
  }

  // Stop all sessions (stops Claude Code processes)
  try {
    await sessionManager.stopAll();
  } catch (error) {
    console.error('Error stopping sessions:', error);
  }

  // Close WebSocket servers
  browserWss.close(() => {
    console.log('Browser WebSocket server closed.');
  });
  wss.close(() => {
    console.log('WebSocket server closed.');
  });

  // Close HTTP server
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

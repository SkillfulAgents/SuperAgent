import { Hono } from 'hono';
import { serve } from '@hono/node-server';
// Captures SUPERAGENT_HOST_TOKEN and strips it from process.env — import early
// so no later module can snapshot an environment that still contains it.
import { HOST_TOKEN_HEADER, hostAuthEnabled, isValidHostToken } from './host-auth';
import { SessionManager } from './session-manager';
import { CreateSessionRequest, SendMessageRequest } from './types';
import { agentCapabilityPoliciesSchema, speedLevelSchema } from './capability-policies';
import type { UUID } from 'crypto';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';

import { inputManager } from './input-manager';
import { resolveCdpIp } from './cdp-host';
import { startScreenshotJanitor } from './screenshot-janitor';
import { dashboardManager } from './dashboard-manager';
import { tabManager } from './tab-manager';
import { startTabPolling, stopTabPolling } from './tab-poll';
import { runBrowserUpload } from './browser-upload';
import { runBrowserDownload } from './browser-download';
import { updateEnvFileEntry, healEnvFilePermissions } from './env-file-store';
import { isAgentIdentityEnvKey } from './attribution-headers';

import { getEditingCommands } from './cdp-editing-commands';

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
const WORKSPACE_DOWNLOADS_DIR = '/workspace/downloads';

// The agent's own Bash can reach this API (shared network namespace), so every
// endpoint that could loosen policy or self-approve an input must prove the
// caller is the host. /health stays open for the Docker HEALTHCHECK.
app.use('*', async (c, next) => {
  if (!hostAuthEnabled() || c.req.path === '/health') return next();
  if (!isValidHostToken(c.req.header(HOST_TOKEN_HEADER))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

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

    if (body.maxBrowserTabs) {
      tabManager.setMaxTabs(body.maxBrowserTabs);
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

// Persisted "Allow for this session" review grants. The host consults this when
// its in-memory grant mirror is cold (fresh host process against a live
// container) before broadcasting a review card the container isn't waiting on.
app.get('/sessions/:id/capability-grants', (c) => {
  const grants = sessionManager.getSessionCapabilityGrants(c.req.param('id'));
  if (grants === null) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return c.json({ grants });
});

app.get('/sessions', (c) => {
  const sessions = sessionManager.getAllSessions();
  return c.json(sessions);
});

app.delete('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const deleted = await sessionManager.deleteSession(sessionId);

  // The host never answers a deleted session's input requests — reject them
  // so awaiting tool handlers unblock and the entries don't live forever.
  // Unconditional: a not-found session may still own entries from a racing
  // or repeated delete.
  inputManager.rejectForSession(sessionId);

  if (!deleted) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ success: true });
});

app.post('/sessions/:id/interrupt', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const { found, discardedUuids } = await sessionManager.interruptSession(sessionId);

    if (!found) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // The same uuids also flow to the host as synthetic command_lifecycle
    // 'discarded' stream frames; this response is for the API caller.
    return c.json({ success: true, discardedUuids });
  } catch (error: any) {
    console.error('Error interrupting session:', error);
    return c.json({ error: error.message || 'Failed to interrupt session' }, 500);
  }
});

// Message endpoints
app.post('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    const body = await c.req.json<SendMessageRequest>();
    const content = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);

    await sessionManager.sendMessage(sessionId, content, body.uuid, {
      effort: body.effort,
      speed: speedLevelSchema.parse(body.speed),
      model: body.model,
      shouldQuery: body.shouldQuery,
      capabilityPolicies: agentCapabilityPoliciesSchema.parse(body.capabilityPolicies),
    });

    return c.json({ success: true }, 201);
  } catch (error: any) {
    console.error('Error sending message:', error);
    return c.json({ error: error.message || 'Failed to send message' }, 500);
  }
});

// Cancel a queued (not yet picked up) message by the uuid it was sent with.
// `cancelled: false` means it was already dequeued for execution (or the
// session isn't live) — never an error; the caller treats it as "too late".
app.delete('/sessions/:id/queued-messages/:uuid', async (c) => {
  const sessionId = c.req.param('id');
  const uuid = c.req.param('uuid');

  try {
    const cancelled = await sessionManager.cancelQueuedMessage(sessionId, uuid as UUID);
    return c.json({ cancelled });
  } catch (error: any) {
    console.error('Error cancelling queued message:', error);
    return c.json({ error: error.message || 'Failed to cancel queued message' }, 500);
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
    const body = await c.req.json<{ value: string | string[] | Record<string, string> }>();

    if (body.value === undefined || body.value === null) {
      return c.json({ error: 'value is required' }, 400);
    }

    inputManager.resolve(toolUseId, body.value);
    return c.json({ success: true });
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
    // The host app also writes this file (user secrets). updateEnvFileEntry
    // serializes via the shared on-disk lock, reads fail-closed (an unreadable
    // file THROWS instead of being treated as empty — merging into "empty" and
    // writing back once wiped every secret), merges line-preservingly (the
    // host's header and display-name comments survive), and writes atomically.
    await updateEnvFileEntry(envFilePath, key, value);
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

    // The boot-time agent identity must stay immutable — header composition
    // reads a boot snapshot anyway, but reject the write outright so the env
    // never lies about which agent this container is.
    if (isAgentIdentityEnvKey(body.key)) {
      console.error(`[ENV] Rejected write to reserved identity env var: ${body.key}`);
      return c.json({ error: `${body.key} is reserved and cannot be modified` }, 403);
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

// DELETE /artifacts/:slug - Stop dashboard process and clean up
app.delete('/artifacts/:slug', async (c) => {
  try {
    const slug = c.req.param('slug');
    await dashboardManager.stopDashboard(slug);
    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Artifacts] Error deleting dashboard:', error);
    return c.json({ error: error.message || 'Failed to delete dashboard' }, 500);
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

import {
  type BrowserState,
  getBrowserState as _getBrowserState,
  setBrowserState as _setBrowserState,
  validateBrowserSession,
  releaseBrowserLock,
  transferBrowserLock,
} from './browser-state';

// Proxy object so existing code can read `browserState.active` etc. without changes.
// Writes must go through _setBrowserState() to keep the canonical module state in sync.
const browserState: BrowserState = new Proxy({} as BrowserState, {
  get(_target, prop) {
    return (_getBrowserState() as any)[prop];
  },
});

/**
 * validateBrowserSession with stale-owner recovery.
 *
 * A lock can be left keyed to a session id that no longer maps to any live
 * session: the canonical Claude id changes on query restart, and crashed
 * sessions never call release. Locking everyone out until container restart
 * produced 100+ consecutive "Browser is owned by session …" failures in the
 * browser-tools audit. If the recorded owner is not an active session,
 * transfer the lock to the requester instead of rejecting.
 */
function validateBrowserSessionWithRecovery(requestSessionId: string): string | null {
  const error = validateBrowserSession(requestSessionId);
  if (!error) return null;
  const ownerId = _getBrowserState().sessionId;
  if (ownerId && !sessionManager.hasActiveSession(ownerId)) {
    transferBrowserLock(requestSessionId);
    console.log(`[Browser] Lock owner ${ownerId} is no longer an active session — transferred browser to ${requestSessionId}`);
    return null;
  }
  return `${error}, which is still active. The browser is in use by another session — do not retry; report the conflict and stop.`;
}


const execFileAsync = promisify(execFile);

import { resolveRunCommandArgs } from './browser-command-args';
import { validatePressKey } from './press-key';
import { prepareEvalScript, finalizeEvalOutput, evalErrorHint } from './eval-script';
import { judgeSelectCommit, SELECT_COMMIT_SETTLE_MS } from './select-verify';
import { resolveCommittedValue } from './field-value-readback';
import { capBrowserOutput, redactCdpUrls, MAX_BROWSER_OUTPUT_CHARS, MAX_BROWSER_ERROR_CHARS } from './browser-output';
import { capSnapshot, formatIframePlaceholders, parseIframeInfo, IFRAME_ENUM_SCRIPT } from './snapshot-format';
import {
  observeUrl, resetUrlTracking,
  CLICK_SETTLE_MS, FILL_SETTLE_MS, PRESS_ENTER_SETTLE_MS, PRESS_SETTLE_MS,
  type UrlDigest, type ScrollInfo, parseScrollInfo,
} from './browser-digest';

// Ensure Chrome download preferences are set in the browser profile directory.
// Merges with existing preferences to avoid overwriting other settings.
async function ensureBrowserDownloadPreferences(profileDir: string, downloadDir: string): Promise<void> {
  const prefsDir = path.join(profileDir, 'Default');
  const prefsPath = path.join(prefsDir, 'Preferences');

  await fs.promises.mkdir(prefsDir, { recursive: true });
  await fs.promises.mkdir(downloadDir, { recursive: true });

  let prefs: Record<string, any> = {};
  try {
    const existing = await fs.promises.readFile(prefsPath, 'utf-8');
    prefs = JSON.parse(existing);
  } catch {
    // No existing preferences file
  }

  prefs.download = {
    ...prefs.download,
    default_directory: downloadDir,
    prompt_for_download: false,
  };

  await fs.promises.writeFile(prefsPath, JSON.stringify(prefs, null, 2));
}

import { readChromeDebugPort } from './chrome-debug-port';

// Clean up any stale agent-browser daemon process and socket file.
// Prevents "Daemon failed to start" errors when a previous daemon is left
// running (e.g. browser closed externally, conversation ended without closing,
// or previous execBrowser timed out).
function cleanupAgentBrowserDaemon(): void {
  const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR
    || (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser') : null)
    || path.join(process.env.HOME || '/home/claude', '.agent-browser');
  const session = process.env.AGENT_BROWSER_SESSION || 'default';
  const socketPath = path.join(socketDir, `${session}.sock`);
  try { fs.unlinkSync(socketPath); } catch { /* ignore missing */ }
  try { execSync('pkill -f "agent-browser" 2>/dev/null || true', { timeout: 3000 }); } catch { /* ignore */ }
  // Also kill Chrome processes spawned by the daemon — otherwise they survive
  // and hold the profile SingletonLock, causing "File exists" on retry.
  try { execSync('pkill -f "chrome.*--headless" 2>/dev/null || true', { timeout: 3000 }); } catch { /* ignore */ }
  // Remove stale SingletonLock from the profile directory
  const profile = process.env.AGENT_BROWSER_PROFILE || '/workspace/.browser-profile';
  try { fs.unlinkSync(path.join(profile, 'SingletonLock')); } catch { /* ignore */ }
}

// Execute an agent-browser CLI command and return the result.
// Uses execFile (no shell) to prevent command injection.
async function execBrowser(args: string[], cdpUrl?: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const fullArgs = cdpUrl ? ['--cdp', cdpUrl, ...args] : args;
    const { stdout } = await execFileAsync('agent-browser', fullArgs, {
      timeout: 30000,
      // Large-but-legitimate outputs must not THROW (the throw path used to
      // stuff up to 1 MiB of partial output into an error string);
      // capBrowserOutput below bounds what the model actually sees.
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        AGENT_BROWSER_STREAM_PORT: process.env.AGENT_BROWSER_STREAM_PORT || '9223',
        AGENT_BROWSER_ARGS: process.env.AGENT_BROWSER_ARGS || '--no-sandbox,--disable-blink-features=AutomationControlled',
      },
    });
    return { stdout: capBrowserOutput(stdout.trim(), MAX_BROWSER_OUTPUT_CHARS), exitCode: 0 };
  } catch (error: any) {
    // Full, unsanitized detail (incl. the command line with the CDP URL) goes
    // to container logs for connectivity debugging — never to the model.
    console.error('[Browser] agent-browser failed:', error.message);
    if (error.stderr) {
      console.error('[Browser] agent-browser stderr:', error.stderr);
    }
    const parts = [
      error.stdout?.trim(),
      error.stderr?.trim(),
    ].filter(Boolean);
    const rawDetail = parts.length > 0 ? parts.join('\n') : (error.message || 'Command failed');
    return {
      stdout: redactCdpUrls(capBrowserOutput(rawDetail, MAX_BROWSER_ERROR_CHARS)),
      exitCode: typeof error.code === 'number' ? error.code : 1,
    };
  }
}

/** Read the current URL after an action and build the navigation digest. */
async function observeUrlDigest(): Promise<UrlDigest | null> {
  const r = await execBrowser(['get', 'url'], browserState.cdpUrl || undefined);
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  return observeUrl(r.stdout.trim());
}

/**
 * Read back the committed value of a field after fill/type.
 *
 * `get value` reads `.value`, which contenteditable widgets (LinkedIn's message
 * box, rich-text editors) do not expose — it returns "" for them even when text
 * is present. The false-empty read-back made agents believe their keystrokes
 * had not landed and re-type, duplicating text. When `get value` is empty we
 * fall back to `get text`, which IS populated for contenteditables.
 */
async function readCommittedFieldValue(ref: string): Promise<string | null> {
  const value = await execBrowser(['get', 'value', ref], browserState.cdpUrl || undefined);
  const valueRead = { ok: value.exitCode === 0, text: value.stdout.trim() };
  if (valueRead.ok && valueRead.text !== '') return valueRead.text;

  // Empty/unreadable `.value`: read text content to catch contenteditables.
  const text = await execBrowser(['get', 'text', ref], browserState.cdpUrl || undefined);
  const textRead = { ok: text.exitCode === 0, text: text.stdout.trim() };
  return resolveCommittedValue(valueRead, textRead);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface HostBrowserInfo {
  cdpUrl: string;
  /** Host-filesystem path where Chrome should save downloads */
  hostDownloadDir: string;
}

// Relay a container-side browser-launch failure to the host for Sentry.
// Only called for failures after the launch request itself succeeded — the
// host is known reachable at that point, but has no other way to learn this
// half of the launch broke (the error otherwise surfaces only in the agent's
// tool result). Fire-and-forget: reporting must never mask the real error.
function reportHostBrowserLaunchError(
  hostAppUrl: string,
  headers: Record<string, string>,
  stage: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  void fetch(`${hostAppUrl}/api/browser/report-launch-error`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: process.env.AGENT_ID || 'default', stage, message }),
  }).catch(() => {});
}

// Launch the host browser via CDP if AGENT_BROWSER_USE_HOST is set.
// Returns the CDP WebSocket URL and host download dir, or undefined if not using host browser.
// Throws if host browser mode is enabled but the browser fails to launch.
async function launchHostBrowserIfNeeded(): Promise<HostBrowserInfo | undefined> {
  if (!process.env.AGENT_BROWSER_USE_HOST) {
    return undefined;
  }

  const hostAppUrl = process.env.HOST_APP_URL;
  if (!hostAppUrl) {
    throw new Error('Host browser mode is enabled but HOST_APP_URL is not configured');
  }

  const agentId = process.env.AGENT_ID;

  const proxyToken = process.env.PROXY_TOKEN;
  const browserAuthHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (proxyToken) browserAuthHeaders['Authorization'] = `Bearer ${proxyToken}`;

  // A network-level failure here means the launch request never reached the
  // host app at all — the host never launches Chrome and never reports to
  // Sentry, so this bare 'fetch failed' used to be the only trace. On Windows
  // it is almost always Windows Firewall blocking the app's API port for
  // container (WSL2) traffic, e.g. after the first-run firewall prompt was
  // dismissed. Surface that diagnosis instead.
  let response: Response;
  try {
    response = await fetch(`${hostAppUrl}/api/browser/launch-host-browser`, {
      method: 'POST',
      headers: browserAuthHeaders,
      body: JSON.stringify({ agentId: agentId || 'default' }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach the host app at ${hostAppUrl} to launch the browser (${cause}). ` +
      `Connections from the agent container to the host machine appear to be blocked — on Windows this is usually ` +
      `Windows Defender Firewall blocking the app (open "Allow an app through Windows Firewall" and enable it for both Private and Public networks), ` +
      `or third-party antivirus. Ask the user to allow the app through their firewall, then try again.`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to launch host browser: ${body}`);
  }

  const data = await response.json() as { port?: number; cdpUrl?: string; downloadDir?: string };

  // Remote providers (e.g. Browserbase) return a CDP URL directly
  if (data.cdpUrl) {
    return { cdpUrl: data.cdpUrl, hostDownloadDir: data.downloadDir || '' };
  }

  // Local providers (e.g. Chrome) return a port — resolve to CDP URL
  if (!data.port) {
    throw new Error('Host browser response missing both cdpUrl and port');
  }

  // Derive the CDP host from HOST_APP_URL - the same address the
  // launch-host-browser request above already reached the host at. Chrome's CDP
  // server validates the Host header and rejects hostnames, so resolveCdpIp
  // returns an IP. Apple containers can't resolve host.docker.internal (no
  // --add-host equivalent), so there HOST_APP_URL is the host gateway IP and no
  // DNS is needed; Docker/Lima/WSL2 keep host.docker.internal, which their
  // runtime maps.
  let cdpIp: string;
  try {
    cdpIp = await resolveCdpIp(hostAppUrl);
  } catch (err) {
    reportHostBrowserLaunchError(hostAppUrl, browserAuthHeaders, 'resolve-cdp-host', err);
    throw err;
  }

  // Chrome's CDP requires connecting to the full debugger WebSocket URL
  // (ws://host:port/devtools/browser/<id>), not just ws://host:port.
  // Query Chrome's /json/version endpoint to discover it.
  const cdpHost = `${cdpIp}:${data.port}`;
  // A network-level failure here (vs. an HTTP error) means the host browser
  // launched but this container can't reach its debugging port — on Windows
  // that is almost always the host firewall dropping container→host traffic.
  // Surface that diagnosis instead of an opaque "fetch failed".
  let versionRes: Response;
  try {
    versionRes = await fetch(`http://${cdpHost}/json/version`);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const error = new Error(
      `The host browser launched, but its debugging endpoint at ${cdpHost} is unreachable from inside the agent container (${cause}). ` +
      `This usually means a firewall on the host machine is blocking container-to-host connections ` +
      `(on Windows: Windows Defender Firewall or antivirus blocking the app on the "vEthernet (WSL)" network). ` +
      `Ask the user to allow the app through their firewall, or to switch Browser Host to the built-in browser in Settings.`
    );
    reportHostBrowserLaunchError(hostAppUrl, browserAuthHeaders, 'cdp-endpoint-unreachable', error);
    throw error;
  }
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
  return { cdpUrl: debuggerUrl, hostDownloadDir: data.downloadDir || '' };
}

// Use CDP to tell Chrome where to save downloads. This must be called AFTER
// agent-browser has connected (via --cdp) so our call is the last to set
// the download behavior, overriding Playwright's internal interception.
async function setDownloadBehaviorViaCDP(cdpUrl: string, downloadPath: string): Promise<void> {
  if (!downloadPath) return;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(cdpUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP setDownloadBehavior timed out'));
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Browser.setDownloadBehavior',
        params: {
          behavior: 'allowAndName',
          downloadPath,
          eventsEnabled: false,
        },
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 1) {
        clearTimeout(timeout);
        ws.close();
        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message}`));
        } else {
          resolve();
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// The CDP download path applied for the current browser (host path in host
// mode, /workspace/downloads locally). Playwright connections made mid-session
// (browser_upload/browser_download) can clobber Browser.setDownloadBehavior,
// so we remember what we applied and re-apply it after those calls.
let appliedCdpDownloadPath: string | null = null;

async function reapplyDownloadBehavior(): Promise<void> {
  if (!browserState.cdpUrl || !appliedCdpDownloadPath) return;
  try {
    await setDownloadBehaviorViaCDP(browserState.cdpUrl, appliedCdpDownloadPath);
  } catch (err) {
    console.error('[Browser] Failed to re-apply download behavior via CDP:', err);
  }
}

// Tell the host to stop the Chrome process for this agent.
async function stopHostBrowserIfNeeded(): Promise<void> {
  if (!process.env.AGENT_BROWSER_USE_HOST) return;

  const hostAppUrl = process.env.HOST_APP_URL;
  if (!hostAppUrl) return;

  const agentId = process.env.AGENT_ID || 'default';

  try {
    const proxyToken = process.env.PROXY_TOKEN;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (proxyToken) headers['Authorization'] = `Bearer ${proxyToken}`;

    await fetch(`${hostAppUrl}/api/browser/stop-host-browser`, {
      method: 'POST',
      headers,
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

// validateBrowserSession is imported from ./browser-state

// GET /browser/status - Check if browser is running
app.get('/browser/status', (c) => {
  return c.json(_getBrowserState());
});


// POST /browser/open - Start browser and navigate to URL
app.post('/browser/open', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; url: string }>();

    if (!body.sessionId || !body.url) {
      return c.json({ error: 'sessionId and url are required' }, 400);
    }

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    // If browser is already active, check for a matching tab before opening a new one
    if (browserState.active) {
      const matchingTab = await tabManager.findMatchingTab(body.url);
      if (matchingTab) {
        await execBrowser(['tab', matchingTab.tabId], browserState.cdpUrl || undefined);
        await tabManager.syncTabCount();
        observeUrl(matchingTab.url); // seed URL baseline for post-action digests
        notifyBrowserAction();
        return c.json({ success: true, switchedToExisting: true, tabId: matchingTab.tabId, url: matchingTab.url });
      }
    }

    const hostBrowser = await launchHostBrowserIfNeeded();
    const cdpUrl = hostBrowser?.cdpUrl;
    const profile = process.env.AGENT_BROWSER_PROFILE || '/workspace/.browser-profile';

    // Configure Chrome to save downloads to /workspace/downloads so the agent can access them
    await ensureBrowserDownloadPreferences(profile, WORKSPACE_DOWNLOADS_DIR);

    // Clean up any leftover daemon state before starting
    cleanupAgentBrowserDaemon();

    let result = await execBrowser(['open', body.url, '--profile', profile], cdpUrl);

    // Retry once on failure — agent-browser daemon startup can be flaky
    if (result.exitCode !== 0) {
      console.error('[Browser] First open attempt failed, retrying:', result.stdout);
      cleanupAgentBrowserDaemon();
      await new Promise(r => setTimeout(r, 1000));
      result = await execBrowser(['open', body.url, '--profile', profile], cdpUrl);
    }

    if (result.exitCode !== 0) {
      const debugInfo = cdpUrl ? ` [cdp=${cdpUrl}, mode=host, attempts=2]` : ' [mode=local, attempts=2]';
      return c.json({ error: `${result.stdout}${debugInfo}`, success: false }, 500);
    }

    // Override Playwright's download interception via CDP so downloads go to workspace.
    // For host browser: use the host-filesystem path (volume-mounted as /workspace).
    // For container browser: use /workspace/downloads directly.
    const downloadPath = hostBrowser?.hostDownloadDir || WORKSPACE_DOWNLOADS_DIR;
    appliedCdpDownloadPath = null;
    if (cdpUrl) {
      try {
        await setDownloadBehaviorViaCDP(cdpUrl, downloadPath);
        appliedCdpDownloadPath = downloadPath;
      } catch (err) {
        console.error('[Browser] Failed to set download behavior via CDP:', err);
      }
    }

    _setBrowserState({ active: true, sessionId: body.sessionId, cdpUrl: cdpUrl || null });
    tabManager.resetTabCount();
    resetUrlTracking();
    // Seed the URL baseline so the FIRST post-action digest can distinguish
    // "navigated" from "unchanged" (validation found a click that navigated
    // away from the opened page being reported as "URL unchanged").
    const landed = await execBrowser(['get', 'url'], cdpUrl);
    if (landed.exitCode === 0 && landed.stdout.trim()) {
      observeUrl(landed.stdout.trim());
    }
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

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    await execBrowser(['close'], browserState.cdpUrl || undefined);
    cleanupAgentBrowserDaemon();

    // If using host browser, tell the host to kill the Chrome process
    await stopHostBrowserIfNeeded();

    cleanupCdpScreencast();
    broadcastBrowserEvent(false);
    _setBrowserState({ active: false, sessionId: null, cdpUrl: null });
    tabManager.resetTabCount();

    // A browser_input request is only answerable while the browser exists —
    // and it may belong to a session OTHER than the closer (e.g. a background
    // subagent parked on a login while the main agent closes the browser).
    // Reject them all so blocked awaiters unblock instead of hanging for the
    // 24h human-input TTL behind a card the user can no longer act on.
    inputManager.rejectByType(
      'browser_input',
      'The browser was closed before the user completed this request'
    );

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error closing browser:', error);
    return c.json({ error: error.message || 'Failed to close browser' }, 500);
  }
});

// POST /browser/release - Release browser lock without closing the browser.
// Used by automated sessions (cron/webhook) on exit so the next session can acquire
// the browser without destroying the Chrome process or cookies.
app.post('/browser/release', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const released = releaseBrowserLock(body.sessionId);
    if (released) {
      broadcastBrowserEvent(false);
      console.log(`[Browser] Lock released by session ${body.sessionId} (browser still running)`);
    }
    return c.json({ success: true, released });
  } catch (error: any) {
    console.error('[Browser] Error releasing browser lock:', error);
    return c.json({ error: error.message || 'Failed to release browser lock' }, 500);
  }
});

// POST /browser/notify-closed - Host browser was closed externally, clean up state
app.post('/browser/notify-closed', (c) => {
  if (browserState.active) {
    cleanupAgentBrowserDaemon();
    cleanupCdpScreencast();
    broadcastBrowserEvent(false);
    _setBrowserState({ active: false, sessionId: null, cdpUrl: null });
    tabManager.resetTabCount();
    console.log('[Browser] Browser closed externally, state cleaned up');
  }
  // Outside the guard: an external close can race the active flag, and a
  // pending browser_input is unanswerable once the browser is gone either way.
  inputManager.rejectByType(
    'browser_input',
    'The browser was closed before the user completed this request'
  );
  return c.json({ success: true });
});

// POST /browser/snapshot - Get accessibility tree snapshot
app.post('/browser/snapshot', async (c) => {
  try {
    const body = await c.req.json<{
      sessionId: string;
      interactive?: boolean;
      compact?: boolean;
      json?: boolean;
      scope?: string;
      fullText?: boolean;
      includeUrls?: boolean;
    }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const snapshotArgs = ['snapshot'];
    if (body.json) snapshotArgs.push('--json');
    // fullText drops BOTH -i and -c: each independently strips static text
    // (validation errors, prices, instructions) — audit P5.
    if (!body.fullText) {
      if (body.interactive !== false) snapshotArgs.push('-i');
      if (body.compact !== false) snapshotArgs.push('-c');
    }
    if (body.scope) snapshotArgs.push('-s', body.scope);
    if (body.includeUrls) snapshotArgs.push('--urls');

    const result = await execBrowser(snapshotArgs, browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    // Enumerate cross-origin iframes so the agent knows about fields the a11y
    // tree cannot see (e.g. Stripe payment frames — audit P2).
    const iframeProbe = await execBrowser(['eval', IFRAME_ENUM_SCRIPT], browserState.cdpUrl || undefined);
    const iframes = iframeProbe.exitCode === 0 ? parseIframeInfo(iframeProbe.stdout) : [];

    if (body.json) {
      // Try to parse JSON output
      try {
        const parsed = JSON.parse(result.stdout);
        return c.json({ ...parsed, iframes, tabCount: tabManager.getTabCount() });
      } catch {
        return c.json({ snapshot: result.stdout, iframes, tabCount: tabManager.getTabCount() });
      }
    }

    return c.json({
      snapshot: capSnapshot(result.stdout, Boolean(body.scope)) + formatIframePlaceholders(iframes),
      iframes,
      tabCount: tabManager.getTabCount(),
    });
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

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
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

    await sleep(CLICK_SETTLE_MS);
    const digest = await observeUrlDigest();

    const tabInfo = await tabManager.detectNewTab();
    notifyBrowserAction();
    return c.json({ success: true, ...(digest && { digest }), ...(tabInfo && { tabInfo }) });
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

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
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

    // Read the value back after a settle: the CLI reports success regardless
    // of what the page kept (maxlength truncation, JS reformatting,
    // keystroke-only widgets — audit F6).
    await sleep(FILL_SETTLE_MS);
    const committedValue = await readCommittedFieldValue(body.ref);

    notifyBrowserAction();
    return c.json({ success: true, ...(committedValue !== null && { committedValue }) });
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

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
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

    const probe = await execBrowser(
      ['eval', 'JSON.stringify({y:window.scrollY,vh:window.innerHeight,h:document.documentElement.scrollHeight})'],
      browserState.cdpUrl || undefined
    );
    const scrollInfo: ScrollInfo | null = probe.exitCode === 0 ? parseScrollInfo(probe.stdout) : null;

    notifyBrowserAction();
    return c.json({ success: true, ...(scrollInfo && { scrollInfo }) });
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

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const loadStates = ['networkidle', 'load', 'domcontentloaded'];
    const isLoadState = loadStates.includes(body.for);
    const waitArgs = isLoadState
      ? ['wait', '--load', body.for]
      : ['wait', body.for];
    const result = await execBrowser(waitArgs, browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      // Load state waits (especially networkidle) often time out on real-world pages
      // with continuous ad/analytics traffic. Since browser_open already waits for the
      // 'load' event, the page is usable — treat load state timeouts as success.
      if (isLoadState) {
        return c.json({ success: true });
      }
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

    // agent-browser forwards any string to CDP and reports success even for
    // non-keys (typing nothing) — reject up front with typing guidance.
    const keyError = validatePressKey(body.key);
    if (keyError) {
      return c.json({ error: keyError, success: false }, 400);
    }

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
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

    await sleep(body.key.trim() === 'Enter' ? PRESS_ENTER_SETTLE_MS : PRESS_SETTLE_MS);
    const digest = await observeUrlDigest();

    const tabInfo = await tabManager.detectNewTab();
    notifyBrowserAction();
    return c.json({ success: true, ...(digest && { digest }), ...(tabInfo && { tabInfo }) });
  } catch (error: any) {
    console.error('[Browser] Error pressing key:', error);
    return c.json({ error: error.message || 'Failed to press key' }, 500);
  }
});

// POST /browser/screenshot - Take screenshot
app.post('/browser/screenshot', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; full?: boolean; annotate?: boolean }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const screenshotArgs = ['screenshot'];
    if (body.full) screenshotArgs.push('--full');
    if (body.annotate) screenshotArgs.push('--annotate');

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

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    // Read the element's value before and after: the CLI reports "✓ Done"
    // even when nothing commits (custom dropdown divs, React-reverted
    // selects) — the read-back is what makes the result honest.
    const readValue = async (): Promise<string | null> => {
      const r = await execBrowser(['get', 'value', body.ref], browserState.cdpUrl || undefined);
      return r.exitCode === 0 ? r.stdout.trim() : null;
    };

    const before = await readValue();

    const result = await execBrowser(['select', body.ref, body.value], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    await new Promise(resolve => setTimeout(resolve, SELECT_COMMIT_SETTLE_MS));
    const after = await readValue();

    const judgement = judgeSelectCommit(body.value, before, after);
    if (!judgement.ok) {
      return c.json({ error: judgement.reason, success: false }, 500);
    }

    notifyBrowserAction();
    return c.json({ success: true, committedValue: judgement.committed });
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

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
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

    notifyBrowserAction();
    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Browser] Error hovering:', error);
    return c.json({ error: error.message || 'Failed to hover' }, 500);
  }
});

// POST /browser/upload - Upload a local file into an <input type="file">
app.post('/browser/upload', async (c) => {
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    const result = await runBrowserUpload(rawBody, {
      validateSession: validateBrowserSessionWithRecovery,
      isBrowserActive: () => browserState.active,
      getConnectionUrl: () => browserState.cdpUrl || getCdpHttpEndpoint(),
      getActiveTargetUrl: async () => (await findActivePageTarget())?.url ?? null,
      urlsMatch: (left, right) => tabManager.urlsMatch(left, right),
    });

    // Playwright's CDP attach can reset Browser.setDownloadBehavior — re-apply
    // ours so click-triggered downloads keep landing in the workspace.
    await reapplyDownloadBehavior();

    if (!result.success) {
      return c.json(result.body, result.status);
    }

    notifyBrowserAction();
    return c.json(result.body);
  } catch (error: any) {
    console.error('[Browser] Error uploading file:', error);
    return c.json({ error: error.message || 'Failed to upload file' }, 500);
  }
});

// POST /browser/download - Download a URL's bytes through the browser session
// into /workspace/downloads. The bytes travel over the CDP wire, so this works
// even when the browser's own filesystem is unreachable (host Chrome, Browserbase).
app.post('/browser/download', async (c) => {
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    const result = await runBrowserDownload(rawBody, {
      validateSession: validateBrowserSessionWithRecovery,
      isBrowserActive: () => browserState.active,
      getConnectionUrl: () => browserState.cdpUrl || getCdpHttpEndpoint(),
      getActiveTargetUrl: async () => (await findActivePageTarget())?.url ?? null,
      urlsMatch: (left, right) => tabManager.urlsMatch(left, right),
    });

    // Playwright's CDP attach can reset Browser.setDownloadBehavior — re-apply
    // ours so click-triggered downloads keep landing in the workspace.
    await reapplyDownloadBehavior();

    if (!result.success) {
      return c.json(result.body, result.status);
    }

    notifyBrowserAction();
    return c.json(result.body);
  } catch (error: any) {
    console.error('[Browser] Error downloading file:', error);
    return c.json({ error: error.message || 'Failed to download file' }, 500);
  }
});

// POST /browser/type - Type real keystrokes into the focused element (optionally focusing a ref first)
app.post('/browser/type', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; text: string; ref?: string }>();

    if (!body.sessionId || typeof body.text !== 'string' || body.text.length === 0) {
      return c.json({ error: 'sessionId and text are required' }, 400);
    }

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    if (body.ref) {
      const focusResult = await execBrowser(['focus', body.ref], browserState.cdpUrl || undefined);
      if (focusResult.exitCode !== 0) {
        return c.json({ error: focusResult.stdout, success: false }, 500);
      }
    }

    // `keyboard type` dispatches real key events into whatever has focus —
    // this is what drives keystroke-listening widgets (Stripe card fields,
    // OTP boxes, typeaheads) that programmatic fill cannot.
    const result = await execBrowser(['keyboard', 'type', body.text], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    // When we know the target, read the value back (keyboard type APPENDS to
    // existing content). Focused-element typing without a ref has no readable
    // target by definition (e.g. cross-origin payment iframes).
    let committedValue: string | null = null;
    if (body.ref) {
      committedValue = await readCommittedFieldValue(body.ref);
    }

    notifyBrowserAction();
    return c.json({ success: true, ...(committedValue !== null && { committedValue }) });
  } catch (error: any) {
    console.error('[Browser] Error typing:', error);
    return c.json({ error: error.message || 'Failed to type' }, 500);
  }
});

// POST /browser/eval - Run JavaScript in the page (dedicated eval with guardrails)
app.post('/browser/eval', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; script: string }>();

    if (!body.sessionId || typeof body.script !== 'string' || body.script.trim() === '') {
      return c.json({ error: 'sessionId and script are required' }, 400);
    }

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    const { script, wrapped } = prepareEvalScript(body.script);
    const result = await execBrowser(['eval', script], browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: evalErrorHint(result.stdout), success: false }, 500);
    }

    notifyBrowserAction();
    return c.json({ success: true, output: finalizeEvalOutput(result.stdout), wrapped });
  } catch (error: any) {
    console.error('[Browser] Error running eval:', error);
    return c.json({ error: error.message || 'Failed to run eval' }, 500);
  }
});

// POST /browser/run - Generic catch-all for any agent-browser command
app.post('/browser/run', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; command?: string; args?: string[] }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const resolved = resolveRunCommandArgs(body);
    if (resolved.error !== undefined) {
      return c.json({ error: resolved.error }, 400);
    }
    const commandArgs = resolved.args;

    const validationError = validateBrowserSessionWithRecovery(body.sessionId);
    if (validationError) {
      return c.json({ error: validationError }, 409);
    }

    if (!browserState.active) {
      return c.json({ error: 'Browser is not active' }, 400);
    }

    // The agent-browser CLI `upload` command does not work reliably in this
    // environment — refuse it and steer the model to `browser_upload`, which
    // routes through the buffer-based path with size verification.
    if (commandArgs[0] === 'upload') {
      return c.json({
        error: 'Use the `browser_upload(filePath, selector)` MCP tool for file uploads instead of `browser_run("upload …")`.',
        success: false,
      }, 400);
    }

    // Same guard as /browser/press for the raw CLI form: `press` with a
    // non-key string silently types nothing while reporting success.
    if (commandArgs[0] === 'press' && commandArgs.length === 2) {
      const keyError = validatePressKey(commandArgs[1]);
      if (keyError) {
        return c.json({ error: keyError, success: false }, 400);
      }
    }

    const result = await execBrowser(commandArgs, browserState.cdpUrl || undefined);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    const verb = commandArgs[0].toLowerCase();
    const joined = commandArgs.join(' ').toLowerCase();
    let tabInfo = null;
    if (verb.startsWith('tab') || verb === 'click' || verb === 'dblclick' || joined.includes('.click(')) {
      tabInfo = await tabManager.detectNewTab();
    }

    notifyBrowserAction();
    return c.json({ success: true, output: result.stdout, ...(tabInfo && { tabInfo }) });
  } catch (error: any) {
    console.error('[Browser] Error running command:', error);
    return c.json({ error: error.message || 'Failed to run browser command' }, 500);
  }
});

// GET /browser/tab-status - Return cached tab count (instant, no daemon query)
app.get('/browser/tab-status', (c) => {
  return c.json({ tabCount: tabManager.getTabCount() });
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

// Startup self-heal: older builds could leave /workspace/.env 0o600 and
// owner-flipped, locking one writer out permanently. If WE own the poisoned
// file, only we can fix it — do so before any session starts.
void healEnvFilePermissions('/workspace/.env').then((healed) => {
  if (healed) console.log('[ENV] Healed /workspace/.env permissions back to 0666');
});

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
  // Upgrades bypass the Hono middleware chain — enforce host auth here too.
  const presentedToken = request.headers[HOST_TOKEN_HEADER];
  if (!isValidHostToken(Array.isArray(presentedToken) ? presentedToken[0] : presentedToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

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

  // Announce the stream contract before relaying any SDK message (WS is FIFO,
  // and this is sent before the subscription below, so it always precedes the
  // first relayed message). session_state_events: this build runs the CLI with
  // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, so the host can treat
  // session_state_changed:'idle' as the idle authority from the first turn —
  // a 'result' alone must not end the session while queued messages keep the
  // runtime going.
  ws.send(JSON.stringify({
    type: 'system',
    subtype: 'capabilities',
    session_state_events: true,
    timestamp: new Date(),
  }));

  // Subscribe to session events (SDK messages)
  const unsubscribe = sessionManager.subscribe(sessionId, (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });

  // Catch-up for turns that ended before this socket attached. createSession
  // returns at `init`, so an instant turn (e.g. a UserPromptSubmit hook
  // blocking the prompt) emits informational/result/idle into the attach gap
  // and nothing re-delivers them — the host would show the session as working
  // forever. Frames are marked `replayed: true`; the host ignores them when it
  // already processed the live copies. Sent after the subscription so a turn
  // starting mid-replay still delivers its live frames afterwards (WS is FIFO).
  for (const frame of sessionManager.getLateJoinReplay(sessionId)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  // Handle incoming messages
  ws.on('message', async (data: Buffer) => {
    try {
      const payload = JSON.parse(data.toString());
      const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content);

      await sessionManager.sendMessage(sessionId, content, payload.uuid, {
        effort: payload.effort,
        speed: speedLevelSchema.parse(payload.speed),
        model: payload.model,
        capabilityPolicies: agentCapabilityPoliciesSchema.parse(payload.capabilityPolicies),
      });
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

// ============================================================
// CDP-based browser screencast
// Connects directly to Chrome's CDP to stream the active page,
// bypassing agent-browser's StreamServer which doesn't follow
// tab switches. After each browser action, we ask the daemon
// which tab is active and switch the screencast if needed.
// ============================================================

let cdpScreencast: {
  clientWs: WebSocket;
  cdpWs: WebSocket;
  currentTargetId: string;
  msgId: number;
  lastDeviceWidth: number;
  lastDeviceHeight: number;
  /** CDP session ID for flattened session mode (remote providers like Browserbase) */
  cdpSessionId: string | null;
  /** Whether the viewer auto-follows the agent's active tab */
  autoFollow: boolean;
  /** Pending CDP message IDs for get_selection requests */
  pendingSelections: Set<number>;
  /** Main frame ID — used to filter loading events to top-level frame only */
  mainFrameId: string | null;
} | null = null;

/** Derive the CDP HTTP endpoint from the current browser state */
function getCdpHttpEndpoint(): string {
  if (browserState.cdpUrl) {
    const match = browserState.cdpUrl.match(/^wss?:\/\/([^/]+)/);
    if (match) return `http://${match[1]}`;
  }
  // Local browser: read the dynamic port from Chrome's DevToolsActivePort file
  const port = readChromeDebugPort();
  return `http://localhost:${port || 9222}`;
}

/** A discovered CDP page target */
interface PageTarget {
  id: string;
  url: string;
  title: string;
  wsUrl: string;
  /** If true, wsUrl is a browser-level URL; connectCdpToTarget must use Target.attachToTarget */
  requiresSession: boolean;
}

// Protocol: see src/renderer/components/browser/browser-preview.tsx
interface BrowserTabInfo {
  targetId: string;
  index: number;
  url: string;
  title: string;
  active: boolean;
}

/** Get ALL CDP page targets across all strategies */
async function getAllPageTargets(): Promise<PageTarget[]> {
  // Try Chrome's HTTP /json endpoint first (works for local Chrome)
  const endpoint = getCdpHttpEndpoint();
  try {
    const res = await fetch(`${endpoint}/json`);
    const targets = await res.json() as Array<{ id: string; type: string; url: string; title?: string; webSocketDebuggerUrl: string }>;

    const pages = targets.filter(t => t.type === 'page');
    if (pages.length > 0) {
      // Chrome's /json may return webSocketDebuggerUrl with localhost which won't
      // work from inside a Docker container. Rewrite to the host we actually used.
      const cdpHost = endpoint.replace(/^https?:\/\//, '');
      for (const page of pages) {
        page.webSocketDebuggerUrl = page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${cdpHost}`);
      }

      return pages.map(p => ({
        id: p.id,
        url: p.url,
        title: p.title || '',
        wsUrl: p.webSocketDebuggerUrl,
        requiresSession: false,
      }));
    }
  } catch {
    // HTTP /json not available — fall through to WebSocket CDP approach
  }

  // For remote CDP providers (e.g. Browserbase), try the host API debug endpoint first.
  const hostAppUrl = process.env.HOST_APP_URL;
  const agentId = process.env.AGENT_ID;
  if (hostAppUrl && agentId) {
    try {
      const debugHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const proxyToken = process.env.PROXY_TOKEN;
      if (proxyToken) debugHeaders['Authorization'] = `Bearer ${proxyToken}`;

      const debugRes = await fetch(`${hostAppUrl}/api/browser/debug-info`, {
        method: 'POST',
        headers: debugHeaders,
        body: JSON.stringify({ agentId }),
      });
      if (debugRes.ok) {
        const debugInfo = await debugRes.json() as { pages?: Array<{ id: string; url: string; title?: string; wsUrl: string }> };
        const pages = debugInfo.pages || [];
        if (pages.length > 0) {
          return pages.map(p => ({
            id: p.id,
            url: p.url,
            title: p.title || '',
            wsUrl: p.wsUrl,
            requiresSession: false,
          }));
        }
      }
    } catch (err) {
      console.error('[CDP] Debug info request failed:', err);
    }
  }

  // Fallback: try CDP Target.getTargets over WebSocket
  if (!browserState.cdpUrl) return [];
  const target = await findPageTargetViaCdp(browserState.cdpUrl);
  return target ? [target] : [];
}

/** Find the CDP page target that corresponds to agent-browser's active page */
async function findActivePageTarget(): Promise<PageTarget | null> {
  const allTargets = await getAllPageTargets();
  if (allTargets.length === 0) return null;
  if (allTargets.length === 1) return allTargets[0];

  // Use daemon to find which is active
  try {
    const tabs = await tabManager.queryTabs();
    const active = tabs.find(t => t.active);
    if (active) {
      const byUrl = allTargets.find(p => tabManager.urlsMatch(p.url, active.url));
      if (byUrl) return byUrl;
    }
  } catch (err) {
    console.error('[CDP] Daemon tab query failed:', err);
  }

  return allTargets[0]; // fallback: first target (most recently active per Chrome's /json ordering)
}

/** Discover page targets via CDP WebSocket protocol (for remote providers) */
function findPageTargetViaCdp(browserWsUrl: string): Promise<PageTarget | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    const timeout = setTimeout(() => { ws.close(); resolve(null); }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          const pages = (msg.result?.targetInfos || []).filter(
            (t: { type: string }) => t.type === 'page'
          );
          if (pages.length === 0) { resolve(null); return; }
          const target = pages[pages.length - 1];
          resolve({ id: target.targetId, url: target.url || '', title: target.title || '', wsUrl: browserWsUrl, requiresSession: true });
        }
      } catch { /* wait for next message */ }
    });

    ws.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

/** Helper to build a CDP message, adding sessionId when in session mode */
function cdpMsg(state: NonNullable<typeof cdpScreencast>, method: string, params?: Record<string, unknown>): string {
  const msg: Record<string, unknown> = { id: ++state.msgId, method };
  if (params) msg.params = params;
  if (state.cdpSessionId) msg.sessionId = state.cdpSessionId;
  return JSON.stringify(msg);
}

/** Connect CDP screencast to a page target and forward frames to the client */
function connectCdpToTarget(targetId: string, wsUrl: string, clientWs: WebSocket, requiresSession = false) {
  const cdpWs = new WebSocket(wsUrl);
  const prevAutoFollow = cdpScreencast?.autoFollow ?? true;
  cdpScreencast = { clientWs, cdpWs, currentTargetId: targetId, msgId: 0, lastDeviceWidth: 0, lastDeviceHeight: 0, cdpSessionId: null, autoFollow: prevAutoFollow, pendingSelections: new Set(), mainFrameId: null as string | null };
  const state = cdpScreencast;

  cdpWs.on('open', () => {
    if (requiresSession) {
      // Remote CDP: attach to target with flattened session first
      cdpWs.send(JSON.stringify({
        id: ++state.msgId,
        method: 'Target.attachToTarget',
        params: { targetId, flatten: true },
      }));
    } else {
      // Local Chrome: page-level WebSocket, send screencast directly
      cdpWs.send(cdpMsg(state, 'Page.startScreencast', {
        format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
      }));
      // Enable Page domain to receive navigation lifecycle events
      cdpWs.send(cdpMsg(state, 'Page.enable'));
      // Discover the main frame ID so we only forward loading events for the
      // top-level frame, not iframes/ads that load continuously.
      const frameTreeId = ++state.msgId;
      cdpWs.send(JSON.stringify({ id: frameTreeId, method: 'Page.getFrameTree', ...(state.cdpSessionId ? { sessionId: state.cdpSessionId } : {}) }));
    }
  });

  cdpWs.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());

      // Capture main frame ID from Page.getFrameTree response
      if (msg.result?.frameTree?.frame?.id && !state.mainFrameId) {
        state.mainFrameId = msg.result.frameTree.frame.id;
      }

      // Handle attachToTarget response — start screencast once we have a session
      if (requiresSession && !state.cdpSessionId && msg.result?.sessionId) {
        state.cdpSessionId = msg.result.sessionId;
        cdpWs.send(cdpMsg(state, 'Page.startScreencast', {
          format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
        }));
        // Enable Page domain to receive navigation lifecycle events
        cdpWs.send(cdpMsg(state, 'Page.enable'));
        return;
      }

      // In session mode, only handle messages for our session
      if (state.cdpSessionId && msg.sessionId && msg.sessionId !== state.cdpSessionId) return;

      if (msg.method === 'Page.screencastFrame') {
        cdpWs.send(cdpMsg(state, 'Page.screencastFrameAck', { sessionId: msg.params.sessionId }));
        if (clientWs.readyState === WebSocket.OPEN) {
          // Send metadata when viewport dimensions change
          const meta = msg.params.metadata;
          if (meta && (meta.deviceWidth !== state.lastDeviceWidth || meta.deviceHeight !== state.lastDeviceHeight)) {
            state.lastDeviceWidth = meta.deviceWidth;
            state.lastDeviceHeight = meta.deviceHeight;
            clientWs.send(JSON.stringify({
              type: 'metadata',
              deviceWidth: meta.deviceWidth,
              deviceHeight: meta.deviceHeight,
            }));
          }
          clientWs.send(Buffer.from(msg.params.data, 'base64'));
        }
      } else if (msg.method === 'Page.frameStartedLoading' || msg.method === 'Page.frameStoppedLoading') {
        // Only forward loading state for the main frame — subframes (ads,
        // analytics, iframes) load continuously and would keep the spinner on.
        const frameId = msg.params?.frameId;
        if ((!state.mainFrameId || frameId === state.mainFrameId) && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'page_loading',
            loading: msg.method === 'Page.frameStartedLoading',
          }));
        }
      } else if (msg.id && state.pendingSelections.has(msg.id)) {
        state.pendingSelections.delete(msg.id);
        const text = msg.result?.result?.value;
        if (typeof text === 'string' && text && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'selection_result', text }));
        }
      }
    } catch { /* ignore */ }
  });

  cdpWs.on('close', () => {
    // If this wasn't our active connection (already replaced by a tab switch), ignore
    if (cdpScreencast?.cdpWs !== cdpWs) return;

    // Unexpected close — try to recover by switching to agent's active tab
    findActivePageTarget().then(target => {
      if (target && cdpScreencast?.clientWs === clientWs && clientWs.readyState === WebSocket.OPEN) {
        console.log('[CDP] Recovering from closed target, switching to', target.id);
        cdpScreencast.autoFollow = true;
        switchScreencastTarget(target, clientWs);
        broadcastTabList();
      } else if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    }).catch(() => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });
  });

  cdpWs.on('error', (err) => {
    console.error('[CDP] Screencast error:', err);
  });
}

function cleanupCdpScreencast() {
  if (!cdpScreencast) return;
  if (cdpScreencast.cdpWs.readyState === WebSocket.OPEN) {
    cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Page.stopScreencast'));
    cdpScreencast.cdpWs.close();
  }
  cdpScreencast = null;
}

/** Switch the CDP screencast to a different target, keeping the client WS alive */
function switchScreencastTarget(target: PageTarget, clientWs: WebSocket): void {
  if (cdpScreencast?.cdpWs.readyState === WebSocket.OPEN) {
    cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Page.stopScreencast'));
    cdpScreencast.cdpWs.close();
  }
  // Activate the tab in Chrome so it renders (required for screencast).
  // Use Target.activateTarget on a temporary browser-level CDP connection
  // instead of Page.bringToFront, which steals OS window focus.
  activateTargetInBackground(target.id);
  connectCdpToTarget(target.id, target.wsUrl, clientWs, target.requiresSession);
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({ type: 'tab_switched', targetId: target.id }));
  }
}

/** Activate a tab in Chrome without stealing OS focus.
 *  Opens a short-lived browser-level CDP connection to send Target.activateTarget. */
function activateTargetInBackground(targetId: string): void {
  const endpoint = getCdpHttpEndpoint();
  // Fetch the browser WebSocket URL, then send activateTarget
  fetch(`${endpoint}/json/version`)
    .then(res => res.json() as Promise<{ webSocketDebuggerUrl: string }>)
    .then(info => {
      const browserWs = new WebSocket(info.webSocketDebuggerUrl);
      browserWs.on('open', () => {
        browserWs.send(JSON.stringify({
          id: 1,
          method: 'Target.activateTarget',
          params: { targetId },
        }));
      });
      browserWs.on('message', () => {
        browserWs.close();
      });
      browserWs.on('error', () => { /* best-effort */ });
      setTimeout(() => browserWs.close(), 3000);
    })
    .catch(() => { /* best-effort — screencast may just show stale frames */ });
}

/** Broadcast tab list to the connected frontend viewer.
 *  Accepts pre-fetched data to avoid redundant calls when used alongside findActivePageTarget. */
async function broadcastTabList(prefetched?: { allTargets: PageTarget[]; daemonTabs: Awaited<ReturnType<typeof tabManager.queryTabs>> }): Promise<void> {
  if (!cdpScreencast) return;
  const clientWs = cdpScreencast.clientWs;
  if (clientWs.readyState !== WebSocket.OPEN) return;

  try {
    const { allTargets, daemonTabs } = prefetched ?? {
      allTargets: await getAllPageTargets(),
      daemonTabs: await tabManager.queryTabs(),
    };

    const claimedTargetIds = new Set<string>();
    let tabs: BrowserTabInfo[] = [];
    for (const dt of daemonTabs) {
      const target = allTargets.find(t => tabManager.urlsMatch(t.url, dt.url) && !claimedTargetIds.has(t.id));
      if (!target) continue; // skip tabs with no CDP match (timing edge case, resolves on next poll)
      claimedTargetIds.add(target.id);
      tabs.push({
        targetId: target.id,
        // Positional index for the renderer's display fallback only — the daemon's
        // stable ids (t1, t2, …) are strings and tab switching uses targetId
        index: tabs.length,
        url: dt.url,
        // Prefer Chrome's title (actual <title> tag) over daemon's (often just domain)
        title: target.title || dt.title || '',
        active: dt.active,
      });
    }

    // If URL-based matching produced no tabs (daemon state is stale — common in
    // --cdp / host browser mode where the daemon doesn't track navigations),
    // fall back to building the tab list directly from Chrome's CDP targets.
    if (tabs.length === 0 && allTargets.length > 0) {
      const currentTargetId = cdpScreencast?.currentTargetId;
      tabs = allTargets.map((t, i) => ({
        targetId: t.id,
        index: i,
        url: t.url,
        title: t.title || '',
        active: t.id === currentTargetId,
      }));
    }

    const activeEntry = tabs.find(t => t.active);
    const activeTargetId = activeEntry?.targetId;

    // Auto-follow: switch screencast if active target changed (e.g. user clicked a link that opened a new tab)
    if (cdpScreencast?.autoFollow && activeTargetId && activeTargetId !== cdpScreencast?.currentTargetId) {
      const target = allTargets.find(t => t.id === activeTargetId);
      if (target) {
        switchScreencastTarget(target, clientWs);
      }
    }

    clientWs.send(JSON.stringify({
      type: 'tab_list',
      tabs,
      activeTargetId: activeEntry?.targetId ?? cdpScreencast?.currentTargetId ?? '',
    }));
  } catch (err) {
    console.error('[CDP] Failed to broadcast tab list:', err);
  }
}

/** After a browser action, check if the active tab changed and switch screencast */
function notifyBrowserAction() {
  if (!cdpScreencast) return;
  const currentClient = cdpScreencast.clientWs;
  // Brief delay to let agent-browser update its internal state after the action
  setTimeout(async () => {
    if (!cdpScreencast || cdpScreencast.clientWs !== currentClient) return;

    try {
      // Fetch once and share across both operations
      const [allTargets, daemonTabs] = await Promise.all([
        getAllPageTargets(),
        tabManager.queryTabs(),
      ]);

      // Resolve the active target from daemon info
      const activeDaemonTab = daemonTabs.find(t => t.active);
      let activeTarget: PageTarget | null = allTargets[0] ?? null;
      if (activeDaemonTab && allTargets.length > 1) {
        activeTarget = allTargets.find(p => tabManager.urlsMatch(p.url, activeDaemonTab.url)) ?? activeTarget;
      }

      // Switch screencast only if auto-following and target changed
      if (activeTarget && activeTarget.id !== cdpScreencast.currentTargetId && cdpScreencast.autoFollow) {
        console.log(`[CDP] Auto-following to target ${activeTarget.id}`);
        switchScreencastTarget(activeTarget, currentClient);
      }

      // Always broadcast updated tab list (so frontend sees agent's active tab move)
      broadcastTabList({ allTargets, daemonTabs });
    } catch (err) {
      console.error('[CDP] notifyBrowserAction failed:', err);
    }
  }, 300);
}

// Handle browser stream WebSocket - CDP-based screencast
function handleBrowserStreamConnection(ws: WebSocket) {
  // If there's an existing screencast, close it (single viewer)
  cleanupCdpScreencast();

  findActivePageTarget().then((target) => {
    if (!target) {
      console.error('[CDP] No active page target found');
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'No browser tab found — the page may still be loading' }));
      }
      ws.close();
      return;
    }
    connectCdpToTarget(target.id, target.wsUrl, ws, target.requiresSession);
    broadcastTabList();
  }).catch((err) => {
    console.error('[CDP] Failed to start screencast:', err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to connect to browser' }));
    }
    ws.close();
  });

  // Start tab list polling for this connection (replaces any previous viewer's timer)
  const tabPoll = startTabPolling(() => broadcastTabList());

  // Forward input events and handle tab control messages from client
  // Protocol: see src/renderer/components/browser/browser-preview.tsx
  ws.on('message', async (rawData) => {
    try {
      const data = JSON.parse(rawData.toString());
      if (!cdpScreencast) return;

      if (data.type === 'switch_tab' && data.targetId) {
        // User wants to view a specific tab
        const allTargets = await getAllPageTargets();
        const target = allTargets.find(t => t.id === data.targetId);
        if (target && cdpScreencast) {
          cdpScreencast.autoFollow = false;
          switchScreencastTarget(target, ws);
        }
      } else if (data.type === 'close_tab' && data.targetId) {
        // Close a tab via CDP Target.closeTarget on a temporary browser-level connection
        const endpoint = getCdpHttpEndpoint();
        try {
          const versionRes = await fetch(`${endpoint}/json/version`);
          const versionInfo = await versionRes.json() as { webSocketDebuggerUrl: string };
          const browserWs = new WebSocket(versionInfo.webSocketDebuggerUrl);
          browserWs.on('open', () => {
            browserWs.send(JSON.stringify({
              id: 1,
              method: 'Target.closeTarget',
              params: { targetId: data.targetId },
            }));
          });
          browserWs.on('message', () => {
            browserWs.close();
            // If we just closed the tab we were screencasting, switch to another
            if (cdpScreencast?.currentTargetId === data.targetId) {
              findActivePageTarget().then(target => {
                if (target && cdpScreencast) {
                  switchScreencastTarget(target, ws);
                }
                broadcastTabList();
              });
            } else {
              broadcastTabList();
            }
          });
          browserWs.on('error', () => {});
          setTimeout(() => browserWs.close(), 3000);
        } catch {
          console.error('[CDP] Failed to close tab', data.targetId);
        }
      } else if (data.type === 'follow_agent') {
        if (cdpScreencast) cdpScreencast.autoFollow = data.enabled !== false;
        if (cdpScreencast?.autoFollow) {
          // Snap to agent's active tab immediately
          const target = await findActivePageTarget();
          if (target && cdpScreencast && target.id !== cdpScreencast.currentTargetId) {
            switchScreencastTarget(target, ws);
          }
        }
      } else if (cdpScreencast.cdpWs.readyState === WebSocket.OPEN) {
        if (data.type === 'input_mouse') {
          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchMouseEvent', {
            type: data.eventType,
            x: Math.round(data.x),
            y: Math.round(data.y),
            button: data.button,
            clickCount: data.clickCount || 0,
            deltaX: data.deltaX || 0,
            deltaY: data.deltaY || 0,
            modifiers: data.modifiers || 0,
          }));
        } else if (data.type === 'input_keyboard') {
          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchKeyEvent', {
            type: data.eventType,
            key: data.key,
            code: data.code,
            text: data.text,
            windowsVirtualKeyCode: data.keyCode || 0,
            nativeVirtualKeyCode: data.keyCode || 0,
            modifiers: data.modifiers || 0,
          }));
        } else if (data.type === 'input_press') {
          // Playwright-style key press: look up editing commands from Playwright's
          // macEditingCommands map and include them in the CDP event. This is required
          // for Chrome to trigger keyboard shortcuts (selectAll, cut, undo, etc.) via CDP.
          const mods = data.modifiers || 0;
          const isPrintable = data.key && data.key.length === 1;
          const commands = getEditingCommands(data.code, mods);

          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchKeyEvent', {
            type: isPrintable ? 'keyDown' : 'rawKeyDown',
            key: data.key, code: data.code,
            text: isPrintable ? data.key : '',
            unmodifiedText: isPrintable ? data.key : '',
            windowsVirtualKeyCode: data.keyCode || 0,
            nativeVirtualKeyCode: data.keyCode || 0,
            modifiers: mods,
            commands,
          }));

          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: data.key, code: data.code,
            windowsVirtualKeyCode: data.keyCode || 0,
            nativeVirtualKeyCode: data.keyCode || 0,
            modifiers: mods,
          }));
        } else if (data.type === 'input_paste' && data.text) {
          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.insertText', {
            text: data.text,
          }));
        } else if (data.type === 'get_selection') {
          // Capture the message ID before cdpMsg increments it, to avoid re-parsing
          const msgId = cdpScreencast.msgId + 1;
          const msgStr = cdpMsg(cdpScreencast, 'Runtime.evaluate', {
            expression: 'window.getSelection().toString()',
            returnByValue: true,
          });
          cdpScreencast.pendingSelections.add(msgId);
          cdpScreencast.cdpWs.send(msgStr);
        }
      }
    } catch { /* ignore parse errors for non-JSON frames */ }
  });

  ws.on('close', () => {
    stopTabPolling(tabPoll);
    if (cdpScreencast?.clientWs === ws) cleanupCdpScreencast();
  });

  ws.on('error', () => {
    stopTabPolling(tabPoll);
    if (cdpScreencast?.clientWs === ws) cleanupCdpScreencast();
  });
}

// Start dashboard processes asynchronously (don't block server startup)
dashboardManager.scanAndStartAll().catch((error) => {
  console.error('[DashboardManager] Failed to scan and start dashboards:', error);
});

// Sweep abandoned input requests. Entries the host never answers (session
// deleted mid-prompt, app closed, request card ignored) would otherwise live
// forever — pinning dead tool-handler closures and, via the early-result
// buffer, secret values. TTLs are type-aware inside cleanupStale.
setInterval(() => inputManager.cleanupStale(), 60_000).unref();

// Pin agent-browser's screenshot directory and sweep stale files (boot +
// hourly). Every screenshot is a uniquely named PNG nothing else deletes.
startScreenshotJanitor();

console.log(`Server running on http://localhost:${port}`);
console.log('Available endpoints:');
console.log('  POST   /sessions');
console.log('  GET    /sessions/:id');
console.log('  GET    /sessions');
console.log('  DELETE /sessions/:id');
console.log('  POST   /sessions/:id/interrupt');
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
      _setBrowserState({ active: false, sessionId: null, cdpUrl: null });
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

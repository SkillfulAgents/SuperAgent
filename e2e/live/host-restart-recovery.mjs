#!/usr/bin/env node
/**
 * Live probe: a parked user-input request survives a host restart.
 *
 * This is the one path with no mock-E2E coverage. Recovery only fires when the
 * host has NO in-memory record of a request but the transcript shows an
 * unresolved blocking tool call — which is exactly what a restart produces and
 * exactly what a mock run never does, because there the host observes every
 * stream event it later relies on.
 *
 * It matters more now that the per-type SSE events and their verbatim replay
 * are gone: a reconnecting client no longer receives the original card event,
 * it reads the pending-requests snapshot. If restart recovery did not
 * repopulate the registry, a restarted host would show a session stuck on
 * "Working…" with an unanswerable question in the transcript.
 *
 * Nothing is mocked: a real container runs a real turn against the real CLI,
 * the host process is killed and booted again against the same data dir, and
 * the assertions read the API the app's own UI reads.
 *
 * Run:
 *   node e2e/live/host-restart-recovery.mjs
 *   node e2e/live/host-restart-recovery.mjs --keep-app   # leave app #2 running
 *
 * Prerequisites: a source data dir with a working LLM key and container
 * runner (the same one the Slack validation suite boots from), Docker running,
 * and sqlite3 on PATH. The source install is only ever READ.
 *
 * KNOWN RESULT as of 2026-07-27 (identical on this branch and on main
 * 3b447e43, so it is a standing gap, not a regression): the last two checks
 * FAIL. The restarted host never resubscribes to the session, so
 * `isSessionActive` is false and the `recoverSessionAwaitingInput` hook on the
 * messages route never fires — the transcript shows the unresolved ask but the
 * request is neither listed nor counted as a wait. The probe is committed
 * red-on-purpose: it measures the gap, and it is what will show the fix works.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SOURCE_DATA_DIR, exec } from './slack-chat/lib/data-dir.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.length ? v.join('=') : true]
  }),
)

const SOURCE = args.source || process.env.RECOVERY_VALIDATION_SOURCE_DIR || DEFAULT_SOURCE_DATA_DIR
const TARGET = args.target || path.join(os.homedir(), 'Downloads', 'host-restart-recovery')
const RUN_DIR = path.join(os.tmpdir(), `host-restart-recovery-${Date.now()}`)

/** A slug no real install uses, so `superagent-<slug>` is never someone's agent. */
const AGENT_SLUG = 'restart-recovery-agent'

/**
 * Away from the packaged default (4000), dev:electron's (5000) and the Slack
 * suite's (5300) — a loopback-specific listener in any of those ranges
 * silently redirects host→container calls into the wrong container.
 */
const CONTAINER_BASE_PORT = 5400

const log = (msg) => console.log(`[restart-recovery] ${msg}`)

const AGENT_CLAUDE_MD = `---
name: Restart Recovery Agent
createdAt: "2026-01-01T00:00:00.000Z"
description: Drives the host-restart recovery probe
---

# Agent Instructions

You are the target of an automated probe. Follow instructions literally.

- When asked to call a specific tool, call exactly that tool, once, with the
  arguments described. Do not substitute a different tool, and do not answer
  your own question.
- Never invent a value for something you were asked to request from the user.
  Requesting it through the proper tool IS the task.
- Keep replies short.
`

/** Rows that would make the seeded install act on its own or carry history in. */
const TABLES_TO_EMPTY = [
  'chat_integrations',
  'chat_integration_sessions',
  'chat_integration_access',
  'scheduled_tasks',
  'webhook_triggers',
  'notifications',
  'agent_acl',
  'agent_connected_accounts',
  'agent_remote_mcps',
  'remote_mcp_servers',
  'x_agent_policies',
  'api_scope_policies',
  'mcp_tool_policies',
  'proxy_audit_log',
  'mcp_audit_log',
  'audit_log',
  'message_author',
  'proxy_tokens',
  'token_exchange_jti',
  'session',
]

function seed() {
  rmSync(TARGET, { recursive: true, force: true })
  mkdirSync(path.join(TARGET, 'agents', AGENT_SLUG, 'workspace'), { recursive: true })

  // settings.json verbatim: the LLM key and container runner have to match the
  // install this is derived from, or nothing runs.
  copyFileSync(path.join(SOURCE, 'settings.json'), path.join(TARGET, 'settings.json'))
  for (const optional of ['tenant-id', 'host-container-tokens.json']) {
    const from = path.join(SOURCE, optional)
    if (existsSync(from)) copyFileSync(from, path.join(TARGET, optional))
  }
  writeFileSync(
    path.join(TARGET, 'agents', AGENT_SLUG, 'workspace', 'CLAUDE.md'),
    AGENT_CLAUDE_MD,
  )

  copyFileSync(path.join(SOURCE, 'superagent.db'), path.join(TARGET, 'superagent.db'))
  // WAL/SHM siblings would replay the source's uncommitted tail over the copy.
  for (const sidecar of ['superagent.db-wal', 'superagent.db-shm']) {
    rmSync(path.join(TARGET, sidecar), { force: true })
  }
  exec(TARGET, TABLES_TO_EMPTY.map((t) => `delete from ${t};`).join('\n'))
  log(`seeded data dir: ${TARGET}`)
}

function removeProbeContainer() {
  const name = `superagent-${AGENT_SLUG}`
  try {
    const out = execFileSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], {
      encoding: 'utf8',
    }).trim()
    if (!out) return
    execFileSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
    log(`removed stale container ${name}`)
  } catch (err) {
    log(`could not remove ${name}: ${err.message}`)
  }
}

async function freePort() {
  for (let port = 3310; port < 3360; port++) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (ok) return port
  }
  throw new Error('no free port in 3310-3359')
}

async function waitFor(label, probe, timeoutMs, intervalMs = 1000) {
  const start = Date.now()
  for (;;) {
    let value
    try {
      value = await probe()
    } catch {
      value = false
    }
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** Boot the app against the seeded dir and wait until its API answers. */
async function startApp(label, port) {
  const logFile = path.join(RUN_DIR, `${label}.log`)
  mkdirSync(RUN_DIR, { recursive: true })
  const out = createWriteStream(logFile, { flags: 'a' })
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUPERAGENT_DATA_DIR: TARGET,
      PORT: String(port),
      NODE_ENV: 'development',
      SUPERAGENT_BASE_PORT: String(CONTAINER_BASE_PORT),
      SUPERAGENT_TEST_UPDATES: '',
    },
    // Own process group: vite forks, and SIGTERM to the wrapper alone would
    // leave the API (and its container subscription) alive — which would make
    // "restart" a lie.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)

  let exited = null
  child.on('exit', (code, signal) => {
    exited = `exited with code=${code} signal=${signal}`
  })

  const base = `http://127.0.0.1:${port}`
  await waitFor(
    `${label} API to answer`,
    async () => {
      if (exited) throw new Error(`${label} ${exited} — see ${logFile}`)
      const res = await fetch(`${base}/api/agents`)
      return res.ok
    },
    180_000,
  )
  log(`${label} up on ${base} (pid ${child.pid}, logs → ${logFile})`)
  return { child, base }
}

async function stopApp(app, label) {
  try {
    process.kill(-app.child.pid, 'SIGTERM')
  } catch {
    app.child.kill('SIGTERM')
  }
  // The port going quiet is the only honest signal that the host is really
  // gone; a SIGTERM that the API outlives would make the restart meaningless.
  await waitFor(
    `${label} to stop answering`,
    async () => {
      try {
        await fetch(`${app.base}/api/agents`)
        return false
      } catch {
        return true
      }
    },
    60_000,
  )
  log(`${label} stopped`)
}

async function api(base, pathname, init) {
  const res = await fetch(`${base}${pathname}`, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${res.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : undefined
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  mkdirSync(RUN_DIR, { recursive: true })
  log(`run dir ${RUN_DIR}`)
  seed()
  removeProbeContainer()

  const port = await freePort()

  // ── Phase 1: park a question on a live host ────────────────────────
  let app = await startApp('app-1', port)
  let sessionId

  try {
    const created = await api(app.base, `/api/agents/${AGENT_SLUG}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message:
          'Call the AskUserQuestion tool exactly once to ask me which database to use, ' +
          'with the options "Postgres" and "MySQL". Do not answer it yourself.',
      }),
    })
    sessionId = created.sessionId ?? created.session?.id ?? created.id
    if (!sessionId) throw new Error(`No session id in create response: ${JSON.stringify(created)}`)
    log(`session ${sessionId}`)

    const parked = await waitFor(
      'the question to park',
      async () => {
        const snap = await api(app.base, `/api/agents/${AGENT_SLUG}/pending-requests?sessionId=${sessionId}`)
        return snap.requests.find((r) => r.kind === 'question')
      },
      300_000,
      2000,
    )
    check('a question parks on the live host', true, `request ${parked.id}`)

    const awaitingBefore = await api(app.base, `/api/agents/${AGENT_SLUG}/sessions`)
    const rowBefore = awaitingBefore.find?.((s) => s.id === sessionId) ?? awaitingBefore.sessions?.find((s) => s.id === sessionId)
    check(
      'the session reads as awaiting before the restart',
      rowBefore?.isAwaitingInput === true || rowBefore?.activity === 'awaiting',
      JSON.stringify({ isAwaitingInput: rowBefore?.isAwaitingInput, activity: rowBefore?.activity }),
    )

    // ── Phase 2: restart the host ────────────────────────────────────
    await stopApp(app, 'app-1')
    app = await startApp('app-2', port)

    // The transcript is the recovery source, and the messages route is what
    // reads it — the same call the UI makes when the session is opened.
    const messages = await api(app.base, `/api/agents/${AGENT_SLUG}/sessions/${sessionId}/messages`)
    const list = Array.isArray(messages) ? messages : messages.messages ?? []
    const unresolvedAsk = list.some(
      (m) =>
        m.type === 'assistant' &&
        (m.toolCalls ?? []).some((t) => t.name === 'AskUserQuestion' && t.result === undefined),
    )
    check('the transcript still shows the unresolved ask after the restart', unresolvedAsk)

    const recovered = await waitFor(
      'the restarted host to recover the request',
      async () => {
        // The recovery hook lives on the messages read, so keep re-reading it:
        // it only fires once the reattached session is marked active.
        await api(app.base, `/api/agents/${AGENT_SLUG}/sessions/${sessionId}/messages`)
        const snap = await api(app.base, `/api/agents/${AGENT_SLUG}/pending-requests?sessionId=${sessionId}`)
        return snap.requests.find((r) => r.kind === 'question')
      },
      120_000,
      3000,
    ).catch(() => null)
    check('the restarted host lists the parked request again', Boolean(recovered), recovered?.id ?? 'not recovered')

    const sessionsAfter = await api(app.base, `/api/agents/${AGENT_SLUG}/sessions`)
    const rowAfter = sessionsAfter.find?.((s) => s.id === sessionId) ?? sessionsAfter.sessions?.find((s) => s.id === sessionId)
    check(
      'the restarted host reports the session awaiting',
      rowAfter?.isAwaitingInput === true || rowAfter?.activity === 'awaiting',
      JSON.stringify({ isAwaitingInput: rowAfter?.isAwaitingInput, activity: rowAfter?.activity }),
    )

    // ── Phase 3: the recovered request is still answerable ───────────
    if (recovered) {
      await api(app.base, `/api/agents/${AGENT_SLUG}/sessions/${sessionId}/answer-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolUseId: recovered.id, answers: { 'Which database?': ['Postgres'] } }),
      }).catch((err) => log(`answer-question failed: ${err.message}`))

      const settled = await waitFor(
        'the answered request to leave the snapshot',
        async () => {
          const snap = await api(app.base, `/api/agents/${AGENT_SLUG}/pending-requests?sessionId=${sessionId}`)
          return !snap.requests.some((r) => r.id === recovered.id)
        },
        60_000,
        2000,
      ).catch(() => false)
      check('answering the recovered request settles it', settled === true)
    }
  } finally {
    if (!args['keep-app']) {
      await stopApp(app, 'app').catch(() => {})
      removeProbeContainer()
    } else {
      log(`--keep-app: ${app.base} left running against ${TARGET}`)
    }
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n[restart-recovery] ${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(`[restart-recovery] ${err.stack || err.message}`)
  process.exitCode = 1
})

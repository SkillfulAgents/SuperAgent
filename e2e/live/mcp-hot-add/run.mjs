#!/usr/bin/env node
/**
 * Live probe: a remote MCP requested mid-turn is hot-added without a restart.
 *
 * Boots the REAL host against a seeded data dir, which runs the REAL agent
 * container and the real model, then drives the browser through
 * `mcp-hot-add.spec.ts`: the agent asks for an OAuth MCP, the person signs in
 * on the (local, mock) server's login page, grants access, and the agent
 * finishes the same turn using the new tool. The Playwright run records the
 * whole thing, so this is also how the demo video is produced.
 *
 * Run:
 *   node e2e/live/mcp-hot-add/run.mjs
 *   node e2e/live/mcp-hot-add/run.mjs --source=/path/to/data-dir   # install to borrow settings.json from
 *   node e2e/live/mcp-hot-add/run.mjs --image=superagent-container:mytag
 *   node e2e/live/mcp-hot-add/run.mjs --keep-data                   # keep the seeded dir (holds API keys!)
 *
 * Prerequisites: Docker running, a container image built from THIS checkout
 * (`docker build -t superagent-container:mcp-hot-add agent-container`), and
 * a source data dir whose settings.json carries a working LLM key. The source
 * install is only ever READ; only settings.json, host-container-tokens.json
 * and tenant-id are copied, never the database.
 *
 * The host is started with SUPERAGENT_UNSAFE_ALLOW_LOOPBACK_MCP=1 so the mock
 * MCP on 127.0.0.1 passes the remote-MCP SSRF policy — the same exception the
 * Electron app grants a local MCP server.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../..')

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.length ? v.join('=') : true]
  }),
)

const SOURCE = args.source || process.env.MCP_HOT_ADD_SOURCE_DIR || path.join(os.homedir(), 'Downloads', 'superagent-sdk257')
const IMAGE = args.image || process.env.MCP_HOT_ADD_IMAGE || 'superagent-container:mcp-hot-add'
const RUN_DIR = path.join(os.tmpdir(), `mcp-hot-add-${Date.now()}`)
const MARKER = '.mcp-hot-add-probe'
// Away from the packaged default (4000), dev:electron's (5000), the Slack
// suite's (5300) and the restart probe's (5400).
const CONTAINER_BASE_PORT = 5500

const log = (msg) => console.log(`[mcp-hot-add] ${msg}`)

// Private temp dir: the seeded copy holds real credentials.
const TARGET = mkdtempSync(path.join(os.tmpdir(), 'mcp-hot-add-data-'))

function seed() {
  const settingsPath = path.join(SOURCE, 'settings.json')
  if (!existsSync(settingsPath)) throw new Error(`No settings.json in ${SOURCE}`)
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  settings.container = { ...(settings.container ?? {}), containerRunner: 'docker', agentImage: IMAGE }
  settings.app = { ...(settings.app ?? {}), setupCompleted: true }

  mkdirSync(TARGET, { recursive: true })
  writeFileSync(path.join(TARGET, MARKER), 'mcp-hot-add probe scratch dir\n')
  writeFileSync(path.join(TARGET, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 })
  for (const optional of ['tenant-id', 'host-container-tokens.json']) {
    const from = path.join(SOURCE, optional)
    if (existsSync(from)) copyFileSync(from, path.join(TARGET, optional))
  }
  log(`seeded data dir ${TARGET} (image ${IMAGE}, fresh database)`)
}

function removeSeededDataDir() {
  if (!existsSync(path.join(TARGET, MARKER))) return
  try {
    rmSync(TARGET, { recursive: true, force: true })
    log(`removed seeded data dir ${TARGET}`)
  } catch (err) {
    log(`could not remove ${TARGET}: ${err.message} — it holds credentials, delete it by hand`)
  }
}

async function freePort() {
  for (let port = 3410; port < 3460; port++) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (ok) return port
  }
  throw new Error('no free port in 3410-3459')
}

async function waitFor(label, probe, timeoutMs, intervalMs = 1000) {
  const start = Date.now()
  for (;;) {
    let value
    try { value = await probe() } catch { value = false }
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function startApp(port) {
  const logFile = path.join(RUN_DIR, 'host.log')
  const out = createWriteStream(logFile, { flags: 'a' })
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUPERAGENT_DATA_DIR: TARGET,
      PORT: String(port),
      NODE_ENV: 'development',
      SUPERAGENT_BASE_PORT: String(CONTAINER_BASE_PORT),
      SUPERAGENT_UNSAFE_ALLOW_LOOPBACK_MCP: '1',
      SUPERAGENT_TEST_UPDATES: '',
      E2E_MOCK: '',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  let exited = null
  child.on('exit', (code, signal) => { exited = `exited with code=${code} signal=${signal}` })

  const base = `http://127.0.0.1:${port}`
  try {
    await waitFor('host API to answer', async () => {
      if (exited) throw new Error(`host ${exited} — see ${logFile}`)
      const res = await fetch(`${base}/api/settings`)
      return res.ok
    }, 180_000)
  } catch (err) {
    if (!exited) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    throw err
  }
  log(`host up on ${base} (pid ${child.pid}, logs → ${logFile})`)
  return { child, base }
}

async function stopApp(app) {
  try { process.kill(-app.child.pid, 'SIGTERM') } catch { app.child.kill('SIGTERM') }
  await waitFor('host to stop answering', async () => {
    try { await fetch(`${app.base}/api/agents`); return false } catch { return true }
  }, 60_000)
  log('host stopped')
}

function superagentContainers() {
  try {
    return new Set(
      execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' })
        .split('\n')
        .filter((n) => n.startsWith('superagent-')),
    )
  } catch {
    return new Set()
  }
}

/**
 * Containers this run created: whatever `superagent-*` container appeared
 * since the host booted. Agent slugs are random, so the name cannot be
 * predicted — but the seeded install starts with no agents at all, so every
 * new container is the probe's.
 */
function probeContainers(before) {
  return [...superagentContainers()].filter((name) => !before.has(name))
}

function captureAndRemoveContainer(name) {
  try {
    const id = execFileSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8' }).trim()
    if (!id) return null
    const logs = execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const file = path.join(RUN_DIR, `${name}.container.log`)
    writeFileSync(file, logs)
    execFileSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
    log(`captured container log → ${file}, removed ${name}`)
    return logs
  } catch (err) {
    log(`could not capture/remove ${name}: ${err.message}`)
    return null
  }
}

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function listFiles(dir, ext) {
  const found = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (p.endsWith(ext)) found.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return found
}

async function main() {
  mkdirSync(RUN_DIR, { recursive: true })
  log(`run dir ${RUN_DIR}`)
  let app = null
  let exitCode = 1
  let before = new Set()
  try {
    seed()
    const port = await freePort()
    before = superagentContainers()
    app = await startApp(port)

    const outputDir = path.join(RUN_DIR, 'test-results')
    const result = spawnSync('npx', ['playwright', 'test', '--config', 'playwright.live-mcp.config.ts'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        E2E_BASE_URL: app.base,
        PLAYWRIGHT_OUTPUT_DIR: outputDir,
      },
      stdio: 'inherit',
    })
    exitCode = result.status ?? 1

    // The container's own log is the proof of WHICH path ran: the hot path
    // logs "hot-added to the live query", the legacy path logs "scheduling
    // interrupt to inject tools".
    console.log('\nContainer-side evidence:')
    let allOk = exitCode === 0
    const containers = probeContainers(before)
    allOk = check('the probe ran one real agent container', containers.length === 1, containers.join(', ')) && allOk
    for (const name of containers) {
      const logs = captureAndRemoveContainer(name) ?? ''
      allOk = check('remote MCP applied to the live query in place', /Applied remote MCP servers in place: added=\[[^\]]*rocket_ops/.test(logs)) && allOk
      allOk = check('approved server hot-added, no interrupt scheduled', /hot-added to the live query/.test(logs) && !/scheduling interrupt to inject tools/.test(logs)) && allOk
      allOk = check('query was never restarted after the MCP approval', !/Restarting query after interrupt/.test(logs)) && allOk
    }
    if (!allOk) exitCode = exitCode || 1

    const videos = listFiles(outputDir, '.webm')
    console.log('\nRecordings:')
    for (const v of videos) console.log(`  ${v}`)
    // One clip per test output dir: main page with the OAuth popup laid over it.
    for (const testDir of new Set(videos.map((v) => path.dirname(v)))) {
      try {
        const clip = execFileSync('node', [path.join(HERE, 'compose-video.mjs'), testDir], { encoding: 'utf8' }).trim()
        console.log(`  demo clip → ${clip}`)
      } catch (err) {
        log(`could not compose a demo clip for ${testDir}: ${err.message}`)
      }
    }
    console.log(`Host log: ${path.join(RUN_DIR, 'host.log')}`)
  } catch (err) {
    console.error(`[mcp-hot-add] FAILED: ${err.message}`)
    exitCode = 1
  } finally {
    if (app) {
      for (const name of probeContainers(before)) captureAndRemoveContainer(name)
      await stopApp(app).catch((err) => log(`stop failed: ${err.message}`))
    }
    if (args['keep-data']) log(`kept seeded data dir ${TARGET} — it holds API keys, delete it when done`)
    else removeSeededDataDir()
  }
  process.exit(exitCode)
}

main()

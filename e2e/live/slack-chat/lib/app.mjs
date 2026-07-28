/**
 * Booting the real app against the seeded data dir, and inspecting it.
 *
 * Two host shapes matter, because the "can't do this in chat" notice resolves
 * its link differently on each (see resolveAppLinkContext):
 *
 *   web      — plain Node. `process.type` is undefined, so the notice takes the
 *              cloud branch and links to HOST_PUBLIC_URL when one is set.
 *   electron — `process.type === 'browser'`, so the notice takes the desktop
 *              branch and links to the SUPERAGENT_PROTOCOL scheme
 *              (superagent-dev:// in a dev build).
 *
 * Both run the same services: api/index.ts calls initializeServices() outside
 * Electron, main/index.ts calls it inside — either way the chat integration
 * manager comes up and connects to Slack for real.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'

/** A port nothing is listening on, so a run never lands on the user's dev server. */
export async function freePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
  if (preferred && (await tryPort(preferred))) return preferred
  for (let port = 3210; port < 3260; port++) if (await tryPort(port)) return port
  throw new Error('no free port in 3210-3259')
}

/**
 * Whether anything already owns loopback ports in the container publish range.
 *
 * This is checked explicitly because the failure it causes is silent: a
 * loopback-specific listener (a packaged install's Lima port-forward) shadows
 * Docker's 0.0.0.0 publish, so host→container calls reach the WRONG container
 * and every one of them returns 401. Nothing in the app's logs points at the
 * port.
 */
export async function containerPortRangeConflicts(basePort, span = 8) {
  const conflicts = []
  for (let port = basePort; port < basePort + span; port++) {
    const busy = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' })
      socket.setTimeout(400)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (busy) conflicts.push(port)
  }
  return conflicts
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

/**
 * Start the app and wait until its API answers and the Slack integration
 * reports connected.
 *
 * `hostPublicUrl` is passed through verbatim, including the empty string: the
 * unset-cloud-host row of the notice matrix is a real case the suite checks,
 * and it is expressed by NOT setting the variable.
 */
export async function startApp({
  host = 'web',
  dataDir,
  port,
  containerBasePort = 5300,
  hostPublicUrl,
  repoRoot,
  logFile,
  integrationId,
  log = () => {},
}) {
  const env = {
    ...process.env,
    SUPERAGENT_DATA_DIR: dataDir,
    PORT: String(port),
    NODE_ENV: 'development',
    // Container ports MUST NOT start at the 4000 default. A packaged install's
    // Lima runner forwards its container ports on 127.0.0.1, and a
    // loopback-specific bind shadows Docker's 0.0.0.0 bind — so a validation
    // container published on 4001 is reachable from this process only if
    // nothing else already owns loopback 4001. When something does, every
    // host→container call silently lands in the OTHER install's container and
    // comes back 401 (its host token differs). That failure looks exactly like
    // a broken build, so the base port is pinned away from both the packaged
    // default (4000) and dev:electron's (5000).
    SUPERAGENT_BASE_PORT: String(containerBasePort),
    // The suite's own agent is the only one; nothing here should phone home.
    SUPERAGENT_TEST_UPDATES: '',
  }
  if (hostPublicUrl) env.HOST_PUBLIC_URL = hostPublicUrl
  else delete env.HOST_PUBLIC_URL

  // electron-vite directly, not `npm run dev:electron`: that script pins
  // SUPERAGENT_BASE_PORT=5000 through cross-env, which would overwrite the
  // range chosen above.
  const command =
    host === 'electron'
      ? ['npx', ['electron-vite', 'dev']]
      : ['npx', ['vite', '--port', String(port), '--strictPort']]

  if (host === 'electron') {
    // A packaged Gamut may be running; without this the dev build exits on the
    // single-instance lock instead of booting.
    env.SUPERAGENT_DISABLE_SINGLE_INSTANCE = '1'
  }

  mkdirSync(path.dirname(logFile), { recursive: true })
  // better-sqlite3 is a native module and the two hosts need different ABIs, so
  // whichever ran last leaves the other broken. Rebuilding for the host about
  // to run is what `npm run dev` / `dev:electron` each do for themselves.
  log(`rebuilding better-sqlite3 for ${host}…`)
  await new Promise((resolve, reject) => {
    const rebuild =
      host === 'electron'
        ? spawn('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], { cwd: repoRoot, stdio: 'ignore' })
        : spawn('npm', ['rebuild', 'better-sqlite3'], { cwd: repoRoot, stdio: 'ignore' })
    rebuild.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`rebuild exited ${code}`))))
  })

  const out = createWriteStream(logFile, { flags: 'a' })
  // Own process group: electron-vite forks Electron, and SIGTERM to the
  // wrapper alone would leave the app (and its Socket Mode session) running.
  const child = spawn(command[0], command[1], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  log(`app (${host}) pid ${child.pid}, logs → ${logFile}`)

  let exited = null
  child.on('exit', (code, signal) => {
    exited = `exited with code=${code} signal=${signal}`
  })

  // Electron ignores PORT: main binds its own API server from 47891 upward
  // (bindServerWithRetry), so the port has to be read back rather than chosen.
  let apiPort = port
  if (host === 'electron') {
    apiPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron never logged its API port')), 180_000)
      let buffered = ''
      const onData = (chunk) => {
        buffered += chunk.toString()
        const match = buffered.match(/API server running on http:\/\/localhost:(\d+)/)
        if (!match) return
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve(Number(match[1]))
      }
      child.stdout.on('data', onData)
    })
    log(`electron API bound to ${apiPort}`)
  }

  const base = `http://127.0.0.1:${apiPort}`
  const api = makeApi(base)

  try {
    await waitFor(
      'the API to answer',
      async () => {
        if (exited) throw new Error(`app ${exited} — see ${logFile}`)
        const res = await fetch(`${base}/api/agents`)
        return res.ok
      },
      180_000,
    )
    log('API is up')

    await waitFor(
      'the Slack integration to report connected',
      async () => {
        if (exited) throw new Error(`app ${exited} — see ${logFile}`)
        const status = await api.json(`/api/chat-integrations/${integrationId}/status`)
        return status?.connected === true
      },
      120_000,
    )
    log('Slack integration is connected')
  } catch (err) {
    child.kill('SIGTERM')
    throw err
  }

  return {
    port: apiPort,
    base,
    api,
    logFile,
    async stop() {
      if (exited) return
      const signal = (sig) => {
        try {
          process.kill(-child.pid, sig)
        } catch {
          try {
            child.kill(sig)
          } catch {
            /* already gone */
          }
        }
      }
      signal('SIGTERM')
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          signal('SIGKILL')
          resolve()
        }, 15_000)
        child.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      // Electron outlives its electron-vite wrapper often enough to matter: a
      // survivor keeps the Socket Mode session (stealing the next run's events)
      // and keeps writing into the seed dir (so the next seed's rm races it).
      // Match on the repo path so only this harness's app is ever targeted.
      if (host === 'electron') {
        for (const sig of ['-TERM', '-KILL']) {
          try {
            execFileSync('pkill', [sig, '-f', `${repoRoot}/node_modules/electron/dist/Electron.app`], {
              stdio: 'ignore',
            })
          } catch {
            /* pkill exits non-zero when nothing matched — that is the good case */
          }
          await new Promise((r) => setTimeout(r, 2_000))
        }
      }
    },
  }
}

function makeApi(base) {
  const json = async (pathname, init) => {
    const res = await fetch(`${base}${pathname}`, init)
    if (!res.ok) return null
    return res.json()
  }
  /**
   * POST and report the failure body. Used to drive the app-side decision
   * routes — the surface a chat user is NOT on — so a check can prove both
   * surfaces settle the same request.
   */
  const post = async (pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`POST ${pathname} → ${res.status}: ${text.slice(0, 300)}`)
    try {
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  return {
    json,
    post,
    /** Sessions of an agent, newest first. */
    async sessions(agentSlug) {
      const body = await json(`/api/agents/${encodeURIComponent(agentSlug)}/sessions`)
      if (!body) return []
      return Array.isArray(body) ? body : (body.sessions ?? [])
    },
    /** The registry snapshot Phase 6 exposes — the source of truth for open asks. */
    async pendingRequests(agentSlug) {
      const body = await json(`/api/agents/${encodeURIComponent(agentSlug)}/pending-requests`)
      if (!body) return []
      return Array.isArray(body) ? body : (body.requests ?? [])
    },
    async messages(agentSlug, sessionId) {
      const body = await json(
        `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      )
      if (!body) return []
      return Array.isArray(body) ? body : (body.messages ?? [])
    },
    async chatSessions(integrationId) {
      const body = await json(`/api/chat-integrations/${encodeURIComponent(integrationId)}/sessions`)
      if (!body) return []
      return Array.isArray(body) ? body : (body.sessions ?? [])
    },
  }
}

export { waitFor }

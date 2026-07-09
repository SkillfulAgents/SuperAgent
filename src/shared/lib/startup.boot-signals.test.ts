/**
 * Boot-signal coverage on the REAL app: build the production server bundle,
 * spawn it as a real process, and assert every background service launched by
 * startup.ts prints its positive "started" marker to the actual process
 * stdout.
 *
 * Deliberately NOT run through vitest's module runner: the Node-22 upgrade
 * showed that vite-node's bespoke module system can diverge from the real
 * loader (dynamic-import namespaces, code-split chunks), so "the app boots
 * and every service starts" is only meaningful against the artifact we ship.
 * A missing chunk, a module cycle that breaks at load, or a service that
 * silently never finishes starting all fail here.
 *
 * startup.ts launches services with `.start().catch(console.error)` — only
 * failures log. A new service added there without a start marker fails this
 * test by design: extend EXPECTED_MARKERS.
 *
 * TriggerManager is asserted NOT to start: startup gates it on a platform
 * access token this environment (correctly) lacks. Exercising its real
 * startup end-to-end needs a platform-proxy mock harness.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SERVER_ENTRY = path.join(REPO_ROOT, 'dist', 'web', 'server.mjs')

const EXPECTED_MARKERS = [
  '[ContainerManager] Starting status sync',
  '[ContainerManager] Starting health monitor',
  '[TaskScheduler] Scheduler started',
  '[ChatIntegrationManager] Started',
  '[AutoSleepMonitor] Monitor started',
  '[SessionAutoDeleteMonitor] Monitor started',
  '[AccountSync] Service started',
  '[PlatformService] Started',
]

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

let tempDataDir: string
let child: ChildProcess | null = null

beforeAll(async () => {
  tempDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'boot-signals-'))
  // Build the real server bundle (tsup, sub-second).
  execFileSync('npx', ['tsup'], { cwd: REPO_ROOT, stdio: 'pipe', timeout: 120_000 })
}, 180_000)

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      child!.once('exit', resolve)
      setTimeout(resolve, 5000)
    })
  }
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
})

describe('production server boot signals', () => {
  it('every background service prints its started marker and none fail', async () => {
    const port = await findFreePort()
    let output = ''

    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT, // migrations resolve relative to cwd outside Electron
      env: {
        ...process.env,
        E2E_MOCK: 'true',
        SUPERAGENT_DATA_DIR: tempDataDir,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (d: Buffer) => { output += d.toString() })
    child.stderr!.on('data', (d: Buffer) => { output += d.toString() })
    const exited = new Promise<never>((_, reject) => {
      child!.once('exit', (code) =>
        reject(new Error(`server exited early (code ${code}). Output:\n${output}`))
      )
    })

    const deadline = Date.now() + 60_000
    const waitUntil = async (label: string, check: () => boolean) => {
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}. Output:\n${output}`)
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 200))])
      }
    }

    // 1. The real HTTP surface must come up.
    await waitUntil('HTTP ready', () => {
      void fetch(`http://127.0.0.1:${port}/api/settings`)
        .then((r) => { if (r.ok) output += '\n__HTTP_READY__\n' })
        .catch(() => {})
      return output.includes('__HTTP_READY__')
    })

    // 2. Every service's positive marker (start() calls are fire-and-forget,
    //    so markers can trail readiness).
    for (const marker of EXPECTED_MARKERS) {
      await waitUntil(`marker: ${marker}`, () => output.includes(marker))
    }

    // 3. Nothing failed to start.
    expect(output).not.toContain('Failed to start')

    // 4. No platform token here: the TriggerManager gate must hold.
    expect(output).not.toContain('[TriggerManager] Started')
  }, 90_000)
})

/**
 * Launches the Electron app with remote debugging enabled and returns
 * the CDP WebSocket endpoint URL for Playwright MCP to connect to.
 *
 * Usage: called by the runner when --target electron is specified.
 * Requires: `npm run build:electron` to have been run first.
 *
 * Automatically runs electron-rebuild + ad-hoc codesigning if needed.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')

const CDP_PORT = 9222

let electronProc: ChildProcess | null = null

export function rebuildForElectron(): void {
  console.log('[rebuild] Rebuilding native modules for Electron...')
  execSync('npx electron-rebuild -f', { cwd: PROJECT_ROOT, stdio: 'inherit' })

  if (process.platform === 'darwin') {
    const sqliteNode = resolve(PROJECT_ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
    console.log('[rebuild] Ad-hoc codesigning native module (macOS)...')
    execSync(`codesign --force --deep --sign - "${sqliteNode}"`, { stdio: 'inherit' })
  }
}

export function rebuildForNode(): void {
  console.log('[rebuild] Rebuilding native modules for Node.js...')
  execSync('npm rebuild better-sqlite3', { cwd: PROJECT_ROOT, stdio: 'inherit' })
}

export async function launchElectron(): Promise<{ cdpEndpoint: string; apiPort: number }> {
  const electronBin = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'electron')
  const mainJs = resolve(PROJECT_ROOT, 'dist', 'main', 'index.js')

  console.log(`  [electron] Launching: ${electronBin} ${mainJs}`)
  console.log(`  [electron] CDP port: ${CDP_PORT}`)

  let resolveApiPort: (port: number) => void
  const apiPortPromise = new Promise<number>((r) => { resolveApiPort = r })
  let apiPortResolved = false

  electronProc = spawn(electronBin, [
    mainJs,
    `--remote-debugging-port=${CDP_PORT}`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':99',
    },
    cwd: PROJECT_ROOT,
  })

  electronProc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) console.log(`  [electron][stdout] ${text}`)
    if (!apiPortResolved) {
      const match = text.match(/API server running on http:\/\/localhost:(\d+)/)
      if (match) {
        apiPortResolved = true
        resolveApiPort!(parseInt(match[1], 10))
      }
    }
  })

  electronProc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) console.log(`  [electron][stderr] ${text}`)
  })

  electronProc.on('exit', (code) => {
    console.log(`  [electron] Process exited with code ${code}`)
    electronProc = null
  })

  const [cdpEndpoint, apiPort] = await Promise.all([
    waitForCdp(CDP_PORT),
    Promise.race([
      apiPortPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for Electron API port')), 30000)
      ),
    ]),
  ])

  console.log(`  [electron] CDP endpoint ready: ${cdpEndpoint}`)
  console.log(`  [electron] API server port: ${apiPort}`)

  await waitForApi(apiPort)
  console.log(`  [electron] API is ready`)

  return { cdpEndpoint, apiPort }
}

async function waitForApi(port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  const url = `http://localhost:${port}/api/settings`

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`API not ready at http://localhost:${port} after ${timeoutMs}ms`)
}

async function waitForCdp(port: number, timeoutMs = 30000): Promise<string> {
  const start = Date.now()
  const url = `http://127.0.0.1:${port}/json/version`

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json() as { webSocketDebuggerUrl?: string }
        if (data.webSocketDebuggerUrl) {
          return data.webSocketDebuggerUrl
        }
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`CDP endpoint not available on port ${port} after ${timeoutMs}ms`)
}

export function killElectron(): void {
  if (electronProc) {
    console.log('  [electron] Killing Electron process...')
    electronProc.kill('SIGTERM')
    setTimeout(() => electronProc?.kill('SIGKILL'), 5000)
    electronProc = null
  }
}

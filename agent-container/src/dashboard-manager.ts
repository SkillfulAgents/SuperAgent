import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export const ARTIFACTS_DIR = '/workspace/artifacts'
const DASHBOARD_BASE_PORT = 5000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function validateSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(`Invalid dashboard slug: "${slug}". Must be lowercase alphanumeric with hyphens, not starting/ending with hyphen.`)
  }
  // Belt-and-suspenders: verify resolved path stays within ARTIFACTS_DIR
  const resolved = path.resolve(ARTIFACTS_DIR, slug)
  if (!resolved.startsWith(ARTIFACTS_DIR + '/')) {
    throw new Error(`Invalid dashboard slug: "${slug}". Path traversal detected.`)
  }
}

export type DashboardStatus = 'running' | 'stopped' | 'crashed' | 'starting'

interface DashboardInfo {
  slug: string
  name: string
  description: string
  port: number
  status: DashboardStatus
  process: ChildProcess | null
  restartCount: number
  restartTimestamps: number[]
  logStream: fs.WriteStream | null
}

class DashboardManager {
  private dashboards: Map<string, DashboardInfo> = new Map()
  private nextPort = DASHBOARD_BASE_PORT

  async scanAndStartAll(): Promise<void> {
    try {
      await fs.promises.mkdir(ARTIFACTS_DIR, { recursive: true })
      const entries = await fs.promises.readdir(ARTIFACTS_DIR, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const pkgPath = path.join(ARTIFACTS_DIR, entry.name, 'package.json')
        try {
          await fs.promises.access(pkgPath)
          await this.startDashboard(entry.name)
        } catch {
          // No package.json, skip
        }
      }
    } catch (error) {
      console.error('[DashboardManager] Error scanning artifacts:', error)
    }
  }

  private readPackageJson(slug: string): { name: string; description: string } {
    try {
      const pkgPath = path.join(ARTIFACTS_DIR, slug, 'package.json')
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      return {
        name: pkg.name || slug,
        description: pkg.description || '',
      }
    } catch {
      return { name: slug, description: '' }
    }
  }

  async startDashboard(slug: string): Promise<DashboardInfo> {
    validateSlug(slug)
    const existing = this.dashboards.get(slug)

    // If already running, kill and restart
    if (existing?.process && existing.status === 'running') {
      existing.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        if (existing.process) {
          existing.process.on('exit', () => resolve())
          setTimeout(resolve, 5000) // Force timeout
        } else {
          resolve()
        }
      })
      existing.logStream?.end()
    }

    const { name, description } = this.readPackageJson(slug)
    const port = existing?.port ?? this.nextPort++
    const dashboardDir = path.join(ARTIFACTS_DIR, slug)
    const logPath = path.join(dashboardDir, 'dashboard.log')

    const info: DashboardInfo = {
      slug,
      name,
      description,
      port,
      status: 'starting',
      process: null,
      restartCount: existing?.restartCount ?? 0,
      restartTimestamps: existing?.restartTimestamps ?? [],
      logStream: null,
    }

    this.dashboards.set(slug, info)

    try {
      // Open log stream early so install errors are captured
      info.logStream = fs.createWriteStream(logPath, { flags: 'a' })

      // Run bun install first
      await this.runBunInstall(dashboardDir, info.logStream)

      // Start the dashboard server
      const proc = spawn('bun', ['run', 'start'], {
        cwd: dashboardDir,
        env: {
          ...process.env,
          DASHBOARD_PORT: String(port),
          PORT: String(port),
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      info.process = proc
      info.status = 'running'

      proc.stdout?.pipe(info.logStream, { end: false })
      proc.stderr?.pipe(info.logStream, { end: false })

      proc.on('exit', (code, signal) => {
        console.log(`[DashboardManager] Dashboard ${slug} exited (code=${code}, signal=${signal})`)
        info.status = 'stopped'
        info.process = null

        if (code !== 0 && signal !== 'SIGTERM') {
          this.handleCrash(slug)
        }
      })

      proc.on('error', (error) => {
        console.error(`[DashboardManager] Dashboard ${slug} process error:`, error)
        info.logStream?.write(`[process error] ${error.message}\n`)
        info.status = 'crashed'
        info.process = null
      })

      console.log(`[DashboardManager] Started dashboard ${slug} on port ${port}`)

      // Wait briefly to detect immediate crashes (e.g. syntax errors, missing files)
      await new Promise((resolve) => setTimeout(resolve, 1500))
    } catch (error: any) {
      console.error(`[DashboardManager] Failed to start dashboard ${slug}:`, error)
      info.logStream?.write(`[DashboardManager] Failed to start: ${error?.message || error}\n`)
      info.logStream?.end()
      info.logStream = null
      info.status = 'crashed'
    }

    return info
  }

  private async runBunInstall(dir: string, logStream?: fs.WriteStream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('bun', ['install'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stdout?.on('data', (chunk) => {
        logStream?.write(chunk)
      })
      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
        logStream?.write(chunk)
      })

      proc.on('exit', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`bun install failed (code ${code}): ${stderr}`))
        }
      })

      proc.on('error', (err) => {
        logStream?.write(`[bun install error] ${err.message}\n`)
        reject(err)
      })
    })
  }

  private handleCrash(slug: string): void {
    const info = this.dashboards.get(slug)
    if (!info) return

    const now = Date.now()
    // Prune old timestamps outside the window
    info.restartTimestamps = info.restartTimestamps.filter(
      (ts) => now - ts < RESTART_WINDOW_MS
    )

    if (info.restartTimestamps.length >= MAX_RESTARTS) {
      console.log(`[DashboardManager] Dashboard ${slug} exhausted restart attempts`)
      info.status = 'crashed'
      return
    }

    info.restartTimestamps.push(now)
    info.restartCount++
    console.log(`[DashboardManager] Auto-restarting dashboard ${slug} (attempt ${info.restartTimestamps.length}/${MAX_RESTARTS})`)

    // Delay restart slightly
    setTimeout(() => {
      this.startDashboard(slug).catch((err) => {
        console.error(`[DashboardManager] Failed to restart dashboard ${slug}:`, err)
      })
    }, 1000)
  }

  listDashboards(): Array<{
    slug: string
    name: string
    description: string
    status: DashboardStatus
    port: number
  }> {
    const result: Array<{
      slug: string
      name: string
      description: string
      status: DashboardStatus
      port: number
    }> = []

    // Include tracked dashboards
    for (const info of this.dashboards.values()) {
      result.push({
        slug: info.slug,
        name: info.name,
        description: info.description,
        status: info.status,
        port: info.port,
      })
    }

    // Also scan for untracked dashboards (created but never started)
    try {
      const entries = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (this.dashboards.has(entry.name)) continue

        const pkgPath = path.join(ARTIFACTS_DIR, entry.name, 'package.json')
        try {
          fs.accessSync(pkgPath)
          const { name, description } = this.readPackageJson(entry.name)
          result.push({
            slug: entry.name,
            name,
            description,
            status: 'stopped',
            port: 0,
          })
        } catch {
          // No package.json, skip
        }
      }
    } catch {
      // artifacts dir may not exist yet
    }

    return result
  }

  getDashboardPort(slug: string): number | null {
    const info = this.dashboards.get(slug)
    if (!info || info.status !== 'running') return null
    return info.port
  }

  async getDashboardLogs(slug: string, clear: boolean = false): Promise<string> {
    validateSlug(slug)
    const logPath = path.join(ARTIFACTS_DIR, slug, 'dashboard.log')

    try {
      const content = await fs.promises.readFile(logPath, 'utf-8')

      if (clear) {
        await fs.promises.writeFile(logPath, '')
      }

      return content
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return ''
      }
      throw error
    }
  }

  async createDashboard(
    slug: string,
    name: string,
    description: string,
    framework: 'plain' | 'react' = 'plain'
  ): Promise<void> {
    validateSlug(slug)
    const dir = path.join(ARTIFACTS_DIR, slug)

    // Check if dashboard already exists
    try {
      await fs.promises.access(path.join(dir, 'package.json'))
      throw new Error(`Dashboard "${slug}" already exists. Use a different slug or delete the existing dashboard first.`)
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }

    await fs.promises.mkdir(dir, { recursive: true })

    if (framework === 'react') {
      await this.scaffoldReactDashboard(dir, name, description)
    } else {
      await this.scaffoldPlainDashboard(dir, name, description)
    }
  }

  private async scaffoldPlainDashboard(
    dir: string,
    name: string,
    description: string
  ): Promise<void> {
    const pkg = {
      name,
      description,
      scripts: {
        start: 'bun run index.js',
      },
      dependencies: {},
    }

    await fs.promises.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(pkg, null, 2)
    )

    const indexJs = `const port = process.env.DASHBOARD_PORT || 3000;

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

const html = \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { color: #333; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p>${description || 'Dashboard is running.'}</p>
</body>
</html>\`;

console.log(\`Dashboard server running on http://localhost:\${port}\`);
`

    await fs.promises.writeFile(path.join(dir, 'index.js'), indexJs)
  }

  private async scaffoldReactDashboard(
    dir: string,
    name: string,
    description: string
  ): Promise<void> {
    const templateDir = path.join(
      process.env.HOME || '/home/claude',
      '.claude/skills/dashboards/templates/react-vite'
    )

    // Copy template directory recursively
    await fs.promises.cp(templateDir, dir, { recursive: true })

    // Update package.json with the dashboard's name and description
    const pkgPath = path.join(dir, 'package.json')
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'))
    pkg.name = name
    pkg.description = description
    await fs.promises.writeFile(pkgPath, JSON.stringify(pkg, null, 2))
  }

  async stopAll(): Promise<void> {
    for (const info of this.dashboards.values()) {
      if (info.process) {
        info.process.kill('SIGTERM')
        info.logStream?.end()
      }
    }
    this.dashboards.clear()
  }
}

export const dashboardManager = new DashboardManager()

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import net from 'net'
import type { HostBrowserStatus } from '@shared/lib/config/settings'
import { getDataDir } from '@shared/lib/config/data-dir'
import { getChromeUserDataDir, listChromeProfiles, copyChromeProfileData } from '@shared/lib/browser/chrome-profile'

interface BrowserCandidate {
  browser: string
  paths: string[]
}

const BROWSER_CANDIDATES: Record<string, BrowserCandidate> = {
  darwin: {
    browser: 'chrome',
    paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  },
  linux: {
    browser: 'chrome',
    paths: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser'],
  },
  win32: {
    browser: 'chrome',
    paths: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  },
}

interface AgentBrowserInstance {
  process: ChildProcess
  port: number
  userDataDir: string
  stoppingIntentionally: boolean
}

class HostBrowserManager {
  private instances: Map<string, AgentBrowserInstance> = new Map()
  private detectedPath: string | null = null

  // Callback invoked when a specific agent's browser exits without stopAgent() being called
  // (e.g. user closed Chrome manually). Receives the agentId of the affected instance.
  onExternalExit: ((agentId: string) => void) | null = null

  // Re-export for callers that need direct access
  getChromeUserDataDir = getChromeUserDataDir

  detect(): HostBrowserStatus {
    const candidate = BROWSER_CANDIDATES[process.platform]
    if (!candidate) {
      return { available: false, browser: null, path: null }
    }

    for (const p of candidate.paths) {
      if (fs.existsSync(p)) {
        this.detectedPath = p
        return {
          available: true,
          browser: candidate.browser,
          path: p,
          profiles: listChromeProfiles(),
        }
      }
    }

    return { available: false, browser: null, path: null }
  }

  async ensureRunning(agentId: string, profileId?: string): Promise<{ port: number }> {
    // Check if an instance already exists for this agent and its port is still open
    const existing = this.instances.get(agentId)
    if (existing && await this.isPortOpen(existing.port)) {
      return { port: existing.port }
    }

    // If an instance exists but port is gone, clean up the stale entry
    if (existing) {
      this.stopAgent(agentId)
    }

    const status = this.detect()
    if (!status.available || !status.path) {
      throw new Error('No supported browser detected')
    }

    const port = await this.findFreePort()

    // Chrome refuses to enable CDP on its default (real) data directory:
    //   "DevTools remote debugging requires a non-default data directory"
    // So we always use a dedicated user-data-dir per agent. When a profile is
    // selected, we copy session data (cookies, login data, etc.) from the real
    // Chrome profile into our dedicated dir before launching.
    const userDataDir = path.join(getDataDir(), 'host-browser-profiles', agentId)
    fs.mkdirSync(userDataDir, { recursive: true })

    if (profileId) {
      const destProfileDir = path.join(userDataDir, 'Default')
      // Only copy the user's Chrome profile on first launch. Subsequent launches
      // should keep the session data (cookies, local storage, etc.) that the
      // agent accumulated during its browsing sessions.
      const alreadyHasProfile = fs.existsSync(path.join(destProfileDir, 'Cookies'))
      if (!alreadyHasProfile && copyChromeProfileData(profileId, destProfileDir)) {
        console.log(`[HostBrowserManager] Copied Chrome profile "${profileId}" for agent ${agentId}`)
      }
    }

    const browserProcess = spawn(
      status.path,
      [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=0.0.0.0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
      ],
      { detached: false, stdio: 'ignore' }
    )

    const instance: AgentBrowserInstance = {
      process: browserProcess,
      port,
      userDataDir,
      stoppingIntentionally: false,
    }
    this.instances.set(agentId, instance)

    browserProcess.on('error', (err) => {
      console.error(`[HostBrowserManager] Browser process error for agent ${agentId}:`, err)
    })

    browserProcess.on('exit', (code) => {
      console.log(`[HostBrowserManager] Browser for agent ${agentId} exited with code ${code}`)
      const wasIntentional = instance.stoppingIntentionally
      this.instances.delete(agentId)
      if (!wasIntentional) {
        console.log(`[HostBrowserManager] Browser for agent ${agentId} closed externally, notifying listeners`)
        Promise.resolve(this.onExternalExit?.(agentId)).catch((err) => {
          console.error('[HostBrowserManager] Error in onExternalExit callback:', err)
        })
      }
    })

    try {
      await this.waitForPort(port, 15000)
    } catch (err) {
      this.stopAgent(agentId)
      throw err
    }

    return { port }
  }

  stopAgent(agentId: string): void {
    const instance = this.instances.get(agentId)
    if (instance && !instance.process.killed) {
      // Set flag before kill — the exit event fires asynchronously after kill(),
      // so we keep the flag set (it's reset in the exit handler after checking it)
      instance.stoppingIntentionally = true
      instance.process.kill()
    }
    this.instances.delete(agentId)
  }

  stopAll(): void {
    for (const agentId of Array.from(this.instances.keys())) {
      this.stopAgent(agentId)
    }
  }

  isRunning(agentId?: string): boolean {
    if (agentId) {
      const instance = this.instances.get(agentId)
      return instance !== undefined && !instance.process.killed
    }
    return this.instances.size > 0
  }

  private async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port
        server.close(() => resolve(port))
      })
      server.on('error', reject)
    })
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('error', () => {
        resolve(false)
      })
      socket.connect(port, '127.0.0.1')
    })
  }

  private async waitForPort(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await this.isPortOpen(port)) {
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`Browser debug port ${port} did not become available within ${timeoutMs}ms`)
  }
}

export const hostBrowserManager = new HostBrowserManager()

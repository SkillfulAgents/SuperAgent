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

const CDP_PORT = 9222

class HostBrowserManager {
  private browserProcess: ChildProcess | null = null
  private detectedPath: string | null = null

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

  async ensureRunning(profileId?: string): Promise<{ port: number }> {
    // Check if CDP port is already open (e.g. we already launched, or user
    // started Chrome with --remote-debugging-port themselves)
    if (await this.isPortOpen(CDP_PORT)) {
      return { port: CDP_PORT }
    }

    // If we had a process reference but port is gone, clean up
    if (this.browserProcess) {
      this.stop()
    }

    const status = this.detect()
    if (!status.available || !status.path) {
      throw new Error('No supported browser detected')
    }

    // Chrome refuses to enable CDP on its default (real) data directory:
    //   "DevTools remote debugging requires a non-default data directory"
    // So we always use a dedicated user-data-dir. When a profile is selected,
    // we copy session data (cookies, login data, etc.) from the real Chrome
    // profile into our dedicated dir before launching.
    const userDataDir = path.join(getDataDir(), 'host-browser-profile')
    fs.mkdirSync(userDataDir, { recursive: true })

    if (profileId) {
      const destProfileDir = path.join(userDataDir, 'Default')
      if (copyChromeProfileData(profileId, destProfileDir)) {
        console.log(`[HostBrowserManager] Copied Chrome profile "${profileId}" to ${destProfileDir}`)
      }
    }

    this.browserProcess = spawn(
      status.path,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-debugging-address=0.0.0.0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
      ],
      { detached: false, stdio: 'ignore' }
    )

    this.browserProcess.on('error', (err) => {
      console.error('[HostBrowserManager] Browser process error:', err)
    })

    this.browserProcess.on('exit', (code) => {
      console.log(`[HostBrowserManager] Browser process exited with code ${code}`)
      this.browserProcess = null
    })

    try {
      await this.waitForPort(CDP_PORT, 15000)
    } catch (err) {
      this.stop()
      throw err
    }

    return { port: CDP_PORT }
  }

  stop(): void {
    if (this.browserProcess && !this.browserProcess.killed) {
      this.browserProcess.kill()
      this.browserProcess = null
    }
  }

  isRunning(): boolean {
    return this.browserProcess !== null && !this.browserProcess.killed
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

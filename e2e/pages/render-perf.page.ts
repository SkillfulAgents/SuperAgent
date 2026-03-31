import { Page } from '@playwright/test'

interface RenderEntry {
  count: number
  timestamps: number[]
}

/**
 * Page object for measuring React component re-renders during E2E tests.
 * Requires the app to be running with RENDER_TRACKING=true.
 *
 * Note: React.StrictMode double-invokes renders in dev mode,
 * so counts will be ~2x the "real" count. This is consistent
 * and fine for comparison between test runs.
 */
export class RenderPerfPage {
  private wdyrLogs: string[] = []

  constructor(private page: Page) {
    // Capture why-did-you-render console output
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('whyDidYouRender') || text.includes('Re-rendered because') || text.includes('unnecessary rerender')) {
        this.wdyrLogs.push(text)
      }
    })
  }

  /** Check if render tracking is available on the page */
  async isAvailable(): Promise<boolean> {
    return await this.page.evaluate(() => typeof window.__RENDER_DATA__ !== 'undefined')
  }

  /** Reset all render counters */
  async resetCounters() {
    this.wdyrLogs = []
    await this.page.evaluate(() => window.__RENDER_DATA__?.reset())
  }

  /** Get render count for a specific component */
  async getRenderCount(componentName: string): Promise<number> {
    return await this.page.evaluate(
      (name) => window.__RENDER_DATA__?.get(name)?.count ?? 0,
      componentName
    )
  }

  /** Get all render data without resetting */
  async getAllRenderData(): Promise<Record<string, RenderEntry>> {
    return await this.page.evaluate(() => window.__RENDER_DATA__?.getAll() ?? {})
  }

  /** Get all render data and reset counters (for measuring a specific window) */
  async snapshot(): Promise<Record<string, RenderEntry>> {
    return await this.page.evaluate(() => window.__RENDER_DATA__?.snapshot() ?? {})
  }

  /** Get captured why-did-you-render logs */
  getWdyrLogs(): string[] {
    return [...this.wdyrLogs]
  }

  /** Clear captured WDYR logs */
  clearWdyrLogs() {
    this.wdyrLogs = []
  }

  /** Format render data as a readable report */
  formatReport(data: Record<string, RenderEntry>): string {
    const lines = Object.entries(data)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, entry]) => `  ${name}: ${entry.count} renders`)
    return lines.length > 0 ? lines.join('\n') : '  (no renders recorded)'
  }
}

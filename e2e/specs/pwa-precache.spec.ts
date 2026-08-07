import { test, expect, type Page } from '@playwright/test'

/**
 * PWA service-worker suite — runs ONLY under playwright.pwa.config.ts, against
 * a production `vite build` served by the real web server. The SW does not
 * exist in dev builds, so the main (dev-server) configs ignore this spec.
 *
 * Validation strategy, and why it's shaped this way: Playwright's
 * `context.setOffline` reliably cuts the PAGE's network but is not guaranteed
 * to reach the service worker's own target. Workbox's precache strategy is
 * strictly cache-first, so instead of trusting network emulation alone we
 * assert the three links of the chain directly:
 *   1. the precache CONTAINS every boot asset plus the not-yet-visited chunks
 *      (enumerated straight out of CacheStorage),
 *   2. with the page network dead (proven by a negative control: /api fetches
 *      fail), a never-visited lazy surface still renders — its chunks can only
 *      have come from the SW cache asserted in (1),
 *   3. an offline document reload is answered by the SW's navigateFallback
 *      with the precached app shell.
 */

async function waitForActiveServiceWorker(page: Page) {
  // Workbox populates the precache during `install`, so an ACTIVE registration
  // implies precaching completed, and clientsClaim controls the first page
  // without a reload. Polled via page.evaluate — NOT page.waitForFunction,
  // whose predicate must be synchronous: an async predicate returns a Promise
  // object, which is truthy, so the wait would resolve instantly mid-install.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration()
          return !!reg?.active && !!navigator.serviceWorker.controller
        }),
      { timeout: 30000, message: 'service worker never became active and controlling' },
    )
    .toBe(true)
}

async function precachedPaths(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const names = (await caches.keys()).filter((k) => k.includes('precache'))
    const paths: string[] = []
    for (const name of names) {
      const cache = await caches.open(name)
      for (const req of await cache.keys()) {
        paths.push(new URL(req.url).pathname)
      }
    }
    return paths
  })
}

test.describe('PWA precaching service worker', () => {
  test('registers, and precaches the full UI beyond the boot graph', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="settings-button"]')).toBeVisible()
    await waitForActiveServiceWorker(page)

    const precached = await precachedPaths(page)
    const precachedJs = precached.filter((p) => p.startsWith('/assets/') && p.endsWith('.js'))

    // The app shell itself is precached (what navigateFallback serves offline).
    expect(precached).toContain('/index.html')

    // Every hashed asset the page loaded at boot is in the precache…
    const bootAssets = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => new URL(e.name).pathname)
        .filter((p) => p.startsWith('/assets/')),
    )
    expect(bootAssets.length).toBeGreaterThan(0)
    for (const asset of bootAssets) {
      expect(precached).toContain(asset)
    }

    // …and the precache is strictly BIGGER than the boot graph: the lazy route
    // chunks (settings, agent shell, wizard, search, …) are already local even
    // though no navigation has happened. This is the "preload all the UI"
    // guarantee — without the SW, only visited surfaces would ever be cached.
    const bootJs = new Set(bootAssets.filter((p) => p.endsWith('.js')))
    expect(precachedJs.length).toBeGreaterThan(bootJs.size)
  })

  test('a never-visited lazy surface renders with the page network dead', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="settings-button"]')).toBeVisible()
    await waitForActiveServiceWorker(page)

    // Sanity: the settings chunks really are pending (not fetched at boot) —
    // otherwise this test would prove nothing about the precache.
    const bootAssets = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname),
    )
    const precached = await precachedPaths(page)
    const unfetched = precached.filter(
      (p) => p.startsWith('/assets/') && p.endsWith('.js') && !bootAssets.includes(p),
    )
    expect(unfetched.length).toBeGreaterThan(0)

    await context.setOffline(true)

    // Negative control proving the page's network is actually severed: /api is
    // never SW-cached (no runtime caching + navigateFallbackDenylist), so this
    // must fail. If it succeeds, offline emulation isn't working and the
    // positive assertions below would be meaningless.
    const apiResult = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/settings')
        return `unexpected response: ${res.status} ${res.headers.get('content-type') ?? ''}`
      } catch {
        return 'network-error'
      }
    })
    expect(apiResult).toBe('network-error')

    // In-app navigation to Settings — never visited in this session, so its
    // route chunk AND the active tab's chunk both resolve now, offline.
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-general"]')).toBeVisible()
    // The lazy tab boundary resolved: its Suspense skeleton is gone, meaning
    // the tab's chunk executed (data fetches may fail — that's fine, the UI
    // shell must come up).
    await expect(page.locator('[role="status"][aria-label="Loading settings section"]')).toHaveCount(0)

    await context.setOffline(false)
  })

  test('an offline document reload is served the app shell by the SW', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="settings-button"]')).toBeVisible()
    await waitForActiveServiceWorker(page)

    await context.setOffline(true)
    const response = await page.reload()
    // The navigation was answered (navigateFallback → precached index.html)
    // rather than failing with a network error.
    expect(response, 'offline reload should be answered by the service worker').not.toBeNull()
    await expect(page).toHaveTitle('Gamut')
    // The boot JS executed from the precache — React mounted into #root.
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0)

    await context.setOffline(false)
  })

  test('control: without the SW, offline navigation to an unvisited surface fails', async ({ browser }) => {
    // Same build, service worker suppressed. This is the proof the suite isn't
    // vacuous: if offline navigation succeeded here too, the positive tests
    // above would be asserting nothing about the precache.
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    try {
      await page.goto(`http://localhost:${process.env.E2E_PORT ?? process.env.PORT ?? '3004'}/`)
      await expect(page.locator('[data-testid="settings-button"]')).toBeVisible()
      const cacheNames = await page.evaluate(() => caches.keys())
      expect(cacheNames).toEqual([])

      await context.setOffline(true)
      // The settings chunk fetch has nothing to fall back on: wait for that
      // exact failure, then assert the shell never came up. (The stale-chunk
      // recovery attempts a reload, which also fails offline.)
      const chunkFailure = page.waitForEvent('requestfailed', {
        predicate: (r) => r.url().includes('/assets/'),
        timeout: 10000,
      })
      await page.locator('[data-testid="settings-button"]').click()
      await chunkFailure
      await expect(page.locator('[data-testid="global-settings-page"]')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('API responses are never served from SW caches', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="settings-button"]')).toBeVisible()
    await waitForActiveServiceWorker(page)

    // Exercise an API call THROUGH the controlled page, then check every cache:
    // nothing under /api may ever be stored — stale agent/session/settings data
    // (or a cached SSE handshake) would be far worse than no offline support.
    await page.evaluate(async () => {
      await fetch('/api/settings')
    })
    const cachedApiPaths = await page.evaluate(async () => {
      const paths: string[] = []
      for (const name of await caches.keys()) {
        const cache = await caches.open(name)
        for (const req of await cache.keys()) {
          const p = new URL(req.url).pathname
          if (p.startsWith('/api/')) paths.push(p)
        }
      }
      return paths
    })
    expect(cachedApiPaths).toEqual([])
  })
})

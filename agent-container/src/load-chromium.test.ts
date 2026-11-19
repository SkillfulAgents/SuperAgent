import { expect, it, vi } from 'vitest'

const playwright = vi.hoisted(() => ({ loads: 0 }))
vi.mock('playwright-core', () => {
  playwright.loads += 1
  return { chromium: { connectOverCDP: vi.fn(), launchServer: vi.fn(), connect: vi.fn() } }
})

it('loads playwright-core when a browser task first needs it, not when its modules are imported (SUP-1639)', async () => {
  await import('./browser-download')
  await import('./browser-upload')
  await import('./rasterize-html')
  expect(playwright.loads).toBe(0)

  const { loadChromium } = await import('./load-chromium')
  const chromium = await loadChromium()

  expect(playwright.loads).toBe(1)
  expect(chromium).toBe((await loadChromium()))
  expect(playwright.loads).toBe(1)
})

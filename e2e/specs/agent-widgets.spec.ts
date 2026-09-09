import { test, expect, type APIRequestContext } from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createAgent, createSession, listSessions, uniqueName, waitForSessionIdle } from '../helpers/agents'

/**
 * Agent widgets: an artifact that exposes a widget (a `gamut.widget` block +
 * widget.html) shows up as a sandboxed card on Agent Home and as a tile on
 * App Home, stands in for its own dashboard's screenshot when the artifact
 * also has a server, and gets refreshed exactly when Agent Home loads —
 * never by App Home. The mock container "runs" a refresh by writing
 * snapshots/snapshot.json, which is what the host reads back.
 */

interface ApiWidget {
  slug: string
  hasDashboard: boolean
  isStale: boolean
  refreshing: boolean
  generatedAt: string | null
  validUntil: string | null
  htmlHash: string | null
  lastError: string | null
}

function workspaceDir(agentSlug: string): string {
  const dataDir = process.env.SUPERAGENT_DATA_DIR
  if (!dataDir) throw new Error('SUPERAGENT_DATA_DIR is required for widget seeding')
  return path.join(dataDir, 'agents', agentSlug, 'workspace')
}

function artifactsDir(agentSlug: string): string {
  return path.join(workspaceDir(agentSlug), 'artifacts')
}

/** Session metadata is where automated provenance lands; repair sessions live here. */
function readSessionMetadata(agentSlug: string): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspaceDir(agentSlug), 'session-metadata.json'), 'utf-8'))
  } catch {
    return {}
  }
}

const WIDGET_HTML = `<!DOCTYPE html><html><head><style>
  :root { --bg: #fff; --fg: #111; }
  :root[data-theme="dark"] { --bg: #111; --fg: #eee; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui; }
</style></head><body><div data-testid="widget-value">1,820 kcal</div></body></html>`

function seedArtifact(
  agentSlug: string,
  slug: string,
  opts: {
    widget?: { size?: 'small' | 'medium'; refreshOnTurnEnd?: boolean } | false
    dashboard?: boolean
    withScript?: boolean
    validUntil?: string | null
    html?: string
    /** Pre-write a snapshot matching the seeded HTML, so the widget starts fresh. */
    freshSnapshot?: boolean
  } = {},
): string {
  const dir = path.join(artifactsDir(agentSlug), slug)
  fs.mkdirSync(dir, { recursive: true })
  const withScript = opts.widget !== false && (opts.withScript ?? true)
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: `Artifact ${slug}`,
      description: 'seeded by e2e',
      // Each half is a named script: `bun run start`, `bun run widget`.
      ...(opts.dashboard || withScript
        ? {
            scripts: {
              ...(opts.dashboard ? { start: 'bun run index.js' } : {}),
              ...(withScript ? { widget: 'bun run widget.ts' } : {}),
            },
          }
        : {}),
      ...(opts.widget === false
        ? {}
        : {
            gamut: {
              widget: {
                size: opts.widget?.size ?? 'small',
                ...(opts.widget?.refreshOnTurnEnd ? { refreshOnTurnEnd: true } : {}),
              },
            },
          }),
    }),
  )
  if (opts.widget !== false) {
    const html = opts.html ?? WIDGET_HTML
    fs.writeFileSync(path.join(dir, 'widget.html'), html)
    if (withScript) fs.writeFileSync(path.join(dir, 'widget.ts'), '// stub')
    if (opts.validUntil !== undefined) {
      fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ validUntil: opts.validUntil }))
    }
    if (opts.freshSnapshot) {
      fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'snapshots', 'snapshot.json'),
        JSON.stringify({
          generatedAt: '2026-01-01T00:00:00.000Z',
          validUntil: '2999-01-01T00:00:00.000Z',
          validityDefaulted: false,
          htmlHash: createHash('sha256').update(html).digest('hex').slice(0, 16),
          renderedSizes: [],
          scriptRan: true,
          durationMs: 1,
          lastError: null,
        }),
      )
    }
  }
  return dir
}

async function listWidgets(request: APIRequestContext, agentSlug: string): Promise<ApiWidget[]> {
  const response = await request.get(`/api/agents/${agentSlug}/widgets`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()) as ApiWidget[]
}

test.describe('agent widgets', () => {
  test('authored markup cannot swallow the widget CSP or override the requested theme', async ({
    page,
    request,
  }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Widget CSP'))
    const probeUrl = 'https://widget-csp.invalid/probe.svg'
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    let networkRequests = 0
    await page.route(probeUrl, async (route) => {
      networkRequests++
      await route.fulfill({ contentType: 'image/svg+xml', body: svg })
    })
    seedArtifact(agent.slug, 'policy', {
      withScript: false,
      freshSnapshot: true,
      html: `<!DOCTYPE html><!-- Widget styles belong in <head>. -->
        <html lang="en" data-theme="authored"><head>
          <meta http-equiv="Content-Security-Policy" content="default-src * data: 'unsafe-inline'">
          <title>Widget policy</title><style>body { color: rgb(1, 2, 3); }</style>
        </head><body><p data-testid="widget-value">value</p>
          <img data-testid="remote-image" src="${probeUrl}" alt="remote">
          <img data-testid="inline-image" src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="inline">
        </body></html>`,
    })

    await page.goto(`/agents/${agent.slug}`)
    const frame = page.frameLocator('[data-testid="widget-card-policy"] iframe')
    await expect(frame.getByTestId('widget-value')).toHaveText('value')
    await expect(frame.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/)
    await expect(frame.locator('html')).toHaveAttribute('lang', 'en')
    await expect(frame.locator('head > meta').first()).toHaveAttribute('content', /^default-src 'none';/)
    await expect(frame.locator('head > meta')).toHaveCount(2)
    await expect(frame.locator('body')).toHaveCSS('color', 'rgb(1, 2, 3)')
    await expect(frame.getByTestId('inline-image')).toHaveJSProperty('naturalWidth', 1)
    await expect(frame.getByTestId('remote-image')).toHaveJSProperty('complete', true)
    await expect(frame.getByTestId('remote-image')).toHaveJSProperty('naturalWidth', 0)
    expect(networkRequests).toBe(0)
  })

  test('Agent Home shows the snapshot in a sandboxed frame and triggers the stale refresh', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(60_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Widget Agent'))
    // The script "decides" validity: a seeded widget.json stands in for its output.
    seedArtifact(agent.slug, 'daily-macros', { validUntil: '2999-01-01T09:00:00.000Z' })

    // Cold read: no snapshot yet → stale, nothing in flight, but the HTML is servable.
    const before = await listWidgets(request, agent.slug)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ slug: 'daily-macros', hasDashboard: false, isStale: true, refreshing: false, generatedAt: null })

    const html = await request.get(`/api/agents/${agent.slug}/artifacts/daily-macros/widget/html?scheme=dark`)
    expect(html.ok()).toBeTruthy()
    expect(html.headers()['content-security-policy']).toContain("default-src 'none'")
    expect(await html.text()).toContain('<html data-theme="dark">')

    await page.goto(`/agents/${agent.slug}`)
    const card = page.getByTestId('widget-card-daily-macros')
    await expect(card).toBeVisible({ timeout: 15_000 })

    const frame = card.locator('iframe')
    await expect(frame).toHaveAttribute('sandbox', '')
    // Inlined, not framed by URL: the renderer and the API share an origin on
    // the web but not in either Electron build, where the document's own
    // frame-ancestors would block the frame. The policy rides along in a meta.
    await expect(frame).not.toHaveAttribute('src', /./)
    await expect(frame).toHaveAttribute('srcdoc', /http-equiv="Content-Security-Policy"/)
    await expect(page.frameLocator('[data-testid="widget-card-daily-macros"] iframe').getByTestId('widget-value'))
      .toHaveText('1,820 kcal')

    // Mounting Agent Home is the refresh trigger: the mock container writes
    // snapshot.json with the script's validUntil, the SSE event lands, and the
    // API now reports fresh.
    await expect
      .poll(async () => (await listWidgets(request, agent.slug))[0], { timeout: 15_000 })
      .toMatchObject({ isStale: false, refreshing: false, lastError: null, validUntil: '2999-01-01T09:00:00.000Z' })
    expect(fs.existsSync(path.join(artifactsDir(agent.slug), 'daily-macros', 'snapshots', 'snapshot.json'))).toBe(true)
    await expect(card.getByTestId('widget-refreshing')).toHaveCount(0)

    // The PNG family is rasterized by the real container only; the mock renders none.
    const png = await request.get(`/api/agents/${agent.slug}/artifacts/daily-macros/widget/snapshot?family=small&scale=2&scheme=light`)
    expect(png.status()).toBe(404)
  })

  test('App Home tiles the widget, shows it in place of its own dashboard, and never refreshes', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(60_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Widget Board'))
    // One artifact that is both a dashboard and a widget, one plain dashboard.
    seedArtifact(agent.slug, 'nutrition', { dashboard: true, widget: { size: 'medium' } })
    seedArtifact(agent.slug, 'other-dash', { dashboard: true, widget: false })

    await expect
      .poll(async () => {
        const agents = (await (await request.get('/api/agents')).json()) as Array<{
          slug: string
          widgets?: Array<{ slug: string; hasDashboard: boolean }>
          dashboards?: Array<{ slug: string }>
        }>
        const me = agents.find((candidate) => candidate.slug === agent.slug)
        return `${me?.widgets?.map((w) => `${w.slug}:${w.hasDashboard}`).join(',')}|${me?.dashboards?.map((d) => d.slug).sort().join(',')}`
      })
      .toBe('nutrition:true|nutrition,other-dash')

    // Every widget refresh request the page makes from here on — there must be none.
    const refreshRequests: string[] = []
    page.on('request', (req) => {
      if (/\/widgets\/refresh-stale$|\/widget\/refresh$/.test(req.url())) refreshRequests.push(req.url())
    })

    await page.goto('/')
    // The artifact has ONE tile, keyed like any dashboard tile, rendered as its widget.
    const tile = page.locator(`[data-widget-id="dash::${agent.slug}::nutrition"]`)
    await expect(tile).toBeVisible({ timeout: 15_000 })
    await expect(tile.getByTestId('widget-card-nutrition')).toBeVisible()
    await expect(tile.locator('img')).toHaveCount(0)
    // The plain dashboard keeps its screenshot tile.
    const otherDashTile = page.locator(`[data-widget-id="dash::${agent.slug}::other-dash"]`)
    await expect(otherDashTile).toBeVisible()
    await expect(otherDashTile.getByRole('link', { name: 'Open app' })).toBeVisible()

    // A medium widget takes the wide footprint by default — the same width
    // as the agent card (Wide), not the dashboard tile (Small).
    const agentTile = page.locator(`[data-widget-id="${agent.slug}"]`)
    await expect(agentTile).toBeVisible()
    const [widgetBox, agentBox, dashBox] = await Promise.all([
      tile.boundingBox(),
      agentTile.boundingBox(),
      otherDashTile.boundingBox(),
    ])
    expect(Math.round(widgetBox!.width)).toBe(Math.round(agentBox!.width))
    expect(widgetBox!.width).toBeGreaterThan(dashBox!.width * 1.5)

    // The card opens its own dashboard and stays a grid drag surface.
    const link = tile.getByRole('link', { name: 'Open Artifact nutrition' })
    await expect(link).toHaveAttribute('href', new RegExp(`/agents/${agent.slug}/dashboards/nutrition$`))
    await expect(link).toHaveAttribute('data-widget-drag-surface')
    await expect(link).toHaveAttribute('draggable', 'false')

    // App Home is display-only. The hover affordances appearing proves the
    // card is fully interactive; by then Agent Home would long have fired its
    // trigger — here nothing did, and the widget is still stale on disk.
    await tile.hover()
    await expect(tile.getByRole('button', { name: 'Refresh Artifact nutrition' })).toBeVisible()
    expect(refreshRequests).toEqual([])
    expect((await listWidgets(request, agent.slug))[0]).toMatchObject({ isStale: true, refreshing: false })
    expect(fs.existsSync(path.join(artifactsDir(agent.slug), 'nutrition', 'snapshots', 'snapshot.json'))).toBe(false)
  })

  test('a failed refresh keeps the previous snapshot, surfaces the error, and asks the agent to fix it', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Widget Fail'))
    const dir = seedArtifact(agent.slug, 'broken')
    fs.writeFileSync(path.join(dir, 'widget.mock-fail'), '')

    await page.goto(`/agents/${agent.slug}`)
    const card = page.getByTestId('widget-card-broken')
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card.getByTestId('widget-error')).toBeVisible({ timeout: 15_000 })
    await expect(card.getByTestId('widget-error')).toHaveAttribute('title', /mock failure/)
    // The old HTML still serves.
    await expect(page.frameLocator('[data-testid="widget-card-broken"] iframe').getByTestId('widget-value'))
      .toHaveText('1,820 kcal')
    expect((await listWidgets(request, agent.slug))[0].lastError).toMatch(/mock failure/)

    // The script is the agent's own code and no turn would notice it broke, so
    // the platform opens an automated session asking the agent to fix it.
    await expect
      .poll(() => Object.values(readSessionMetadata(agent.slug)).filter((m) => m.isWidgetRepair === true).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const [repairSessionId, repairMeta] = Object.entries(readSessionMetadata(agent.slug)).find(
      ([, meta]) => meta.isWidgetRepair === true,
    )!
    expect(repairMeta).toMatchObject({ widgetRepairSlug: 'broken', name: 'Invoked to fix widget' })

    // Automated: hidden from the session list like a cron or webhook run.
    const visible = await listSessions(request, agent)
    expect(visible.map((s) => s.id)).not.toContain(repairSessionId)

    // A widget that stays broken must not open a session per refresh.
    await request.post(`/api/agents/${agent.slug}/artifacts/broken/widget/refresh`)
    await expect
      .poll(() => Object.values(readSessionMetadata(agent.slug)).filter((m) => m.isWidgetRepair === true).length, {
        timeout: 10_000,
      })
      .toBe(1)

    // Even an agent with no x-agent calls exposes repairs through the history
    // entry, without a reload or adding them to the normal session list.
    const historyEntry = page.getByTestId('home-trigger-row-inbound-x-agent')
    await expect(historyEntry).toBeVisible({ timeout: 15_000 })
    await historyEntry.click()
    await expect(page).toHaveURL(`/agents/${agent.slug}/called-from-agents`)
    const repairRow = page.getByRole('button', { name: 'Open widget repair for broken' })
    await expect(repairRow).toContainText('Invoked to fix widget')
    await repairRow.click()
    await expect(page).toHaveURL(`/agents/${agent.slug}/sessions/${repairSessionId}`)
    await expect(page.getByTestId('widget-repair-session-banner')).toContainText('Invoked to fix widget: broken')
    await expect(page.getByText(/The refresh script for the widget in/)).toBeVisible()
    await expect(page.getByTestId('session-breadcrumb')).toContainText('Invoked to fix widget')
    await page.getByTestId('widget-repair-session-back-button').click()
    await expect(repairRow).toBeVisible()
    await repairRow.click()
    await page.getByTestId('inbound-x-agent-breadcrumb').click()
    await expect(repairRow).toBeVisible()
  })

  test('a widget marked refreshOnTurnEnd re-renders after a turn; the others wait until they are stale', async ({
    request,
  }, testInfo) => {
    test.setTimeout(90_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Widget Turn'))
    // Both start fresh, so only the manifest opt-in can explain a re-render.
    seedArtifact(agent.slug, 'every-turn', { widget: { refreshOnTurnEnd: true }, freshSnapshot: true })
    seedArtifact(agent.slug, 'on-demand', { freshSnapshot: true })

    const before = (await listWidgets(request, agent.slug)).sort((a, b) => a.slug.localeCompare(b.slug))
    expect(before.map((w) => `${w.slug}:${w.isStale}`)).toEqual(['every-turn:false', 'on-demand:false'])
    const generatedBefore = new Map(before.map((w) => [w.slug, w.generatedAt]))

    const session = await createSession(request, agent, 'Say hello and stop.')
    await waitForSessionIdle(request, agent, session)

    // The after-run sweep re-renders the opted-in widget only.
    await expect
      .poll(
        async () => {
          const widgets = (await listWidgets(request, agent.slug)).sort((a, b) => a.slug.localeCompare(b.slug))
          return widgets.map((w) => `${w.slug}:${w.generatedAt === generatedBefore.get(w.slug) ? 'same' : 'new'}`)
        },
        { timeout: 30_000 },
      )
      .toEqual(['every-turn:new', 'on-demand:same'])
  })
})

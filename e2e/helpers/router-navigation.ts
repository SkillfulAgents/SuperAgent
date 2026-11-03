import { expect, type APIRequestContext, type Page, type Route } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

export interface RouterNavigationContext {
  page: Page
  request: APIRequestContext
  apiBaseUrl: string
  navigate: (route: string) => Promise<unknown>
  runtime?: 'web' | 'electron'
}

const agentSchema = z.object({ slug: z.string(), displaySlug: z.string(), name: z.string() })
const sessionSchema = z.object({ id: z.string() })

function routeLocation(page: Page) {
  const url = parseUrl(page.url())
  return url.hash.startsWith('#/') ? url.hash.slice(1) : `${url.pathname}${url.search}`
}

function parseUrl(value: string) {
  try {
    return new URL(value, 'http://router.test')
  } catch (error) {
    throw new Error(`Unexpected navigation URL: ${value}`, { cause: error })
  }
}

async function createAgent(context: RouterNavigationContext, label: string) {
  // Like navigation.spec.ts, leave fixture removal to isolated-server teardown:
  // deleting workspaces mid-suite races sibling tests' roster/session scans.
  const response = await context.request.post(`${context.apiBaseUrl}/api/agents`, { data: { name: `${label} ${randomUUID()}` } })
  expect(response.status()).toBe(201)
  return agentSchema.parse(await response.json())
}

async function expectAgentRoute(page: Page, agent: z.infer<typeof agentSchema>, suffix = '') {
  // Cold links accept the immutable id; UI links use the current display slug.
  const paths = [agent.slug, agent.displaySlug].map(slug => `/agents/${slug}${suffix}`)
  await expect.poll(() => paths.includes(routeLocation(page))).toBe(true)
}

async function expectAgentHome(page: Page, agent: z.infer<typeof agentSchema>) {
  await expect(page.getByTestId('agent-breadcrumb')).toHaveText(agent.name)
  await expect(page.getByTestId('home-message-input')).toBeVisible()
  await expectAgentRoute(page, agent)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Agent reads fail until Retry; the recovery uses the real persisted agent. */
export async function checkAgentLoaderRetry(context: RouterNavigationContext) {
  const { page, navigate } = context
  const agent = await createAgent(context, 'Router retry')
  let failures = 0
  let failing = true
  const endpoint = new RegExp(`/api/agents/(?:${agent.slug}|${agent.displaySlug})$`)
  const handler = async (route: Route) => {
    if (failing) {
      failures++
      await route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': route.request().headers().origin ?? '*' },
        json: { error: 'Temporary router validation failure' },
      })
    } else await route.continue()
  }
  await page.route(endpoint, handler)
  try {
    await navigate(`/agents/${agent.slug}/api-logs`)
    await expect(page.getByTestId('agent-load-error')).toBeVisible()
    await expect(page.getByTestId('agent-not-found')).toHaveCount(0)
    await expect(page.getByTestId('app-sidebar')).toBeVisible()
    failing = false
    await page.getByTestId('agent-load-error').getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(agent.name)
    await expect(page.getByTestId('api-logs-back-button')).toBeVisible()
    await expect(page.getByTestId('agent-load-error')).toHaveCount(0)
    expect(failures).toBeGreaterThan(0)
    await page.getByTestId('api-logs-back-button').click()
    await expectAgentHome(page, agent)
  } finally {
    await page.unroute(endpoint, handler)
  }
}

// React's development error reporting surfaces the deliberately thrown loader
// error even though AgentLoadError catches it and Retry recovers successfully.
// No other scenario, including an obsolete rejected loader, may report it.
export function isExpectedRouterScenarioError(scenario: (context: RouterNavigationContext) => Promise<void>, message: string) {
  return scenario === checkAgentLoaderRetry && message === 'HTTP 503'
}

/** A pending loader finishing after another navigation must never replace it. */
export async function checkSupersededAgentLoader(context: RouterNavigationContext, outcome: 'success' | 'error') {
  const { page, navigate } = context
  const slow = await createAgent(context, `Router slow ${outcome}`)
  const destination = await createAgent(context, 'Router destination')
  const entered = deferred()
  const release = deferred()
  const finished = deferred()
  const endpoint = new RegExp(`/api/agents/(?:${slow.slug}|${slow.displaySlug})$`)
  const handler = async (route: Route) => {
    const response = await route.fetch()
    entered.resolve()
    await release.promise
    try {
      if (outcome === 'success') await route.fulfill({ response })
      else await route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': route.request().headers().origin ?? '*' },
        json: { error: 'Late obsolete loader error' },
      })
    } finally {
      finished.resolve()
    }
  }
  await page.route(endpoint, handler, { times: 1 })
  try {
    await navigate('/')
    await new AppPage(page).waitForAgentsLoaded()
    const agents = new AgentPage(page)
    await agents.selectAgent(slow.name)
    await entered.promise
    await agents.selectAgent(destination.name)
    await expectAgentHome(page, destination)
    release.resolve()
    await finished.promise

    // Exercise another real lazy route after the late response is delivered,
    // rather than checking the destination before the old loader settles.
    await page.getByTestId('home-api-logs-open-page').click()
    await expect(page.getByTestId('api-logs-back-button')).toBeVisible()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(destination.name)
    await page.getByTestId('api-logs-back-button').click()
    await expectAgentHome(page, destination)
    await expect(page.getByTestId('agent-load-error')).toHaveCount(0)
    await expect(page.getByTestId('agent-not-found')).toHaveCount(0)
  } finally {
    release.resolve()
    await page.unroute(endpoint, handler)
  }
}

export async function checkLazySessionDraftHistory(context: RouterNavigationContext) {
  const { page, request, apiBaseUrl, navigate } = context
  const agent = await createAgent(context, 'Router draft')
  const firstMessage = 'Original persisted router validation message'
  const response = await request.post(`${apiBaseUrl}/api/agents/${agent.slug}/sessions`, { data: { message: firstMessage } })
  expect(response.ok()).toBe(true)
  const session = sessionSchema.parse(await response.json())
  const sessionRoute = `/agents/${agent.slug}/sessions/${session.id}`
  await navigate(sessionRoute)
  const sessionPage = new SessionPage(page)
  await sessionPage.expectUserMessage(firstMessage)
  await sessionPage.waitForInputEnabled()
  const draft = `Unsent session draft ${randomUUID()}`
  const homeDraft = `Independent agent-home draft ${randomUUID()}`
  await page.getByTestId('message-input').fill(draft)
  await page.getByTestId('agent-breadcrumb').click()
  await expectAgentHome(page, agent)
  await page.getByTestId('home-message-input').fill(homeDraft)
  await page.getByTestId('home-api-logs-open-page').click()
  await expect(page.getByTestId('api-logs-back-button')).toBeVisible()
  await page.getByTestId('api-logs-back-button').click()
  await expect(page.getByTestId('home-message-input')).toHaveText(homeDraft)

  await new AgentPage(page).expandAgent(agent.name)
  await page.getByTestId(`session-item-${session.id}`).click()
  await expect(page.getByTestId('message-input')).toHaveText(draft)
  await sessionPage.expectUserMessage(firstMessage)
  await page.goBack()
  await expect(page.getByTestId('home-message-input')).toHaveText(homeDraft)
  await page.goForward()
  await expectAgentRoute(page, agent, `/sessions/${session.id}`)
  await expect(page.getByTestId('message-input')).toHaveText(draft)

  // The restored composer remains functional, and its sent draft survives a
  // fresh document load through the real persisted session API.
  await sessionPage.sendMessage(draft)
  await sessionPage.expectUserMessage(draft, 1)
  await sessionPage.waitForInputEnabled()
  await page.reload()
  await expectAgentRoute(page, agent, `/sessions/${session.id}`)
  await sessionPage.expectUserMessage(firstMessage)
  await sessionPage.expectUserMessage(draft, 1)
  await expect(page.getByTestId('message-input')).toHaveText('')
}

export async function checkDeepLinksSearchAndNotFound(context: RouterNavigationContext) {
  const { page, navigate } = context
  const agent = await createAgent(context, 'Router deep link')
  const target = `/agents/${agent.slug}/api-logs`
  // Unknown tabs normalize to settings while retaining the validated close
  // target. Switching lazy panes must carry the same search through history.
  await navigate(`/settings/unknown-upgrade-tab?from=${encodeURIComponent(target)}`)
  await expect(page.getByTestId('global-settings-page')).toBeVisible()
  await expect.poll(() => parseUrl(routeLocation(page)).searchParams.get('from')).toBe(target)
  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('settings-nav-general')).toHaveAttribute('data-active', 'true')
  await page.getByTestId('settings-nav-voice').click()
  await expect(page.getByTestId('settings-nav-voice')).toHaveAttribute('data-active', 'true')
  await page.goBack()
  await expect(page.getByTestId('settings-nav-general')).toHaveAttribute('data-active', 'true')
  await page.goForward()
  await expect(page.getByTestId('settings-nav-voice')).toHaveAttribute('data-active', 'true')
  await page.reload()
  await expect(page.getByTestId('settings-nav-voice')).toHaveAttribute('data-active', 'true')
  await expect.poll(() => parseUrl(routeLocation(page)).searchParams.get('from')).toBe(target)
  await page.getByTestId('settings-back').click()
  await expect.poll(() => routeLocation(page)).toBe(target)
  await expect(page.getByTestId('agent-breadcrumb')).toHaveText(agent.name)
  await expect(page.getByTestId('api-logs-back-button')).toBeVisible()

  await navigate(`/agents/${agent.slug}/sessions/unknown-upgrade-session`)
  await expect(page.getByTestId('session-not-found')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Back to agent', exact: true }).click()
  await expectAgentHome(page, agent)
  await navigate('/agents/unknown-upgrade-agent')
  await expect(page.getByTestId('agent-not-found')).toBeVisible()
  await page.getByRole('link', { name: 'Back to home', exact: true }).click()
  await expect(page.getByTestId('home-button')).toHaveAttribute('data-active', 'true')
  await navigate('/unknown-upgrade-page')
  await expect(page.getByTestId('route-not-found')).toBeVisible()
  await page.getByRole('link', { name: 'Back to home', exact: true }).click()
  await expect.poll(() => routeLocation(page)).toBe('/')
}

export async function checkAppLinkModifiers(context: RouterNavigationContext) {
  const { page, navigate, runtime = 'web' } = context
  await navigate('/')
  await new AppPage(page).waitForAgentsLoaded()
  const link = page.getByTestId('notifications-button')
  await expect(link).toHaveAttribute('href', runtime === 'electron' ? /#\/notifications$/ : '/notifications')
  if (runtime === 'electron') {
    // file:// has no useful new tab. AppLink intercepts modified clicks into
    // this window while leaving the actual file URL pinned to index.html.
    for (const modifier of ['Control', 'Meta', 'Shift'] as const) {
      const documentUrl = page.url().split('#')[0]
      const pageCount = page.context().pages().length
      await link.click({ modifiers: [modifier] })
      await expect.poll(() => routeLocation(page)).toBe('/notifications')
      await expect(page.getByTestId('notifications-back-button')).toBeVisible()
      expect(page.url().split('#')[0]).toBe(documentUrl)
      expect(page.context().pages()).toHaveLength(pageCount)
      await page.getByTestId('home-button').click()
      await expect.poll(() => routeLocation(page)).toBe('/')
    }
  } else {
    for (const gesture of [{ modifiers: ['ControlOrMeta' as const] }, { button: 'middle' as const }]) {
      // Browser-native modifier/middle tabs can have no opener, so observe the
      // context's new page rather than only window.open-style popup events.
      const popupPromise = page.context().waitForEvent('page')
      await link.click(gesture)
      const popup = await popupPromise
      try {
        await expect(popup.getByTestId('notifications-back-button')).toBeVisible()
        expect(parseUrl(popup.url()).pathname).toBe('/notifications')
        expect(routeLocation(page)).toBe('/')
        await expect(page.getByTestId('home-button')).toHaveAttribute('data-active', 'true')
      } finally {
        await popup.close()
      }
    }
  }
  // The ordinary click path and the header's history controls remain live.
  await link.click()
  await expect(page.getByTestId('notifications-button')).toHaveAttribute('data-active', 'true')
  if (runtime === 'electron') await page.getByTestId('history-back-button').click()
  else await page.goBack()
  await expect.poll(() => routeLocation(page)).toBe('/')
  if (runtime === 'electron') await page.getByTestId('history-forward-button').click()
  else await page.goForward()
  await expect.poll(() => routeLocation(page)).toBe('/notifications')
}

export const routerNavigationScenarios = [
  ['a failed agent loader recovers through Retry without reloading', checkAgentLoaderRetry],
  ['a late successful loader cannot replace the next agent', (context: RouterNavigationContext) => checkSupersededAgentLoader(context, 'success')],
  ['a late failed loader cannot replace the next agent', (context: RouterNavigationContext) => checkSupersededAgentLoader(context, 'error')],
  ['lazy route revisits and back/forward preserve independent composer drafts', checkLazySessionDraftHistory],
  ['deep links retain search across redirects, reload and history, and 404s recover', checkDeepLinksSearchAndNotFound],
  ['AppLink modifiers and ordinary history navigation use the intended window', checkAppLinkModifiers],
] as const

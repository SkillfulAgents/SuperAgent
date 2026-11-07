/**
 * Agent-to-agent requests in team mode: only someone who is a User or Owner
 * of both agents can allow one. Anyone who uses the calling agent can deny it.
 *
 * Olivia owns Alpha and Beta. Uma is a User of Alpha. Vic is a Viewer of Alpha.
 *
 * The mock runtime has no tool loop that makes a real cross-agent call, so the spec
 * reads Alpha's proxy token from the mock recorder and calls /api/x-agent itself.
 *
 * Named collaboration-* so it runs on the auth-collaboration project's server.
 */
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/multi-user.fixture'
import { mockRecorder } from '../../helpers/mock-recorder'
import { createAgent, createSession, waitForPendingProxyReview } from '../../helpers/agents'

const recorder = mockRecorder<{ type: string; agentSlug: string; proxyToken?: string }>({ defaultDataDir: '.e2e-data-auth', subdir: 'collaboration' })

test('only someone who uses both agents can allow an agent request', async ({ user1Page: olivia, user2Page: uma, user3Page: vic }) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const ids: string[] = []
  for (const [page, name] of [[olivia, 'Olivia'], [uma, 'Uma'], [vic, 'Vic']] as const) {
    const response = await page.request.post('/api/auth/sign-up/email', {
      data: { name, email: `${name.toLowerCase()}-x-agent-${stamp}@example.test`, password: 'CrossAgentTesting123!' },
    })
    expect(response.ok()).toBeTruthy()
    ids.push((await response.json()).user.id)
    expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
  }
  const alpha = await createAgent(olivia.request, `Alpha ${stamp}`)
  const beta = await createAgent(olivia.request, `Beta ${stamp}`)
  for (const [userId, role] of [[ids[1], 'user'], [ids[2], 'viewer']]) {
    expect((await olivia.request.post(`/api/agents/${alpha.slug}/access`, { data: { userId, role } })).ok()).toBeTruthy()
  }
  const session = await createSession(olivia.request, alpha, 'hello')
  const { proxyToken } = await recorder.waitFor((r) => r.type === 'container_start' && r.agentSlug === alpha.slug && !!r.proxyToken, { label: `Alpha ${alpha.slug}` })

  // Alpha's container asks to read Beta's sessions. The call waits on the card.
  const call = olivia.request.post('/api/x-agent/get-sessions', { headers: { Authorization: `Bearer ${proxyToken}` }, data: { slug: beta.slug }, timeout: 120_000 })
  const review = await waitForPendingProxyReview(olivia.request, alpha, { xAgent: true })
  const card = async (page: Page) => {
    await page.goto(`/agents/${alpha.slug}/sessions/${session.id}`)
    const locator = page.locator(`[data-testid="xagent-review-request"][data-review-id="${review.id}"]`)
    await expect(locator).toBeVisible({ timeout: 30_000 })
    return locator
  }
  const allow = (page: Page) => page.request.post(`/api/agents/${alpha.slug}/proxy-review/${review.id}`, { data: { decision: 'allow' } })

  // Vic views Alpha: a read-only card naming both agents.
  const vicCard = await card(vic)
  await expect(vicCard).toContainText(`You need User access to this agent and Beta ${stamp} to allow this.`)
  await expect(vicCard.getByTestId('xagent-review-deny-btn')).toHaveCount(0)
  await expect(vicCard.getByTestId('xagent-review-allow-once-btn')).toHaveCount(0)

  // Uma uses only Alpha: Deny and the agent she lacks, no Allow. The server refuses her Allow too.
  const umaCard = await card(uma)
  await expect(umaCard).toContainText(`You need User access to Beta ${stamp} to allow this.`)
  await expect(umaCard.getByTestId('xagent-review-deny-btn')).toBeVisible()
  await expect(umaCard.getByTestId('xagent-review-allow-once-btn')).toHaveCount(0)
  await expect(umaCard.getByTestId('xagent-review-always-allow-btn')).toHaveCount(0)
  expect((await allow(uma)).status()).toBe(403)

  // Olivia uses both: her Allow lets the call through.
  expect((await allow(olivia)).ok()).toBeTruthy()
  expect((await call).status()).toBe(200)
})

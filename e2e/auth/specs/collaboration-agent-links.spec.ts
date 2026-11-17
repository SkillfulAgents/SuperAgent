/**
 * Agent links in team mode: changing a link between two agents needs a User or
 * Owner of both, on every screen. The Connect page opens to Users, offers a change
 * only for agents the person uses, and the server refuses the rest.
 *
 * Olivia owns Alpha, Beta and Gamma. Uma is a User of Alpha and Beta, and only views Gamma.
 *
 * Named collaboration-* so it runs on the auth-collaboration project's server.
 */
import { test, expect } from '../fixtures/multi-user.fixture'
import { createAgent } from '../../helpers/agents'

test('changing an agent link needs a User or Owner of both agents', async ({ user1Page: olivia, user2Page: uma }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const ids: string[] = []
  for (const [page, name] of [[olivia, 'Olivia'], [uma, 'Uma']] as const) {
    const response = await page.request.post('/api/auth/sign-up/email', {
      data: { name, email: `${name.toLowerCase()}-links-${stamp}@example.test`, password: 'AgentLinksTesting123!' },
    })
    expect(response.ok()).toBeTruthy()
    ids.push((await response.json()).user.id)
    expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
  }
  const [alpha, beta, gamma] = await Promise.all(['Alpha', 'Beta', 'Gamma'].map((name) => createAgent(olivia.request, `${name} ${stamp}`)))
  for (const [slug, role] of [[alpha.slug, 'user'], [beta.slug, 'user'], [gamma.slug, 'viewer']]) {
    expect((await olivia.request.post(`/api/agents/${slug}/access`, { data: { userId: ids[1], role } })).ok()).toBeTruthy()
  }

  // Uma is a User, not an Owner, of Alpha: the Connect page opens.
  await uma.goto(`/agents/${alpha.slug}/x-agent-permissions`)
  const betaSwitch = uma.getByTestId(`x-agent-connect-switch-${beta.slug}`)
  await expect(betaSwitch).toBeEnabled({ timeout: 30_000 })
  await expect(uma.getByTestId('x-agent-permissions-no-permission')).toHaveCount(0)

  // She only views Gamma: its row can't change and says why.
  await expect(uma.getByTestId(`x-agent-connect-switch-${gamma.slug}`)).toBeDisabled()
  await expect(uma.getByTestId(`x-agent-policy-row-${gamma.slug}`)).toContainText(`You need User access to Gamma ${stamp} to change this`)

  // She uses both Alpha and Beta: connecting them saves.
  const saved = uma.waitForResponse((r) => r.url().endsWith(`/api/agents/${alpha.slug}/x-agent-policies`) && r.request().method() === 'PATCH')
  await betaSwitch.click()
  expect((await saved).ok()).toBeTruthy()
  const { policies } = await (await uma.request.get(`/api/agents/${alpha.slug}/x-agent-policies`)).json() as { policies: Array<{ operation: string; targetAgentSlug: string | null; decision: string }> }
  expect(policies).toContainEqual(expect.objectContaining({ operation: 'invoke', targetAgentSlug: beta.slug, decision: 'allow' }))

  // The server refuses a link to Gamma from any route.
  const refusal = { error: 'Only a User or Owner of both agents can change this connection.' }
  const patch = await uma.request.patch(`/api/agents/${alpha.slug}/x-agent-policies`, { data: { operation: 'invoke', targetSlug: gamma.slug, decision: 'allow' } })
  expect(patch.status()).toBe(403)
  expect(await patch.json()).toEqual(refusal)
  expect((await uma.request.put(`/api/agents/${alpha.slug}/x-agent-policies/invoke/${gamma.slug}`, { data: { decision: 'allow' } })).status()).toBe(403)
})

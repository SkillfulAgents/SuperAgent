import { test, expect } from '@playwright/test'
import { agentMembersBatchRequestSchema } from '../../../src/shared/lib/agent-members-schema'

test('sidebar rosters batch loads and pick up profile changes on reload', async ({ browser, page, baseURL }) => {
  const stamp = Date.now()
  const peer = await browser.newContext({ baseURL })
  try {
    const ownerSignup = await page.request.post('/api/auth/sign-up/email', {
      data: { name: 'Roster Owner', email: `roster-owner-${stamp}@example.test`, password: 'RosterTesting123!' },
    })
    expect(ownerSignup.ok()).toBeTruthy()
    expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
    const peerSignup = await peer.request.post('/api/auth/sign-up/email', {
      data: { name: 'Roster Peer', email: `roster-peer-${stamp}@example.test`, password: 'RosterTesting123!' },
    })
    expect(peerSignup.ok()).toBeTruthy()
    const peerUser = (await peerSignup.json()).user
    const slugs: string[] = []
    for (let i = 0; i < 5; i++) {
      const created = await page.request.post('/api/agents', { data: { name: `Batch Agent ${i}` } })
      expect(created.ok()).toBeTruthy()
      const agent = await created.json()
      slugs.push(agent.slug)
      expect((await page.request.post(`/api/agents/${agent.slug}/access`, { data: { userId: peerUser.id, role: 'viewer' } })).ok()).toBeTruthy()
    }

    const batches: string[][] = []
    const individual: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path === '/api/agents/members/batch') batches.push(agentMembersBatchRequestSchema.parse(request.postDataJSON()).agentSlugs)
      else if (/\/api\/agents\/[^/]+\/members$/.test(path)) individual.push(path)
    })
    await page.goto('/')
    for (const slug of slugs) {
      await expect(page.getByTestId(`sidebar-members-${slug}`).locator('[role="img"]')).toHaveCount(2)
    }
    expect(batches).toHaveLength(1)
    expect(new Set(batches[0])).toEqual(new Set(slugs))
    expect(individual).toEqual([])

    // Profile edits don't push roster refreshes; the next load reads the new data.
    expect((await peer.request.post('/api/auth/update-user', { headers: { Origin: baseURL! }, data: { name: 'Updated Roster Peer' } })).ok()).toBeTruthy()
    for (const slug of slugs) {
      await expect(page.getByTestId(`sidebar-members-${slug}`).locator('[role="img"][aria-label="Roster Peer"]')).toBeVisible()
    }
    expect(batches).toHaveLength(1)
    await page.reload()
    for (const slug of slugs) {
      await expect(page.getByTestId(`sidebar-members-${slug}`).locator('[role="img"][aria-label="Updated Roster Peer"]')).toBeVisible()
    }
    expect(batches).toHaveLength(2)
    expect(new Set(batches[1])).toEqual(new Set(slugs))

    // Opening the header and member popover reuses the refreshed roster cache.
    await page.getByTestId(`agent-item-${slugs[0]}`).click()
    await expect(page.getByTestId('agent-member-stack').locator('[role="img"][aria-label="Updated Roster Peer"]')).toBeVisible()
    await page.getByTestId(`sidebar-members-${slugs[0]}`).hover()
    await expect(page.getByTestId(`sidebar-members-list-${slugs[0]}`)).toContainText('Updated Roster Peer')
    expect(batches).toHaveLength(2)
    expect(individual).toEqual([])
  } finally {
    await peer.close()
  }
})

import { test, expect, type BrowserContext } from '@playwright/test'
import { PNG } from 'pngjs'

test('members share one live roster while invitation and revocation follow permissions', async ({ browser, page, baseURL }) => {
  test.setTimeout(90_000)
  const contexts: BrowserContext[] = []
  const stamp = Date.now()
  const users: { id: string; name: string; email: string; context: BrowserContext }[] = []
  try {
    for (const [index, name] of ['Olivia Owner', 'Vic Viewer', 'Uma User', 'Nora Patel', 'Eli Brooks', 'Sam Rivera', 'Maya Chen', 'Unrelated User'].entries()) {
      const context = index === 0 ? page.context() : await browser.newContext({ baseURL })
      if (index > 0) contexts.push(context)
      const email = `members-${stamp}-${index}@example.test`
      const response = await context.request.post('/api/auth/sign-up/email', { data: { name, email, password: 'CollaborationTesting123!' } })
      expect(response.ok()).toBeTruthy()
      const { user } = await response.json()
      users.push({ id: user.id, name, email, context })
      expect((await context.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
    }
    const created = await page.request.post('/api/agents', { data: { name: 'Collaboration Members' } })
    expect(created.ok()).toBeTruthy()
    const agent = await created.json()
    const endpoint = `/api/agents/${agent.slug}`
    await page.goto(`/agents/${agent.slug}`)
    const ownerStack = page.getByTestId('agent-member-stack')
    await expect(page.getByTestId('agent-share-button')).toHaveText('Share', { timeout: 15_000 })
    await expect(ownerStack).toHaveCount(0)
    await expect(page.getByTestId(`sidebar-members-${agent.slug}`)).toHaveCount(0)

    // The stretched name link must not cover the status icon's native tooltip.
    const agentLink = page.getByTestId(`agent-item-${agent.slug}`)
    const status = page.locator('[data-sidebar="menu-button"]').filter({ has: agentLink }).getByTestId('agent-status')
    await status.hover()
    expect(await status.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    })).toBe(true)
    await expect(status).toHaveAttribute('title', 'sleeping')

    // Private agents retain Share; the same pane stays open when the first invite makes it shared.
    await page.getByTestId('agent-share-button').click()
    const sharing = page.getByTestId('agent-share-popover')
    await expect(sharing.getByRole('tab', { name: 'Publish', exact: true })).toBeVisible()
    await expect(sharing.getByRole('tab', { name: 'Export', exact: true })).toBeVisible()
    await sharing.getByPlaceholder('Invite by name or email...').fill(users[1].email)
    await sharing.getByTestId(`invite-user-result-${users[1].id}`).click()
    await sharing.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'Viewer Can view sessions only' }).click()
    await sharing.getByRole('button', { name: 'Invite', exact: true }).click()
    await expect(ownerStack.getByTestId(`agent-member-${users[1].id}`)).toBeVisible()
    await expect(sharing).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sharing).not.toBeVisible()

    const viewer = await users[1].context.newPage()
    await viewer.goto(`/agents/${agent.slug}`)
    await expect(viewer.getByTestId('agent-member-stack')).toBeVisible()
    await expect(viewer.getByTestId('agent-share-button')).toHaveCount(0)
    await expect(viewer.getByTestId('view-only-banner')).toBeVisible()
    expect((await viewer.request.get(`${endpoint}/access`)).status()).toBe(403)
    expect((await viewer.request.post(`${endpoint}/access`, { data: { userId: users[7].id, role: 'owner' } })).status()).toBe(403)
    expect((await users[7].context.request.get(`${endpoint}/members`)).status()).toBe(403)

    await viewer.getByTestId(`sidebar-members-${agent.slug}`).click()
    await expect(viewer.getByTestId(`sidebar-members-invite-${agent.slug}`)).toHaveCount(0)
    await viewer.keyboard.press('Escape')

    // Sidebar Invite targets its agent while leaving the current page in place.
    await page.goto('/')
    const sidebarStack = page.getByTestId(`sidebar-members-${agent.slug}`)
    const sidebarRoster = page.getByTestId(`sidebar-members-list-${agent.slug}`)
    await sidebarStack.click()
    await page.getByTestId(`sidebar-members-invite-${agent.slug}`).click()
    await expect(sharing.getByTestId('invite-search-input')).toBeFocused()
    await sharing.getByTestId('invite-search-input').fill(users[2].email)
    await sharing.getByTestId(`invite-user-result-${users[2].id}`).click()
    await sharing.getByTestId('invite-add-button').click()
    await expect(sidebarRoster.getByRole('listitem')).toHaveCount(3)
    await expect(page).toHaveURL(`${baseURL}/`)
    await page.keyboard.press('Escape')
    await expect(sharing).not.toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sidebarRoster).not.toBeVisible()
    await page.goto(`/agents/${agent.slug}`)

    // A second window refreshes without opening Share or reloading the page.
    for (const member of users.slice(3, 7)) {
      expect((await page.request.post(`${endpoint}/access`, { data: { userId: member.id, role: 'user' } })).ok()).toBeTruthy()
    }
    await expect(ownerStack.getByTestId('agent-members-overflow')).toHaveText('+2')
    await expect(viewer.getByTestId('agent-members-overflow')).toHaveText('+2')
    await viewer.getByTestId('agent-members-overflow').click()
    await expect(viewer.getByTestId('agent-members-list').getByRole('listitem')).toHaveCount(7)
    await expect(viewer.getByTestId('agent-members-list')).toContainText(users[6].email)
    await viewer.keyboard.press('Escape')

    const image = new PNG({ width: 32, height: 32 })
    image.data.fill(160)
    expect((await viewer.request.put('/api/profile/avatar', { headers: { 'Content-Type': 'image/png' }, data: PNG.sync.write(image) })).ok()).toBeTruthy()
    expect((await viewer.request.post('/api/auth/update-user', { headers: { Origin: baseURL! }, data: { name: 'Victoria Viewer' } })).ok()).toBeTruthy()
    // Other members see the updated photo and name on their next reload.
    await page.reload()
    const viewerFace = ownerStack.getByTestId(`agent-member-${users[1].id}`)
    await expect(viewerFace.locator('img')).toHaveAttribute('src', /\/api\/profile\/images\//)
    await expect(viewerFace).toHaveAttribute('aria-label', /Victoria Viewer/)
    await ownerStack.getByTestId(`agent-member-${users[0].id}`).hover()
    await expect(page.getByRole('tooltip').filter({ hasText: users[0].email })).toBeVisible()
    await viewerFace.hover()
    await expect(page.getByRole('tooltip').filter({ hasText: users[1].email })).toBeVisible()
    await expect(page.getByRole('tooltip').filter({ hasText: users[0].email })).toHaveCount(0)
    await viewerFace.focus()
    await expect(page.getByRole('tooltip').filter({ hasText: users[1].email })).toBeVisible()
    await page.keyboard.press('Escape')

    expect((await page.request.patch(`${endpoint}/access/${users[1].id}`, { data: { role: 'owner' } })).ok()).toBeTruthy()
    await expect(viewer.getByTestId('agent-share-button')).toBeVisible()
    expect((await page.request.patch(`${endpoint}/access/${users[1].id}`, { data: { role: 'user' } })).ok()).toBeTruthy()
    await expect(viewer.getByTestId('agent-share-button')).toHaveCount(0)
    await expect(viewer.getByTestId('view-only-banner')).toHaveCount(0)

    // A touch viewport can inspect names, respects reduced motion, and keeps + reachable.
    const touch = await browser.newContext({ baseURL, storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    contexts.push(touch)
    const mobile = await touch.newPage()
    await mobile.goto(`/agents/${agent.slug}`)
    const mobileFace = mobile.getByTestId(`agent-member-${users[1].id}`)
    await mobileFace.tap()
    await expect(mobile.getByRole('tooltip')).toContainText(users[1].email)
    expect(await mobileFace.getByTestId('member-avatar-visual').evaluate((element) => getComputedStyle(element).transitionProperty)).toBe('none')
    const inviteBounds = await mobile.getByTestId('agent-share-button').boundingBox()
    expect(inviteBounds!.x).toBeGreaterThanOrEqual(0)
    expect(inviteBounds!.x + inviteBounds!.width).toBeLessThanOrEqual(390)

    expect((await page.request.delete(`${endpoint}/access/${users[1].id}`)).ok()).toBeTruthy()
    await expect(viewer).toHaveURL(`${baseURL}/`)
    await expect(viewer.getByTestId('agent-member-stack')).toHaveCount(0)
    expect((await viewer.request.get(`${endpoint}/members`)).status()).toBe(403)
    await expect(ownerStack.getByTestId('agent-members-overflow')).toHaveText('+1')
    expect((await users[2].context.request.post(`${endpoint}/leave`)).ok()).toBeTruthy()
    await expect(ownerStack.getByTestId('agent-members-overflow')).toHaveCount(0)

    // Other specs may have created the deployment's first user. Check the
    // actual deployment role instead of treating the agent owner as an admin.
    const session = await (await page.request.get('/api/auth/get-session')).json()
    const isDeploymentAdmin = session.user.role === 'admin'
    expect((await page.request.patch(`${endpoint}/access/${users[3].id}`, { data: { role: 'owner' } })).ok()).toBeTruthy()
    expect((await users[3].context.request.delete(`${endpoint}/access/${users[0].id}`)).ok()).toBeTruthy()
    await expect(agentLink).toHaveCount(0)
    if (isDeploymentAdmin) {
      await expect(page).toHaveURL(new RegExp(`/agents/[^/]*${agent.slug}$`))
      await expect(ownerStack.getByTestId(`agent-member-${users[0].id}`)).toHaveCount(0)
      await expect(ownerStack.getByTestId(`agent-member-${users[3].id}`)).toBeVisible()
    } else {
      await expect(page).toHaveURL(`${baseURL}/`)
      await expect(ownerStack).toHaveCount(0)
    }
    expect((await page.request.get(`${endpoint}/members`)).status()).toBe(isDeploymentAdmin ? 200 : 403)
    expect((await page.request.get(`${endpoint}/access`)).status()).toBe(isDeploymentAdmin ? 200 : 403)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

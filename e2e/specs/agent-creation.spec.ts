import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

test.beforeEach(async ({ page }) => {
  const app = new AppPage(page)
  await app.goto()
  await app.waitForAgentsLoaded()
})

test('refresh and Skip keep one named agent with no sessions', async ({ page, request }) => {
  const agentPage = new AgentPage(page)
  await agentPage.clickCreateAgent()
  const name = `Research ${Date.now()}`
  const created = page.waitForResponse(r => r.url().endsWith('/api/agents') && r.request().method() === 'POST' && r.status() === 201)
  await agentPage.nameNewAgent(name)
  const agent = await (await created).json()
  await expect(page.getByTestId('create-agent-skip')).toBeEnabled()
  await page.reload()
  await expect(page.getByTestId('agent-identity-name-label')).toHaveText(name)
  await page.getByTestId('create-agent-skip').click()
  await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
  const sessions = await request.get(`/api/agents/${agent.slug}/sessions`)
  expect(await sessions.json()).toEqual([])
  const agents = await (await request.get('/api/agents')).json()
  expect(agents.filter((other: { name: string }) => other.name === name)).toHaveLength(1)
})

test('refresh while the creation response is in flight resumes the same agent and job', async ({ page, request }) => {
  const agentPage = new AgentPage(page)
  await agentPage.clickCreateAgent()
  let held = false
  await page.route('**/api/agents', async route => {
    if (route.request().method() !== 'POST' || held) return route.continue()
    held = true
    // Let the server create the agent, but withhold the response from this document.
    await route.fetch()
  })
  const name = `Planner ${Date.now()}`
  await agentPage.nameNewAgent(name)
  const prompt = page.getByTestId('create-agent-prompt')
  await prompt.fill('Write a weekly brief')
  await expect(page.getByTestId('create-agent-skip')).toBeDisabled()
  const matches = async () => {
    const agents = await (await request.get('/api/agents')).json()
    return agents.filter((a: { name: string }) => a.name === name)
  }
  await expect.poll(async () => (await matches()).length).toBe(1)
  await page.reload()
  await expect(prompt).toHaveText('Write a weekly brief')
  await page.getByTestId('create-agent-skip').click()
  await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
  expect(await matches()).toHaveLength(1)
})

test('a refreshed add-ons step sends the saved job to the same agent', async ({ page, request }) => {
  const agentPage = new AgentPage(page)
  await agentPage.clickCreateAgent()
  const created = page.waitForResponse(r => r.url().endsWith('/api/agents') && r.request().method() === 'POST' && r.status() === 201)
  await agentPage.nameNewAgent(`Planner ${Date.now()}`)
  const agent = await (await created).json()
  const job = 'Prepare a weekly research brief.'
  await page.getByTestId('create-agent-prompt').fill(job)
  await page.getByTestId('composer-options-trigger').click()
  await page.getByTestId('model-pinned-claude-sonnet-4-6').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('create-agent-continue').click()
  const memory = page.getByRole('switch', { name: 'Memories', exact: true })
  await expect(memory).toBeChecked()
  await memory.click()
  await expect(memory).not.toBeChecked()
  expect((await (await request.get(`/api/agents/${agent.slug}/preferences`)).json()).autoMemoryEnabled).toBe(false)
  await page.reload()
  await expect(page.getByTestId('agent-addons-step')).toBeVisible()
  await expect(memory).not.toBeChecked()
  const session = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith(`/api/agents/${agent.slug}/sessions`))
  await page.getByTestId('create-agent-finish').click()
  expect((await session).postDataJSON()).toMatchObject({ model: 'claude-sonnet-4-6' })
  await expect(page).toHaveURL(new RegExp('/agents/' + agent.displaySlug + '/sessions/'))
  await expect(page.getByTestId('message-list')).toContainText(job)
})

async function reachAddons(page: Page) {
  const wizard = new AgentPage(page)
  await wizard.clickCreateAgent()
  const created = page.waitForResponse(r => r.url().endsWith('/api/agents') && r.request().method() === 'POST' && r.status() === 201)
  await wizard.nameNewAgent(`Setup review ${Date.now()}`)
  const agent = await (await created).json() as { slug: string }
  await page.getByTestId('create-agent-prompt').fill('Prepare a weekly research brief.')
  await page.getByTestId('create-agent-continue').click()
  await expect(page.getByTestId('agent-addons-step')).toBeVisible()
  return `/api/agents/${agent.slug}/sessions`
}

test('a partial Team Brain setup survives refresh and retries the missing permission', async ({ page, request }) => {
  const brain = await (await request.post('/api/agents', { data: { name: 'Team Brain' } })).json()
  const volumeId = 'team-brain-drive'
  await page.route('**/api/agents', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const agents = await response.json()
    await route.fulfill({ response, json: agents.map((a: { slug: string }) =>
      a.slug === brain.slug ? { ...a, teamBrain: { volumeId } } : a) })
  })
  let mountCount = 0
  let mountedSlug: string | undefined
  await page.route('**/api/volume-definitions', route => route.fulfill({
    json: [{ id: volumeId, name: 'Team Brain drive', visibility: 'public', globalAccess: null }],
  }))
  await page.route('**/api/volume-definitions/team-brain-drive/agents', route => route.fulfill({
    json: { attachments: mountedSlug ? [{ agentSlug: mountedSlug, mountId: 'brain-mount' }] : [] },
  }))
  await page.route('**/api/agents/*/mounts', route => {
    if (route.request().method() !== 'POST') return route.continue()
    mountedSlug = route.request().url().split('/').at(-2)
    mountCount++
    return route.fulfill({ status: 201, json: { id: 'brain-mount' } })
  })
  await page.route('**/api/agents/*/mounts/brain-mount', route => {
    if (route.request().method() !== 'DELETE') return route.continue()
    mountedSlug = undefined
    return route.fulfill({ status: 200, json: { success: true } })
  })
  // The drive and the outgoing grant succeed. The first incoming grant fails.
  await page.route(`**/api/agents/${brain.slug}/x-agent-policies/read/*`,
    route => route.fulfill({ status: 403, json: { error: 'Access denied' } }), { times: 1 })

  await reachAddons(page)
  const toggle = page.getByRole('switch', { name: 'Team Brain' })
  await expect(page.getByText(/Team Brain can read its sessions/)).toBeVisible()
  await toggle.click()
  await expect(page.getByText('Could not change who uses Team Brain')).toBeVisible()
  const incomplete = page.getByText('Team Brain setup is incomplete.')
  await expect(incomplete).toBeVisible()
  await page.reload()
  await expect(incomplete).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Remove access' })).toBeEnabled()
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
  await expect(toggle).toBeEnabled()
  await expect(toggle).toBeChecked()
  await page.reload()
  await expect(toggle).toBeChecked()
  await expect(incomplete).toBeHidden()
  expect(mountCount).toBe(1)

  // A permission can also be removed elsewhere. Let the user undo what remains.
  const revoked = await request.delete(`/api/agents/${brain.slug}/x-agent-policies/read/${mountedSlug}`)
  expect(revoked.ok()).toBe(true)
  await page.reload()
  await page.getByRole('button', { name: 'Remove access' }).click()
  await expect(toggle).toBeEnabled()
  await page.reload()
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  await expect(incomplete).toBeHidden()
  expect(mountedSlug).toBeUndefined()
})

test('replaying Create after a lost response opens the one accepted job', async ({ page, request }) => {
  const sessions = await reachAddons(page)
  let accepted: string | undefined
  await page.route('**' + sessions, async route => {
    if (route.request().method() !== 'POST' || accepted) return route.continue()
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    accepted = (await response.json()).id
    // Withhold the response to the original document.
  })
  await page.getByTestId('create-agent-finish').click()
  await expect.poll(() => accepted).toBeTruthy()
  await page.reload()
  await page.getByTestId('create-agent-finish').click()
  await expect(page).toHaveURL(new RegExp('/sessions/' + accepted + '$'))
  const list = await (await request.get(sessions)).json()
  expect(list.map((s: { id: string }) => s.id)).toEqual([accepted])
})

test('an unavailable skill catalog does not prevent starting the requested job', async ({ page }) => {
  await page.route('**/api/agents/*/skills', route => route.fulfill({ status: 503, json: { error: 'Inventory unavailable' } }))
  await page.route('**/api/agents/*/skills/refresh*', route => route.fulfill({ status: 503 }))
  await reachAddons(page)
  await page.getByTestId('create-agent-finish').click()
  await expect(page.getByTestId('message-list')).toContainText('Prepare a weekly research brief.')
})

test('Skip keeps Dream installed and sends the first Home job verbatim', async ({ page, request }) => {
  const sessions = await reachAddons(page)
  const toggle = page.getByRole('switch', { name: 'Self-Improvement' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.getByTestId('new-agent-back').click()
  await page.getByTestId('create-agent-skip').click()
  await expect(page.getByTestId('home-message-input')).toBeVisible()
  expect(await (await request.get(sessions)).json()).toEqual([])
  await page.reload()
  await page.getByTestId('home-message-input').fill('My first real job')
  const posted = page.waitForRequest(r => r.url().endsWith(sessions) && r.method() === 'POST')
  await page.getByTestId('home-send-button').click()
  expect((await posted).postDataJSON().message).toBe('My first real job')
  const messages = page.getByTestId('message-list')
  await expect(messages).toContainText('My first real job')
  await expect(messages).not.toContainText('/dream')
  const skills = await (await request.get(sessions.replace(/sessions$/, 'skills'))).json()
  expect(skills.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'dream' })]))
})

test('Create appends the Dream instruction once to the saved wizard job', async ({ page }) => {
  const sessions = await reachAddons(page)
  const toggle = page.getByRole('switch', { name: 'Self-Improvement' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.reload()
  const sent = page.waitForRequest(r => r.url().endsWith(sessions) && r.method() === 'POST')
  await page.getByTestId('create-agent-finish').click()
  const message = (await sent).postDataJSON().message
  expect(message).toMatch(/^Prepare a weekly research brief\.\n\nUse the \/dream skill/)
  expect(message.split('/dream')).toHaveLength(2)
  await expect(page.getByTestId('message-list')).toContainText('schedule it and run the first dream')
})

test('a restored mention can cancel the access dialog, then grant access and start the job', async ({ page, request }) => {
  const target = await (await request.post('/api/agents', { data: { name: 'Mentions target' } })).json()
  const sessions = await reachAddons(page)
  const dream = page.getByRole('switch', { name: 'Self-Improvement' })
  await dream.click()
  await expect(dream).toBeChecked()
  // Restore the same marker format that the composer stores for a selected agent chip.
  await page.evaluate(({ slug }) => {
    const key = 'gamut:new-agent:' + history.state.__TSR_key
    const raw = sessionStorage.getItem(key)
    if (!raw) throw new Error('Expected a saved wizard draft')
    try {
      const draft = JSON.parse(raw)
      draft.prompt = `Ask [[agent:${slug}|Mentions%20target]] for an update`
      sessionStorage.setItem(key, JSON.stringify(draft))
    } catch (cause) {
      throw new Error('Could not restore the saved mention draft', { cause })
    }
  }, target)
  await page.reload()
  const finish = page.getByTestId('create-agent-finish')
  await finish.click()
  const dialog = page.getByTestId('mention-access-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(finish).toBeEnabled()
  expect(await (await request.get(sessions)).json()).toEqual([])
  await finish.click()
  await dialog.getByRole('button', { name: 'Allow and send' }).click()
  const message = page.getByTestId('message-list')
  await expect(message).toContainText('Use the /dream skill')
  await expect(message.getByTestId('agent-mention').first()).toContainText('Mentions target')
})

test('removing Dream before leaving the wizard clears its first-job instruction', async ({ page }) => {
  const sessions = await reachAddons(page)
  const toggle = page.getByRole('switch', { name: 'Self-Improvement' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  const started = page.waitForResponse(r => r.url().endsWith(sessions) && r.request().method() === 'POST')
  await page.getByTestId('create-agent-finish').click()
  const response = await started
  expect(response.status()).toBe(201)
  expect(response.request().postDataJSON().message).toBe('Prepare a weekly research brief.')
})

test('More channels opens Telegram setup and returns to the wizard after connecting', async ({ page }) => {
  await page.route('**/api/agent-integrations/providers', route => route.fulfill({ json: [{ provider: 'telegram' }, { provider: 'linear' }] }))
  let connected = false
  await page.route('**/api/agent-integrations/agents/*', route => {
    const agentSlug = route.request().url().split('/').pop()!
    const record = { id: 'test-telegram', agentSlug, provider: 'telegram', status: 'active', connected: true, hasCredentials: true }
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().provider).toBe('telegram')
      connected = true
      return route.fulfill({ status: 201, json: record })
    }
    return route.fulfill({ json: connected ? [record] : [] })
  })
  await reachAddons(page)
  const inbox = page.getByRole('button', { name: 'Set up Inbox' })
  await expect(inbox).toBeDisabled()
  await inbox.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Connect your Gamut account to set up Inbox.')
  const telegram = page.getByRole('button', { name: 'Set up Telegram' })
  await expect(telegram).toBeHidden()
  const more = page.getByRole('button', { name: 'More channels' })
  await more.click()
  await expect(page.getByRole('button', { name: 'Set up iMessage' })).toBeDisabled()
  const github = page.getByRole('button', { name: 'Set up GitHub' })
  await expect(github).toBeDisabled()
  await expect(github).toHaveAccessibleDescription(/webhook relay/)
  await github.scrollIntoViewIfNeeded()
  await github.focus()
  await expect(github).toHaveAccessibleDescription(/webhook relay/)
  await expect(page.getByRole('button', { name: 'Set up Meetings' })).toBeDisabled()
  await page.getByRole('button', { name: 'Set up Linear' }).click()
  await expect(page.getByRole('dialog').getByLabel('Client ID')).toBeVisible()
  await page.keyboard.press('Escape')
  await telegram.click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Bot Token').fill('fixture-token')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Configured Telegram' })).toBeDisabled()
  await expect(page.getByTestId('create-agent-finish')).toBeEnabled()
})

test('deferred channels survive reload, reopen from Agent Home, and dismiss independently', async ({ page, request }) => {
  const sessions = await reachAddons(page)
  const slug = sessions.split('/')[3]
  const reminders = `/api/agent-integrations/agents/${slug}/finished-setup`
  const dialog = page.getByRole('dialog')
  await page.getByRole('button', { name: 'Set up Slack' }).click()
  await dialog.getByRole('button', { name: 'Set this up later' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Set up Slack, saved for later' })).toBeEnabled()
  await page.getByRole('button', { name: 'More channels' }).click()
  await page.getByRole('button', { name: 'Set up Telegram' }).click()
  await dialog.getByRole('button', { name: 'Set this up later' }).click()
  await expect(dialog).toBeHidden()
  await page.getByTestId('new-agent-back').click()
  await page.getByTestId('create-agent-skip').click()
  const panel = page.getByRole('region', { name: 'Finish setting up this agent' })
  await expect(panel).toBeVisible()
  await page.reload()
  const finishSlack = panel.getByRole('button', { name: 'Finish setup Slack' })
  const dismissSlack = panel.getByRole('button', { name: 'Dismiss Slack setup' })
  const dismissTelegram = panel.getByRole('button', { name: 'Dismiss Telegram setup' })
  await panel.getByRole('heading').hover()
  await expect(dismissSlack).toHaveCSS('opacity', '0')
  const idleLeft = await finishSlack.evaluate(button => button.getBoundingClientRect().left)
  await panel.getByText('Slack', { exact: true }).hover()
  await expect(dismissSlack).toHaveCSS('opacity', '1')
  await expect(dismissTelegram).toHaveCSS('opacity', '0')
  expect(await finishSlack.evaluate(button => button.getBoundingClientRect().left)).toBeLessThan(idleLeft)
  await finishSlack.click()
  await expect(dialog.getByRole('heading', { name: /Slack/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await panel.getByText('Slack', { exact: true }).hover()
  await dismissSlack.click()
  await expect(panel.getByText('Slack')).toBeHidden()
  await panel.getByRole('button', { name: 'Finish setup Telegram' }).click()
  await expect(dialog.getByLabel('Bot Token')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await (await request.get(reminders)).json()).toEqual({ steps: [{ type: 'channel', provider: 'telegram' }] })
  await panel.getByRole('heading').hover()
  await panel.getByRole('button', { name: 'Finish setup Telegram' }).focus()
  await page.keyboard.press('Tab')
  await expect(dismissTelegram).toBeFocused()
  await expect(dismissTelegram).toHaveCSS('opacity', '1')
  await page.keyboard.press('Enter')
  await expect(panel).toBeHidden()
  await page.reload()
  await expect(page.getByTestId('home-message-input')).toBeVisible()
  expect(await (await request.get(reminders)).json()).toEqual({ steps: [] })
})

test('the defer action stays visible beneath long Slack instructions on a small phone', async ({ page }) => {
  await reachAddons(page)
  await page.setViewportSize({ width: 320, height: 568 })
  await page.getByRole('button', { name: 'Set up Slack' }).click()
  const dialog = page.getByRole('dialog', { name: 'Set up integration with Slack' })
  await expect(dialog.getByTestId('integration-setup-layout')).toBeVisible()
  const defer = dialog.getByRole('button', { name: 'Set this up later' })
  await expect(defer).toBeInViewport({ ratio: 1 })
  await defer.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Set up Slack, saved for later' })).toBeEnabled()
})

for (const surface of ['the wizard', 'Agent Home']) {
  test(`Finish setup completes the existing Slack webhook installation from ${surface}`, async ({ page }) => {
    let agentSlug = ''
    let connected = false
    const installation = () => ({
      id: 'pending-slack', agentSlug, name: 'Slack', provider: 'slack', status: connected ? 'active' : 'paused',
      connected, hasCredentials: connected,
      slack: {
        botTokenSaved: connected, signingSecretSaved: connected, appTokenSaved: false,
        webhook: { status: 'pending', url: 'https://example.invalid/hooks/test' },
      },
    })
    await page.route('**/api/agent-integrations/agents/*', route => {
      agentSlug = route.request().url().split('/').pop()!
      return route.fulfill({ json: [installation()] })
    })
    await page.route('**/api/agent-integrations/pending-slack', route => {
      if (route.request().method() === 'PATCH') connected = true
      return route.fulfill({ json: installation() })
    })
    await reachAddons(page)
    await page.getByRole('button', { name: 'Finish setup Slack' }).click()
    const dialog = page.getByRole('dialog', { name: 'Finish Slack setup' })
    if (surface === 'Agent Home') {
      await dialog.getByRole('button', { name: 'Set this up later' }).click()
      await expect(dialog).toBeHidden()
      await page.getByTestId('new-agent-back').click()
      await page.getByTestId('create-agent-skip').click()
      await expect(page.getByRole('region', { name: 'Finish setting up this agent' })).toBeVisible()
      await page.reload()
      await page.getByRole('region', { name: 'Finish setting up this agent' })
        .getByRole('button', { name: 'Finish setup Slack' }).click()
    }
    await dialog.getByLabel('Signing Secret').fill('fixture-secret')
    await dialog.getByLabel('Bot Token').fill('fixture-token')
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toBeHidden()
    if (surface === 'Agent Home') {
      await expect(page.getByRole('region', { name: 'Finish setting up this agent' })).toBeHidden()
    } else {
      await expect(page.getByRole('button', { name: 'Configured Slack' })).toBeDisabled()
      await expect(page.getByTestId('create-agent-finish')).toBeEnabled()
    }
  })
}

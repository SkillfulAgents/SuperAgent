import { test, expect, type APIRequestContext, type Locator, type Route } from '@playwright/test'
import fs from 'node:fs'
import { z } from 'zod'
import { agentAvatarSchema, type AgentAvatar } from '@shared/lib/types/agent-avatar'
import { createAgent, createSession, uniqueName } from '../helpers/agents'
import { buildAgentTemplateZip } from '../helpers/agent-template-zip'

async function readAvatar(request: APIRequestContext, slug: string): Promise<AgentAvatar> {
  const response = await request.get(`/api/agents/${slug}`)
  expect(response.ok()).toBeTruthy()
  return agentAvatarSchema.parse((await response.json()).avatar)
}

async function expectAvatar(picker: Locator, avatar: AgentAvatar) {
  await expect(picker).toBeVisible({ timeout: 15000 })
  const orb = picker.locator('[data-avatar-orb]')
  await expect(orb).toHaveAttribute('data-avatar-orb', avatar.color)
  await expect(orb).toHaveAttribute('data-avatar-shape', avatar.shape)
}

test('older deployments without avatar metadata remain navigable', async ({ page, request }, testInfo) => {
  const agent = await createAgent(request, uniqueName(testInfo, 'Legacy cloud agent'))
  try {
    const session = await createSession(request, agent, 'Existing session')
    const wireAgent = z.object({ avatar: z.unknown().optional() }).passthrough()
    const withoutAvatar = (value: unknown) => {
      const legacy = wireAgent.parse(value)
      delete legacy.avatar
      return legacy
    }
    const legacyResponse = async (route: Route) => {
      const response = await route.fetch()
      const body: unknown = await response.json()
      await route.fulfill({ response, json: Array.isArray(body) ? body.map(withoutAvatar) : withoutAvatar(body) })
    }
    await page.route(/\/api\/agents(?:\/[^/?]+)?(?:\?.*)?$/, legacyResponse)
    const errors: string[] = []
    const avatarWrites: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', req => {
      if (req.method() === 'PUT' && req.url().endsWith('/avatar')) avatarWrites.push(req.url())
    })

    await page.goto('/')
    const card = page.locator(`[data-widget-id="${agent.slug}"]`)
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card.locator('[data-avatar-orb]')).toHaveCount(0)
    const link = page.getByTestId(`agent-item-${agent.slug}`)
    const row = link.locator('xpath=ancestor::li[1]')
    await expect(row.locator('[data-avatar-orb]')).toHaveCount(0)
    await row.getByRole('button', { name: 'Expand', exact: true }).click()
    await expect(page.getByTestId(`session-item-${session.id}`)).toBeVisible()

    await link.click()
    await expect(page.getByTestId('home-message-input')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('agent-avatar-picker')).toHaveCount(0)
    await expect(page.getByTestId('agent-home-layout').locator('[data-avatar-orb]')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('home-message-input')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('agent-avatar-picker')).toHaveCount(0)
    await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
    expect(avatarWrites).toEqual([])
  } finally {
    // The app keeps polling the agent; a refetch still in flight when the page
    // closes would fail the test from inside the route handler.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await request.delete(`/api/agents/${agent.slug}`)
  }
})

test('avatar changes persist across reloads and reach another browser', async ({ page, request, browser, baseURL }, testInfo) => {
  const agent = await createAgent(request, uniqueName(testInfo, 'Persistent avatar'))
  const otherBrowser = await browser.newContext({ baseURL })
  try {
    const initial = await readAvatar(request, agent.slug)
    await page.goto(`/agents/${agent.slug}`)
    const picker = page.getByTestId('agent-avatar-picker')
    await expectAvatar(picker, initial)

    // A fresh browser has no local storage or shared query cache.
    const otherPage = await otherBrowser.newPage()
    const streamReady = otherPage.waitForEvent('websocket', socket => socket.url().endsWith('/api/notifications/socket'))
    await otherPage.goto(`/agents/${agent.slug}`)
    await streamReady
    const otherPicker = otherPage.getByTestId('agent-avatar-picker')
    await expectAvatar(otherPicker, initial)

    await picker.click()
    await page.getByRole('button', { name: 'Bloom', exact: true }).click()
    await page.getByRole('button', { name: 'Red / Amber', exact: true }).click()
    const saved = { color: 'duo-red-amber', shape: 'bloom' } as const
    const saving = page.waitForResponse(response => response.url().endsWith(`/api/agents/${agent.slug}/avatar`) && response.request().method() === 'PUT')
    await page.keyboard.press('Escape')
    expect((await saving).ok()).toBeTruthy()
    expect(await readAvatar(request, agent.slug)).toEqual(saved)
    await expectAvatar(otherPicker, saved)

    await page.reload()
    await expectAvatar(picker, saved)
    await picker.click()
    await expect(page.getByRole('button', { name: 'Bloom', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Red / Amber', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
  } finally {
    await otherBrowser.close()
    await request.delete(`/api/agents/${agent.slug}`)
  }
})

for (const mode of ['template', 'full']) {
  test(`${mode} imports receive a stored avatar at creation`, async ({ request }, testInfo) => {
    const filePath = await buildAgentTemplateZip(testInfo.outputPath('avatar-import.zip'), {
      name: uniqueName(testInfo, `Avatar ${mode} import`),
    })
    const response = await request.post('/api/agents/import-template', {
      multipart: { file: fs.createReadStream(filePath), mode },
    })
    expect(response.status()).toBe(201)
    const agent = await response.json()
    try {
      const avatar = agentAvatarSchema.parse(agent.avatar)
      expect(await readAvatar(request, agent.slug)).toEqual(avatar)
      const renamed = await request.put(`/api/agents/${agent.slug}`, { data: { name: `${agent.name} renamed` } })
      expect(renamed.ok()).toBeTruthy()
      expect(await readAvatar(request, agent.slug)).toEqual(avatar)
    } finally {
      await request.delete(`/api/agents/${agent.slug}`)
    }
  })
}

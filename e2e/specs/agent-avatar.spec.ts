import { test, expect, type APIRequestContext, type Locator } from '@playwright/test'
import fs from 'node:fs'
import { agentAvatarSchema, type AgentAvatar } from '@shared/lib/types/agent-avatar'
import { createAgent, uniqueName } from '../helpers/agents'
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
    const streamReady = otherPage.waitForResponse(response => response.url().endsWith('/api/notifications/stream'))
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

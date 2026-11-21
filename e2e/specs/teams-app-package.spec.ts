import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'
import { PNG } from 'pngjs'
import { openHomeSection } from '../helpers/agent-home'
import { deleteAgentViaApi } from '../helpers/agents'

test('the manual Teams wizard downloads branded, independently installable apps for two agents', async ({ page, request }) => {
  const colorIcons: Buffer[] = []
  for (const [name, color, shape] of [['Design Partner', 'duo-pink-blue', 'bloom'], ['Build Monitor', 'tonal-green', 'diamond']]) {
    const appId = randomUUID()
    const description = 'Reviews incoming requests with the team.'
    const created = await request.post('/api/agents', { data: { name, description, avatar: { color, shape } } })
    expect(created.ok()).toBeTruthy()
    const agent = await created.json() as { slug: string }
    try {
      await page.goto(`/agents/${agent.slug}`)
      await openHomeSection(page, 'External Integrations')
      await page.getByRole('button', { name: 'Set up Microsoft Teams' }).click()
      const wizard = page.getByRole('dialog', { name: 'Set up integration with Microsoft Teams' })
      await expect(wizard.getByLabel('App name in Teams')).toHaveValue(name)
      await wizard.getByLabel('Application (client) ID').fill(appId)
      const downloadEvent = page.waitForEvent('download')
      await wizard.getByRole('button', { name: 'Download app package' }).click()
      const download = await downloadEvent
      expect(download.suggestedFilename()).toBe(`${agent.slug}-teams.zip`)
      const zip = unzipSync(await readFile((await download.path())!))
      expect(Object.keys(zip).sort()).toEqual(['color.png', 'manifest.json', 'outline.png'])
      expect(JSON.parse(strFromU8(zip['manifest.json']))).toMatchObject({
        id: appId, manifestVersion: '1.25', supportsChannelFeatures: 'tier1', version: '1.0.0', name: { short: name, full: name }, description: { full: description },
        bots: [{ botId: appId, scopes: ['personal', 'team', 'groupChat'], supportsFiles: true }],
        icons: { color: 'color.png', outline: 'outline.png' },
      })
      const colorIcon = PNG.sync.read(Buffer.from(zip['color.png']))
      const outline = PNG.sync.read(Buffer.from(zip['outline.png']))
      expect([colorIcon.width, colorIcon.height]).toEqual([192, 192])
      expect([outline.width, outline.height]).toEqual([32, 32])
      expect(outline.data[3]).toBe(0)
      const solidPixels = []
      for (let i = 0; i < outline.data.length; i += 4) {
        if (outline.data[i + 3] === 255) solidPixels.push(outline.data.subarray(i, i + 3).toString('hex'))
      }
      expect(solidPixels.length).toBeGreaterThan(10)
      expect([...new Set(solidPixels)]).toEqual(['ffffff'])
      colorIcons.push(colorIcon.data)
    } finally {
      await deleteAgentViaApi(request, agent)
    }
  }
  expect(colorIcons[0].equals(colorIcons[1])).toBe(false)
})

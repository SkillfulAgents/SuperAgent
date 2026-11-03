import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createZipBuffer } from '@shared/lib/utils/zip'
import { AppPage } from '../pages/app.page'
import { AgentPage, getCurrentAgentSlug } from '../pages/agent.page'

export interface ZipImportContext {
  page: Page
  request: APIRequestContext
  apiBaseUrl: string
  navigate: (route: string) => Promise<unknown>
}

const agentSchema = z.object({ slug: z.string(), name: z.string() })
const skillSchema = z.object({ skillDir: z.string(), skillName: z.string() })
const binary = Buffer.from(Array.from({ length: 128 * 1024 }, (_, index) => index % 256))

// A ZIP writer correctly refuses traversal names. Corrupt both the local and
// central filename in an otherwise valid archive without changing offsets.
async function traversalZip(instructions: string, content: string) {
  const buffer = await createZipBuffer({ [instructions]: content, 'xx/escape.txt': 'must never be extracted' })
  const original = Buffer.from('xx/escape.txt')
  let matches = 0
  for (let offset = buffer.indexOf(original); offset !== -1; offset = buffer.indexOf(original, offset + original.length)) {
    buffer.write('../escape.txt', offset)
    matches++
  }
  expect(matches).toBe(2)
  return buffer
}

async function submitFile(dialog: Locator, name: string, buffer: Buffer) {
  await dialog.locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/zip', buffer })
  await dialog.locator('button[type="submit"]').click()
}

async function readWorkspaceFile(context: ZipImportContext, slug: string, file: string) {
  const response = await context.request.get(`${context.apiBaseUrl}/api/agents/${slug}/files/${file.split('/').map(encodeURIComponent).join('/')}`)
  expect(response.status()).toBe(200)
  return response.body()
}

async function createAgent(context: ZipImportContext, name: string) {
  const response = await context.request.post(`${context.apiBaseUrl}/api/agents`, { data: { name } })
  expect(response.status()).toBe(201)
  return agentSchema.parse(await response.json())
}

/** Actual dialogs, multipart requests, ZIP parser, database and workspace files. */
export async function checkAgentImportRecovery(context: ZipImportContext) {
  const { page, request, apiBaseUrl, navigate } = context
  const name = `ZIP recovery ${randomUUID()}`
  const instructions = `---\nname: ${name}\n---\n\nPreserve these agent instructions.\n`
  const valid = await createZipBuffer({
    'wrapped/AGENTS.md': instructions,
    'wrapped/.claude/skills/zip-fixture/SKILL.md': '---\nname: zip-fixture\n---\n\nAn imported nested skill.\n',
    'wrapped/.claude/skills/zip-fixture/assets/payload.bin': binary,
    '__MACOSX/._AGENTS.md': 'ignored macOS metadata',
  })
  const created: string[] = []
  try {
    await navigate('/')
    await new AppPage(page).waitForAgentsLoaded()
    await new AgentPage(page).clickCreateAgent()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText('Untitled')
    created.push(getCurrentAgentSlug(page))
    await page.getByRole('button', { name: 'Import an Agent — Import' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import an Agent' })

    for (const [filename, buffer, error] of [
      ['invalid.agent', Buffer.from('not a ZIP archive'), /end of central directory|too small/i],
      ['truncated.agent', valid.subarray(0, valid.length - 22), /end of central directory/i],
      ['traversal.agent', await traversalZip('AGENTS.md', instructions), /invalid relative path/i],
    ] as const) {
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/agents/import-template') && response.request().method() === 'POST')
      await submitFile(dialog, filename, buffer)
      expect((await responsePromise).ok()).toBe(false)
      await expect(dialog.getByText(error)).toBeVisible()
      await expect(dialog.locator('button[type="submit"]')).toBeEnabled()
      const agents = await request.get(`${apiBaseUrl}/api/agents`)
      expect(agents.ok()).toBe(true)
      expect(z.array(agentSchema).parse(await agents.json()).some(agent => agent.name === name)).toBe(false)
    }

    const importedResponse = page.waitForResponse(response => response.url().endsWith('/api/agents/import-template') && response.status() === 201)
    await submitFile(dialog, 'recovered.agent', valid)
    const imported = agentSchema.parse(await (await importedResponse).json())
    created.push(imported.slug)
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
    await expect(page.getByTestId('installed-skill-row').filter({ hasText: 'zip-fixture' })).toBeVisible()
    expect((await readWorkspaceFile(context, imported.slug, 'AGENTS.md')).toString()).toContain('Preserve these agent instructions.')
    expect(await readWorkspaceFile(context, imported.slug, '.claude/skills/zip-fixture/assets/payload.bin')).toEqual(binary)
    await page.reload()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
    await expect(page.getByTestId('installed-skill-row').filter({ hasText: 'zip-fixture' })).toBeVisible()
  } finally {
    for (const slug of created) await request.delete(`${apiBaseUrl}/api/agents/${slug}`)
  }
}

export async function checkSkillImportRoundTrip(context: ZipImportContext) {
  const { page, request, apiBaseUrl, navigate } = context
  const name = `zip-skill-${randomUUID()}`
  const instructions = `---\nname: ${name}\n---\n\nPreserve this nested skill.\n`
  const valid = await createZipBuffer({
    'wrapped/SKILL.md': instructions,
    'wrapped/scripts/check.py': 'print("zip import roundtrip")\n',
    'wrapped/assets/payload.bin': binary,
    '__MACOSX/._SKILL.md': 'ignored macOS metadata',
  })
  const created: string[] = []
  try {
    const agent = await createAgent(context, `ZIP skill source ${randomUUID()}`)
    created.push(agent.slug)
    await navigate(`/agents/${agent.slug}`)
    await new AppPage(page).waitForAgentsLoaded()
    await page.getByTestId('import-skill-button').click()
    const dialog = page.getByRole('dialog', { name: 'Import a Skill' })
    for (const [filename, buffer, error] of [
      ['invalid.skill', Buffer.from('not a ZIP archive'), /end of central directory|too small/i],
      ['truncated.skill', valid.subarray(0, valid.length - 22), /end of central directory/i],
      ['traversal.skill', await traversalZip('SKILL.md', instructions), /invalid relative path/i],
    ] as const) {
      await submitFile(dialog, filename, buffer)
      await expect(dialog.getByTestId('import-skill-error')).toContainText(error)
      await expect(dialog.locator('button[type="submit"]')).toBeEnabled()
      await expect(page.getByTestId('installed-skill-row').filter({ hasText: name })).toHaveCount(0)
    }

    const importedResponse = page.waitForResponse(response => response.url().endsWith(`/api/agents/${agent.slug}/skills/import-zip`) && response.status() === 201)
    await submitFile(dialog, 'nested.skill', valid)
    const imported = skillSchema.parse(await (await importedResponse).json())
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('installed-skill-row').filter({ hasText: name })).toBeVisible()
    expect(await readWorkspaceFile(context, agent.slug, `.claude/skills/${imported.skillDir}/assets/payload.bin`)).toEqual(binary)

    const exported = await request.post(`${apiBaseUrl}/api/agents/${agent.slug}/skills/${imported.skillDir}/export`)
    expect(exported.status()).toBe(200)
    expect(exported.headers()['content-disposition']).toContain('.skill')
    const exportedBytes = await exported.body()
    const destination = await createAgent(context, `ZIP skill destination ${randomUUID()}`)
    created.push(destination.slug)
    await navigate(`/agents/${destination.slug}`)
    await page.getByTestId('import-skill-button').click()
    const reimportResponse = page.waitForResponse(response => response.url().endsWith(`/api/agents/${destination.slug}/skills/import-zip`) && response.status() === 201)
    await submitFile(dialog, 'exported.skill', exportedBytes)
    const reimported = skillSchema.parse(await (await reimportResponse).json())
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('installed-skill-row').filter({ hasText: name })).toBeVisible()
    for (const [file, expected] of Object.entries({ 'SKILL.md': Buffer.from(instructions), 'scripts/check.py': Buffer.from('print("zip import roundtrip")\n'), 'assets/payload.bin': binary })) {
      expect(await readWorkspaceFile(context, destination.slug, `.claude/skills/${reimported.skillDir}/${file}`)).toEqual(expected)
    }
    await page.reload()
    await expect(page.getByTestId('installed-skill-row').filter({ hasText: name })).toBeVisible()
  } finally {
    for (const slug of created) await request.delete(`${apiBaseUrl}/api/agents/${slug}`)
  }
}

/** Force the disk-backed assembled-upload reader without a 50 MB fixture. */
export async function checkChunkedAgentRoundTrip(context: ZipImportContext) {
  const { page, request, apiBaseUrl, navigate } = context
  const name = `ZIP chunks ${randomUUID()}`
  const original = await createZipBuffer({
    'AGENTS.md': `---\nname: ${name}\n---\n\nChunked agent roundtrip.\n`,
    'data/nested/payload.bin': binary,
    'data/empty.txt': '',
  })
  const created: string[] = []
  async function upload(bytes: Buffer) {
    const uploadId = randomUUID()
    const chunkSize = Math.ceil(bytes.length / 3)
    for (let index = 0; index < 3; index++) {
      const response = await request.post(`${apiBaseUrl}/api/agents/import-template`, {
        multipart: {
          chunk: { name: 'chunk', mimeType: 'application/octet-stream', buffer: bytes.subarray(index * chunkSize, (index + 1) * chunkSize) },
          uploadId, chunkIndex: String(index), totalChunks: '3', filename: 'chunked.agent', mode: 'full',
        },
      })
      if (index < 2) {
        expect(response.status()).toBe(200)
        expect(await response.json()).toEqual({ status: 'chunk_received', chunkIndex: index })
      } else return response
    }
    throw new Error('Missing final upload response')
  }
  try {
    const rejected = await upload(original.subarray(0, original.length - 22))
    expect(rejected.ok()).toBe(false)
    expect(z.object({ error: z.string() }).parse(await rejected.json()).error).toMatch(/end of central directory/i)
    const imported = await upload(original)
    expect(imported.status()).toBe(201)
    const agent = agentSchema.parse(await imported.json())
    created.push(agent.slug)
    await navigate(`/agents/${agent.slug}`)
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
    expect(await readWorkspaceFile(context, agent.slug, 'data/nested/payload.bin')).toEqual(binary)
    const exported = await request.post(`${apiBaseUrl}/api/agents/${agent.slug}/export-full`)
    expect(exported.status()).toBe(200)
    expect(exported.headers()['content-disposition']).toContain('.agent')
    const reimport = await upload(await exported.body())
    expect(reimport.status()).toBe(201)
    const restored = agentSchema.parse(await reimport.json())
    created.push(restored.slug)
    expect(restored.slug).not.toBe(agent.slug)
    expect(await readWorkspaceFile(context, restored.slug, 'data/nested/payload.bin')).toEqual(binary)
    expect(await readWorkspaceFile(context, restored.slug, 'data/empty.txt')).toEqual(Buffer.alloc(0))
    await navigate(`/agents/${restored.slug}`)
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
    await page.reload()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
  } finally {
    for (const slug of created) await request.delete(`${apiBaseUrl}/api/agents/${slug}`)
  }
}

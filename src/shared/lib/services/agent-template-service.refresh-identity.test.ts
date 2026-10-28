/**
 * A template refresh that copies the upstream files into the workspace
 * replaces AGENTS.md, and with it the identity projection the host wrote. The
 * catalog row is the authority for the name and description, so the
 * projection has to be restored after every such copy, and the content hash
 * recorded afterwards has to describe the workspace as it then is: otherwise
 * exports and the container's attribution carry the upstream name while the
 * catalog says otherwise, and the next status check reads the projection as a
 * local edit.
 *
 * Runs the real agent service and catalog (in-memory database) against a
 * temp data dir; only the container host and the skillset cache are doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@shared/lib/db/schema'
import type { InstalledAgentMetadata, SkillsetConfig } from '@shared/lib/types/skillset'

let testDb: ReturnType<typeof drizzle>
let sqlite: InstanceType<typeof Database>
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      getClient: vi.fn(() => ({ getInfo: vi.fn(async () => ({ status: 'stopped', port: null })) })),
      getCachedInfo: vi.fn(() => ({ status: 'stopped', port: null })),
      stopContainer: vi.fn(async () => {}),
      getHealthWarnings: vi.fn(() => []),
      removeClient: vi.fn(),
    }),
  }
})
vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: { getPendingReviewsForAgent: vi.fn(() => []) },
}))

// The skillset cache is a directory this suite writes; nothing is fetched.
let cacheRoot: string
const queueStatuses = new Map<string, string | null>()
vi.mock('@shared/lib/services/skillset-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/services/skillset-service')>()
  return {
    ...actual,
    getSkillsetRepoDir: (id: string) => path.join(cacheRoot, id),
    refreshSkillset: vi.fn(async () => ({ agents: [] })),
    readIndexJson: vi.fn(async () => ({ agents: [] })),
  }
})
vi.mock('@shared/lib/skillset-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/skillset-provider')>()
  return {
    ...actual,
    getSkillsetProvider: (provider?: string) => {
      const real = actual.getSkillsetProvider(provider as never)
      return Object.assign(Object.create(real), {
        getQueueItemStatuses: async (ids: string[]) => new Map(ids.map((id) => [id, queueStatuses.get(id) ?? null])),
      })
    },
  }
})

import { agentCatalog, agentRegistry, identityFromInstructions } from '@shared/lib/agent-actor'
import { createAgent, getAgentInstructionsContent, updateAgent } from './agent-service'
import { computeWorkspaceTemplateHash, refreshAgentTemplates } from './agent-template-service'

let dataDir: string
let previousDataDir: string | undefined

const skillset: SkillsetConfig = {
  id: 'test-skillset',
  url: 'https://github.com/example/test-skillset',
  name: 'Test Skillset',
  provider: 'github',
} as SkillsetConfig

const UPSTREAM_INSTRUCTIONS = '---\nname: Upstream Name\ndescription: Upstream description\n---\n# Upstream body\n'

async function writeUpstreamTemplate(agentPath: string, instructionsFile = 'AGENTS.md'): Promise<string> {
  const dir = path.join(cacheRoot, skillset.id, agentPath)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, instructionsFile), UPSTREAM_INSTRUCTIONS)
  await fs.promises.writeFile(path.join(dir, 'README.md'), '# From upstream\n')
  return dir
}

async function installedAgent(meta: Partial<InstalledAgentMetadata>): Promise<string> {
  const created = await createAgent({ name: 'Installed Name', description: 'Installed description' })
  const actor = agentRegistry.get(created.slug)
  await actor.config.put('skillsetMetadata', {
    skillsetId: skillset.id,
    skillsetUrl: skillset.url,
    agentName: 'Installed Name',
    agentPath: 'agents/tpl/',
    installedVersion: '1.0.0',
    installedAt: new Date().toISOString(),
    originalContentHash: await computeWorkspaceTemplateHash(actor.files),
    provider: 'github',
    skillsetName: skillset.name,
    ...meta,
  })
  // The person renamed the agent after installing it.
  await updateAgent(created.slug, { name: 'Chosen Name', description: 'Chosen description' })
  return created.slug
}

async function expectProjectedIdentity(slug: string): Promise<void> {
  const content = await getAgentInstructionsContent(slug)
  expect(content).not.toBeNull()
  expect(identityFromInstructions(content!)).toMatchObject({ name: 'Chosen Name', description: 'Chosen description' })
  expect(content).toContain('# Upstream body')
  const meta = (await agentRegistry.get(slug).config.get('skillsetMetadata')) as InstalledAgentMetadata
  expect(meta.originalContentHash).toBe(await computeWorkspaceTemplateHash(agentRegistry.get(slug).files))
  expect(await fs.promises.readFile(path.join(dataDir, 'agents', slug, 'workspace', 'README.md'), 'utf-8')).toBe('# From upstream\n')
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'template-refresh-identity-'))
  cacheRoot = path.join(dataDir, 'skillset-cache')
  previousDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = dataDir
  queueStatuses.clear()
})

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
  sqlite.close()
  await fs.promises.rm(dataDir, { recursive: true, force: true })
})

describe('refreshAgentTemplates keeps the catalog identity in the instructions', () => {
  it.each(['CLAUDE.md', 'AGENTS.md'])('after a merged platform submission with %s is copied in', async (name) => {
    await writeUpstreamTemplate('agents/tpl', name)
    const slug = await installedAgent({ pendingQueueItemId: 'queue-1' })
    // A legacy workspace must not shadow the incoming canonical document.
    await agentRegistry.get(slug).files.putDoc('CLAUDE.md', new TextEncoder().encode('# Old legacy instructions'))
    queueStatuses.set('queue-1', 'merged')

    await refreshAgentTemplates([skillset])

    await expectProjectedIdentity(slug)
    expect(await agentRegistry.get(slug).files.getDoc('CLAUDE.md')).toBeNull()
    const meta = (await agentRegistry.get(slug).config.get('skillsetMetadata')) as InstalledAgentMetadata
    expect(meta.pendingQueueItemId).toBeUndefined()
    expect((await agentCatalog.get(slug))?.name).toBe('Chosen Name')
  })

  it('preserves independent instructions when the upstream template contains both names', async () => {
    const upstream = await writeUpstreamTemplate('agents/tpl', 'CLAUDE.md')
    await fs.promises.writeFile(path.join(upstream, 'AGENTS.md'), '# Independent instructions\n')
    const slug = await installedAgent({ pendingQueueItemId: 'both-files' })
    queueStatuses.set('both-files', 'merged')

    await refreshAgentTemplates([skillset])

    await expectProjectedIdentity(slug)
    const bytes = await agentRegistry.get(slug).files.getDoc('AGENTS.md')
    expect(new TextDecoder().decode(bytes!)).toBe('# Independent instructions\n')
  })

  it('after upstream moved forward while a PR was open', async () => {
    await writeUpstreamTemplate('agents/tpl')
    // The recorded hash is neither the workspace's nor the repo's: local
    // edits since the install, and upstream that has moved on.
    const slug = await installedAgent({ openPrUrl: 'https://example.test/pr/1', originalContentHash: 'stale' })

    await refreshAgentTemplates([skillset])

    await expectProjectedIdentity(slug)
    const meta = (await agentRegistry.get(slug).config.get('skillsetMetadata')) as InstalledAgentMetadata
    expect(meta.openPrUrl).toBeUndefined()
    expect((await agentCatalog.get(slug))?.name).toBe('Chosen Name')
  })
})

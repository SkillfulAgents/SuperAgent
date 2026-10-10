import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { RuntimeStatusUnavailableError } from '@shared/lib/container/volume-stop-schema'

let database: TestDatabase
let directory: string
const { inspect, cachedStatus } = vi.hoisted(() => ({
  inspect: vi.fn(),
  cachedStatus: vi.fn(),
}))
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return { containerHost: hostFromManagerMock({
    getClient: () => ({ getInfo: inspect }),
    getCachedInfo: cachedStatus,
    getHealthWarnings: () => [],
    removeClient: vi.fn(),
  }) }
})
vi.mock('@shared/lib/proxy/review-manager', () => ({ reviewManager: { getPendingReviewsForAgent: () => [] } }))

import { createAgent, updateAgent, getAgent } from './agent-service'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
let slug: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'agent-edit-status-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', directory)
  database = await createTestDatabase()
  vi.clearAllMocks()
  inspect.mockRejectedValue(new RuntimeStatusUnavailableError('inspect timed out'))
  cachedStatus.mockReturnValue({ status: 'running', port: 4001 })
  slug = (await createAgent({ name: 'Original', description: 'Original description', instructions: 'Original instructions' })).slug
})
afterEach(async () => {
  agentRegistry.evict(slug)
  await database.close()
  await rm(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('agent edits during runtime unavailability', () => {
  it('saves identity and instructions and returns the last observed status without inspecting the VM', async () => {
    const updates = { name: 'Renamed', description: 'Updated description', instructions: 'Updated instructions' }
    await expect(updateAgent(slug, updates)).resolves.toMatchObject({ ...updates, status: 'running', containerPort: 4001 })
    expect(await agentCatalog.get(slug)).toMatchObject({ name: updates.name, description: updates.description })
    expect(await getAgent(slug)).toMatchObject({ frontmatter: { name: updates.name, description: updates.description }, instructions: updates.instructions })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('returns a stopped observation without trying to start or inspect a container', async () => {
    cachedStatus.mockReturnValue({ status: 'stopped', port: null })
    await expect(updateAgent(slug, { name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed', status: 'stopped', containerPort: null })
    expect(inspect).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { teamDirectories } from '@shared/lib/db/schema'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('@shared/lib/db', () => ({ get db() { return state.db } }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'team-directory-test-secret' }))

import {
  connectProvisioning,
  createAgentApp,
  disconnectProvisioning,
  findProvisioner,
  rotateAllProvisioning,
  rotateProvisioning,
} from './provisioning'
import { PROVISIONING_ROTATION_INTERVAL_MS, TeamDirectoryProvisioningService } from './service'
import { registerDirectoryProvider } from './registry'
import { getDirectoryConnection, saveDirectoryConnection } from './store'
import { openDirectoryCredentials } from './credentials'
import { createFakeDirectoryProvider, type FakeDirectory } from './testing/fake-directory-provider'
import { DirectoryConnectError } from './types'
import { taskManager } from '@shared/lib/background-work'
import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'

let handle: TestDatabase
let fake: FakeDirectory
let unregister: () => void
let directoryId: string

async function storedPair() {
  const row = await handle.db.select().from(teamDirectories).where(eq(teamDirectories.id, directoryId)).get()
  return row?.provisioningCredentials
    ? await openDirectoryCredentials('fake:provisioning', 'acme', row.provisioningCredentials) as { key: string; generation: number }
    : null
}
const rotations = () => fake.provisioner.calls.filter((call) => call.op === 'rotate').length

beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  fake = createFakeDirectoryProvider('fake', 'Fake Directory', { provisionFor: 'test-app' })
  unregister = registerDirectoryProvider(fake.provider)
  directoryId = (await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'acme-token' }, createdByUserId: null })).id
})

afterEach(async () => {
  vi.useRealTimers()
  await backgroundSettled()
  unregister()
  await handle.close()
})

describe('provisioning credentials', () => {
  it('are verified, sealed apart from the directory’s own, and offer the directory to its integration', async () => {
    expect(await findProvisioner('test-app')).toBeNull()
    await connectProvisioning(directoryId, { key: 'admin-key' })

    const row = await handle.db.select().from(teamDirectories).where(eq(teamDirectories.id, directoryId)).get()
    expect(row?.provisioningCredentials).not.toContain('admin-key')
    expect(row).toMatchObject({ provisioningStatus: 'active', provisioningError: null })
    expect(await storedPair()).toMatchObject({ key: 'admin-key', generation: 1 })
    expect(await findProvisioner('test-app')).toEqual({ directoryId, workspace: 'Acme' })
    expect(await findProvisioner('other-app')).toBeNull()
    // The directory's own listing credentials are untouched.
    expect((await getDirectoryConnection(directoryId))?.revision).toBe(1)
  })

  it('refuses what the provider refuses, and a directory that cannot create apps', async () => {
    await expect(connectProvisioning(directoryId, { key: 'bad' })).rejects.toThrow('That key is no good')
    const plain = createFakeDirectoryProvider('plain', 'Plain')
    const unregisterPlain = registerDirectoryProvider(plain.provider)
    const other = await saveDirectoryConnection({ provider: 'plain', tenant: { tenantId: 'x', tenantName: 'X' }, credentials: { token: 'x-token' }, createdByUserId: null })
    await expect(connectProvisioning(other.id, { key: 'k' })).rejects.toBeInstanceOf(DirectoryConnectError)
    unregisterPlain()
  })

  it('stop offering the directory once removed', async () => {
    await connectProvisioning(directoryId, { key: 'admin-key' })
    await disconnectProvisioning(directoryId)
    expect(await findProvisioner('test-app')).toBeNull()
    expect(await storedPair()).toBeNull()
  })
})

describe('rotation', () => {
  beforeEach(async () => { await connectProvisioning(directoryId, { key: 'admin-key' }) })

  it('rotates only when due, and saves the new pair', async () => {
    expect(await rotateProvisioning(directoryId)).toBe('fresh')
    expect(rotations()).toBe(0)
    expect(await rotateProvisioning(directoryId, { force: true })).toBe('rotated')
    expect(await storedPair()).toMatchObject({ generation: 2 })

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11.5 * 60 * 60_000)
    await rotateAllProvisioning()
    expect(await storedPair()).toMatchObject({ generation: 3 })
  })

  it('rotates once when two processes find the pair due at the same time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11.5 * 60 * 60_000)
    const results = await Promise.all([rotateProvisioning(directoryId), rotateProvisioning(directoryId)])
    expect(results.sort()).toEqual(['fresh', 'rotated'])
    expect(rotations()).toBe(1)
  })

  it('keeps a pair an admin added while a rotation was in flight', async () => {
    const release = fake.provisioner.holdRotations()
    const rotating = rotateProvisioning(directoryId, { force: true })
    await vi.waitFor(() => expect(rotations()).toBe(1))
    await connectProvisioning(directoryId, { key: 'new-admin-key' })
    release()
    expect(await rotating).toBe('failed')
    expect(await storedPair()).toMatchObject({ key: 'new-admin-key' })
  })

  it('marks the directory as needing a new token when the chain breaks; installed apps are untouched', async () => {
    fake.provisioner.failRotation('broken')
    expect(await rotateProvisioning(directoryId, { force: true })).toBe('broken')
    expect(await getDirectoryConnection(directoryId)).toMatchObject({ provisioningStatus: 'needs_reconnect', provisioningError: 'The fake chain is broken' })
    expect(await findProvisioner('test-app')).toBeNull()
    await expect(createAgentApp({ directoryId, integrationProvider: 'test-app', identity: { name: 'Agent' }, webhookUrl: 'https://relay.test/h', redirectUrl: 'https://app.test/cb' }))
      .rejects.toThrow('needs a new app configuration token')

    // An admin adds a new one, and it works again.
    await connectProvisioning(directoryId, { key: 'fresh-key' })
    expect(await findProvisioner('test-app')).not.toBeNull()
  })

  it('keeps the pair through a provider outage, for the next pass to try again', async () => {
    fake.provisioner.failRotation('transient')
    expect(await rotateProvisioning(directoryId, { force: true })).toBe('failed')
    expect(await getDirectoryConnection(directoryId)).toMatchObject({ provisioningStatus: 'active' })
    expect(await storedPair()).toMatchObject({ generation: 1 })
  })

  it('rotates a due pair before it creates an app with it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11.5 * 60 * 60_000)
    await createAgentApp({ directoryId, integrationProvider: 'test-app', identity: { name: 'Agent' }, webhookUrl: 'https://relay.test/h', redirectUrl: 'https://app.test/cb' })
    expect(fake.provisioner.calls.map((call) => [call.op, call.detail.generation])).toEqual([['rotate', 1], ['create', 2]])
  })

  it('runs every six hours as a background pass', async () => {
    const service = new TeamDirectoryProvisioningService()
    registerTasks(service)
    await service.start()
    expect((taskManager() as unknown as { scheduled(): Array<{ id: string; recurring: boolean }> }).scheduled())
      .toEqual([expect.objectContaining({ id: 'team-directory.rotate-provisioning', recurring: true })])
    // Twice a token's 12-hour life.
    expect(PROVISIONING_ROTATION_INTERVAL_MS).toBe(6 * 60 * 60_000)
    service.stop()
  })
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agentAcl, agents, user } from '@shared/lib/db/schema'
import { changeAgentShare, listAgentShares } from './agent-sharing-service'
import { deleteTargetGrant, evaluate, getPolicy, setPolicy } from './x-agent-policy-service'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
beforeEach(async () => { handle = await createTestDatabase() })
afterEach(async () => { await handle.close() })

it('counts visible direct grants and resolves inherited access only for the open roster', async () => {
  const now = new Date()
  const slugs = ['target', 'direct', 'inherited', 'private', 'suppressed', 'reader', 'unrelated']
  await handle.db.insert(agents).values(slugs.map(slug => ({ slug, name: slug, createdAt: now }))).run()
  await handle.db.insert(user).values(['viewer', 'owner', 'guest'].map(id => ({ id, name: id, email: id + '@example.test' }))).run()
  const acl = async (userId: string, slug: string, role: 'owner' | 'user' | 'viewer') =>
    handle.db.insert(agentAcl).values({ id: userId + slug, userId, agentSlug: slug, role, createdAt: now }).run()
  for (const slug of slugs.filter(s => s !== 'private')) await acl('viewer', slug, 'viewer')
  for (const slug of ['direct', 'inherited', 'private', 'suppressed']) await acl('owner', slug, 'owner')
  await acl('owner', 'target', 'user')
  await acl('guest', 'target', 'viewer')
  await acl('guest', 'reader', 'owner')
  for (const slug of slugs) await setPolicy(slug, 'invoke', null, 'allow')
  await setPolicy('reader', 'read', 'target', 'allow')
  await setPolicy('direct', 'read', 'target', 'allow')
  await setPolicy('suppressed', 'invoke', 'target', 'review')

  const stack = await listAgentShares(['target'], 'viewer')
  expect(stack.target.direct.map(a => [a.slug, a.role])).toEqual([['direct', 'user'], ['reader', 'viewer']])
  expect(stack.target.global).toEqual([])
  const open = await listAgentShares(['target'], 'viewer', true)
  expect(open.target.direct).toEqual(stack.target.direct)
  expect(open.target.global.map(a => a.slug)).toEqual(['inherited'])
})

it('edits only this direction, preserves restrictions, and removes only direct grants', async () => {
  await setPolicy('target', 'read', 'caller', 'block')
  await setPolicy('caller', 'read', null, 'allow')
  await setPolicy('caller', 'invoke', null, 'allow')
  await changeAgentShare('caller', 'target', 'user')
  expect(await evaluate('caller', 'invoke', 'target')).toBe('allow')
  await changeAgentShare('caller', 'target', 'viewer')
  expect(await evaluate('caller', 'invoke', 'target')).toBe('review')
  expect(await deleteTargetGrant('caller', 'invoke', 'target')).toBe(0)
  await changeAgentShare('caller', 'target', 'remove')
  expect(await getPolicy('caller', 'read', 'target')).toBeNull()
  expect(await evaluate('caller', 'read', 'target')).toBe('allow')
  expect(await evaluate('caller', 'invoke', 'target')).toBe('review')
  expect(await evaluate('target', 'read', 'caller')).toBe('block')

  await changeAgentShare('other', 'target', 'viewer')
  await setPolicy('other', 'invoke', null, 'allow')
  expect(await evaluate('other', 'invoke', 'target')).toBe('review')

  await setPolicy('caller', 'invoke', 'target', 'block')
  await changeAgentShare('caller', 'target', 'viewer')
  await changeAgentShare('caller', 'target', 'remove')
  expect(await evaluate('caller', 'invoke', 'target')).toBe('block')
})

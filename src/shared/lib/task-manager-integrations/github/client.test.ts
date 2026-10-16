import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verify } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
import { createAgentIntegration, deleteAgentIntegration, updateAgentIntegration } from '../../services/agent-integration-service'
import { GitHubClient, githubAppJwt } from './client'
import { configured, appIdentity, privateKey } from './test-fixtures'
import { readGitHubIntegration, updateGitHubConfig } from './store'
let id: string
let client: GitHubClient
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const tokenResponse = () => Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() })
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'github', config: configured })
  client = new GitHubClient(id)
  fetchMock = vi.fn<typeof fetch>(async () => tokenResponse()); vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { await handle.close(); vi.unstubAllGlobals() })
it('signs a bounded app JWT and coalesces installation token minting across clients', async () => {
  const jwt = githubAppJwt(appIdentity)
  const [header, payload, signature] = jwt.split('.')
  expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey, Buffer.from(signature, 'base64url'))).toBe(true)
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: '123' })
  expect(await Promise.all([client.authorization(), new GitHubClient(id).authorization()])).toEqual(['installation-token', 'installation-token'])
  expect(await client.authorization()).toBe('installation-token')
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/app/installations/456/access_tokens')
})
it.each(['paused', 'delete', 'replace'] as const)('rejects renewal if authorization changes during the request: %s', async change => {
  let release!: (value: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const request = client.authorization()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  if (change === 'delete') await deleteAgentIntegration(id)
  else if (change === 'paused') await updateAgentIntegration(id, { status: 'paused' })
  else await updateGitHubConfig(id, value => ({ ...value, authorizationVersion: 'new-version' }))
  release(tokenResponse())
  await expect(request).rejects.toThrow()
})
it.each([401, 404])('marks conclusive installation revocation as reconnect needed (%s)', async status => {
  fetchMock.mockResolvedValueOnce(new Response('secret upstream body', { status }))
  await expect(client.authorization()).rejects.toThrow(`GitHub request failed (${status})`)
  const current = await readGitHubIntegration(id)
  expect(current.row.status).toBe('disconnected')
  expect(current.config.authorizationError).toContain('Reconnect')
})
it.each([403, 429, 500])('keeps authorization on a transient mint failure (%s)', async status => {
  fetchMock.mockResolvedValueOnce(new Response('', { status }))
  await expect(client.authorization()).rejects.toThrow()
  expect((await readGitHubIntegration(id)).row.status).toBe('active')
  expect(await client.authorization()).toBe('installation-token')
})
it('does not revoke a replacement after an old mint fails', async () => {
  let release!: (value: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const request = client.authorization()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  await updateGitHubConfig(id, value => ({ ...value, authorizationVersion: 'replacement' }))
  release(new Response('', { status: 401 }))
  await expect(request).rejects.toThrow()
  expect((await readGitHubIntegration(id)).row.status).toBe('active')
  await expect(client.authorization({ version: configured.authorizationVersion, agentSlug: 'agent' })).rejects.toThrow('changed')
})

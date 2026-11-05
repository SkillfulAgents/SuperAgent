import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verify } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
import { closeAppState, createLocalAppState, defineLease, initializeAppState, LocalAppStateBackend } from '../../app-state'
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
it('mints again within 60 seconds of expiry, and not before', async () => {
  const expiringIn = (ms: number) => Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + ms).toISOString() })
  fetchMock.mockResolvedValueOnce(expiringIn(61000))
  await client.authorization(); await client.authorization()
  expect(fetchMock).toHaveBeenCalledOnce()
  // Another integration: the first one's token is cached.
  const soon = new GitHubClient(await createAgentIntegration({ agentSlug: 'other', provider: 'github', config: { ...configured, app: { ...appIdentity, id: '124' } } }))
  fetchMock.mockClear(); fetchMock.mockResolvedValueOnce(expiringIn(59000))
  await soon.authorization(); await soon.authorization()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

describe('installation token minting across processes', () => {
  /** A fresh copy of the client module, with its own token cache, sharing the database and AppState. */
  async function instance(): Promise<typeof import('./client')> {
    vi.resetModules()
    return import('./client')
  }
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it('never mints for one authorization in two processes at once; each then mints its own token', async () => {
    const a = await instance()
    const b = await instance()
    let minting = 0
    let mostAtOnce = 0
    const releases: Array<() => void> = []
    fetchMock.mockImplementation(async () => {
      mostAtOnce = Math.max(mostAtOnce, ++minting)
      await new Promise<void>(resolve => releases.push(resolve))
      minting--
      return tokenResponse()
    })
    const first = new a.GitHubClient(id).authorization()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const second = new b.GitHubClient(id).authorization()
    await pause(150)
    expect(fetchMock).toHaveBeenCalledOnce()
    releases[0]()
    await expect(first).resolves.toBe('installation-token')
    // The claim is free again; B mints its own, since tokens are not shared.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    releases[1]()
    await expect(second).resolves.toBe('installation-token')
    expect(mostAtOnce).toBe(1)
  })

  it('mints once a dead holder\'s claim has lapsed', async () => {
    let clock = Date.now()
    await closeAppState()
    await initializeAppState(createLocalAppState({ backend: new LocalAppStateBackend({ now: () => clock }) }))
    // Another process took the claim and died holding it.
    const otherProcess = defineLease({ name: 'claim:github-token', ttlMs: 30000 })
    expect(await otherProcess.acquire(otherProcess.key(id, configured.authorizationVersion!))).not.toBeNull()
    const request = client.authorization()
    await pause(150)
    expect(fetchMock).not.toHaveBeenCalled()
    clock += 30000
    await expect(request).resolves.toBe('installation-token')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

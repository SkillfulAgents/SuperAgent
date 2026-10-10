import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { accountRow, lookup, forward, audit, owner } = vi.hoisted(() => {
  const accountRow = { id: 'account', toolkitSlug: 'dropbox', status: 'active', userId: 'alice', providerName: 'composio', providerConnectionId: 'connection' }
  return { accountRow, lookup: vi.fn(), forward: vi.fn(), audit: vi.fn(), owner: vi.fn() }
})
vi.mock('@shared/lib/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: lookup }) }) }) } }))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => ({ makeApiCall: forward }) }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { fromResourceCreator: owner }, runWithAttribution: (_owner: unknown, run: () => unknown) => run(),
}))
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: audit }))
import { dropboxRequest, withDropboxAccount } from './dropbox-client'

const request = (endpoint: Parameters<typeof dropboxRequest>[1] = 'list_folder') =>
  dropboxRequest('account', endpoint, { path: '/Team' }, { agentSlug: 'agent' })

beforeEach(() => {
  vi.resetAllMocks()
  // Start later each test so cooldown state from a previous test has expired.
  vi.useFakeTimers({ now: new Date('2030-01-01').getTime() + testNumber++ * 100_000 })
  lookup.mockResolvedValue(accountRow)
  owner.mockResolvedValue(null)
  forward.mockImplementation(async () => Response.json({ ok: true }))
})
let testNumber = 0
afterEach(() => { vi.useRealTimers() })

describe('Dropbox request pacing and attribution', () => {
  it('honors Retry-After and delays other calls on the account without blocking a different account', async () => {
    forward.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': '2' } }))
    const first = request()
    await vi.advanceTimersByTimeAsync(0)
    expect(forward).toHaveBeenCalledOnce()
    const second = request('get_metadata')
    await vi.advanceTimersByTimeAsync(0)
    expect(forward).toHaveBeenCalledOnce()
    lookup.mockResolvedValueOnce({ ...accountRow, id: 'other' })
    await dropboxRequest('other', 'get_metadata', {})
    expect(forward).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(forward).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(forward).toHaveBeenCalledTimes(4)
    expect(audit).not.toHaveBeenCalled()
  })

  it.each([429, 409])('backs off on namespace contention (%i) even with Retry-After zero', async status => {
    forward.mockResolvedValueOnce(Response.json({ error_summary: 'path/too_many_write_operations/' }, { status, headers: { 'Retry-After': '0' } }))
    const bytes = new Uint8Array([1, 0, 255]).buffer
    const pending = dropboxRequest('account', 'upload', {}, { bytes, agentSlug: 'agent' })
    await vi.advanceTimersByTimeAsync(249)
    expect(forward).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(forward).toHaveBeenCalledTimes(2)
    expect(forward.mock.calls.every(([call]) => call.body === bytes)).toBe(true)
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ statusCode: 200 }), { analytics: false })
  })

  it('handles structured rate-limit errors and stops after a bounded number of retries', async () => {
    forward.mockImplementation(async () => Response.json({ error: { reason: { '.tag': 'too_many_requests' }, retry_after: 1 } }, { status: 429 }))
    const pending = request().catch(error => error)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toMatchObject({ status: 429, retryAfter: 2 })
    expect(forward).toHaveBeenCalledTimes(4)
  })

  it.each(['60', 'HTTP-date'])('returns a long cooldown to the caller instead of holding the request: %s', async value => {
    const header = value === 'HTTP-date' ? new Date(Date.now() + 60_000).toUTCString() : value
    forward.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': header } }))
    await expect(request()).rejects.toMatchObject({ status: 429, retryAfter: expect.any(Number) })
    expect(forward).toHaveBeenCalledOnce()
  })

  it('does not replay a mutation after a transport failure or a 5xx with an uncertain result', async () => {
    forward.mockRejectedValueOnce(new Error('connection reset'))
    await expect(request('move_v2')).rejects.toMatchObject({ status: 503 })
    forward.mockResolvedValueOnce(Response.json({}, { status: 502 }))
    await expect(request('upload')).rejects.toMatchObject({ status: 503 })
    expect(forward).toHaveBeenCalledTimes(2)
  })

  it('resolves account and owner once per operation, but checks revocation for the next operation', async () => {
    await withDropboxAccount('account', async () => {
      await request()
      await request('list_folder/continue')
      await request('get_metadata')
    })
    expect(lookup).toHaveBeenCalledOnce()
    expect(owner).toHaveBeenCalledOnce()
    lookup.mockResolvedValueOnce({ ...accountRow, status: 'expired' })
    await expect(withDropboxAccount('account', () => request())).rejects.toMatchObject({ code: 'not-accessible' })
    expect(forward).toHaveBeenCalledTimes(3)
  })

  it('audits published mutations only, without analytics or one row per staging chunk', async () => {
    for (const endpoint of ['get_metadata', 'download', 'upload_session/start', 'upload_session/append_v2', 'upload_session/finish', 'create_folder_v2', 'delete_v2', 'move_v2'] as const) await request(endpoint)
    expect(audit.mock.calls.map(([entry]) => entry.targetPath)).toEqual([
      '2/files/upload_session/finish', '2/files/create_folder_v2', '2/files/delete_v2', '2/files/move_v2',
    ])
    expect(audit.mock.calls.every(([, options]) => options.analytics === false)).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { OpError } from '@shared/lib/onepassword/op-client'
import type { OpAccount, OpLoginItem } from '@shared/lib/onepassword/op-schema'
import { OnePasswordRuntime, type OnePasswordOps } from './onepassword-runtime'

function account(uuid: string): OpAccount {
  return { account_uuid: uuid }
}

function login(id: string, title: string, href?: string, username?: string): OpLoginItem {
  return {
    id,
    title,
    category: 'LOGIN',
    urls: href ? [{ href }] : [],
    fields: username ? [{ id: 'username', value: username }] : [],
  }
}

function ops(overrides: Partial<OnePasswordOps> = {}): OnePasswordOps {
  return {
    listAccounts: vi.fn().mockResolvedValue([account('ACC1')]),
    listLoginItems: vi.fn().mockResolvedValue([login('item1', 'Mail', 'https://mail.corp.com', 'a@x.com')]),
    readLoginFields: vi.fn().mockResolvedValue({ username: 'a@x.com', password: 's3cret' }),
    opBinaryPresent: vi.fn().mockReturnValue(true),
    appPresent: vi.fn().mockReturnValue(true),
    ...overrides,
  }
}

async function readyRuntime(backend: OnePasswordOps): Promise<OnePasswordRuntime> {
  const runtime = new OnePasswordRuntime(backend)
  await runtime.connect()
  await vi.waitFor(() => {
    expect(runtime.state().state).toBe('ready')
  })
  return runtime
}

describe('OnePasswordRuntime', () => {
  it('prerequisites and state never invoke ops functions', () => {
    const backend = ops()
    const runtime = new OnePasswordRuntime(backend)
    expect(runtime.prerequisites()).toEqual({ opInstalled: true, appInstalled: true })
    expect(runtime.state()).toEqual({ state: 'none' })
    expect(backend.listAccounts).not.toHaveBeenCalled()
    expect(backend.listLoginItems).not.toHaveBeenCalled()
    expect(backend.readLoginFields).not.toHaveBeenCalled()
  })

  it('connect coalesces concurrent callers onto one attempt', async () => {
    let release!: (accounts: OpAccount[]) => void
    const backend = ops({
      listAccounts: vi.fn().mockReturnValue(new Promise<OpAccount[]>((resolve) => {
        release = resolve
      })),
    })
    const runtime = new OnePasswordRuntime(backend)
    const first = runtime.connect()
    const second = runtime.connect()
    expect(backend.listAccounts).toHaveBeenCalledTimes(1)
    release([account('ACC1')])
    await Promise.all([first, second])
    expect(backend.listAccounts).toHaveBeenCalledTimes(1)
  })

  it('a build failure lands in failed with the taxonomy code and message', async () => {
    const backend = ops({
      listAccounts: vi.fn().mockRejectedValue(new OpError('not_signed_in', 'no account found')),
    })
    const runtime = new OnePasswordRuntime(backend)
    await expect(runtime.connect()).rejects.toMatchObject({ code: 'not_signed_in' })
    expect(runtime.state()).toEqual({
      state: 'failed',
      code: 'not_signed_in',
      message: 'no account found',
    })
  })

  it('connect clears a prior failed state', async () => {
    const backend = ops({
      listAccounts: vi.fn()
        .mockRejectedValueOnce(new OpError('unlock_denied', 'canceled'))
        .mockResolvedValue([account('ACC1')]),
    })
    const runtime = new OnePasswordRuntime(backend)
    await expect(runtime.connect()).rejects.toMatchObject({ code: 'unlock_denied' })
    expect(runtime.state().state).toBe('failed')
    await runtime.connect()
    expect(runtime.isWarming() || runtime.state().state === 'ready').toBe(true)
    await vi.waitFor(() => {
      expect(runtime.state().state).toBe('ready')
    })
  })

  it('a per-account failure keeps other accounts items; all-fail lands failed', async () => {
    const backend = ops({
      listAccounts: vi.fn().mockResolvedValue([account('GOOD'), account('BAD')]),
      listLoginItems: vi.fn().mockImplementation(async (uuid: string) => {
        if (uuid === 'BAD') throw new OpError('unknown', 'vault locked')
        return [login('item1', 'Mail', 'https://mail.corp.com')]
      }),
    })
    const runtime = await readyRuntime(backend)
    expect(runtime.listCandidates('https://mail.corp.com/login')).toHaveLength(1)

    const allFail = ops({
      listAccounts: vi.fn().mockResolvedValue([account('A'), account('B')]),
      listLoginItems: vi.fn().mockRejectedValue(new OpError('unlock_denied', 'denied')),
    })
    const failed = new OnePasswordRuntime(allFail)
    await failed.connect()
    await vi.waitFor(() => {
      expect(failed.state()).toMatchObject({ state: 'failed', code: 'unlock_denied' })
    })
  })

  it('retrieve parses accountUuid from the providerKey and binds the call', async () => {
    const backend = ops()
    const runtime = await readyRuntime(backend)
    const [candidate] = runtime.listCandidates('https://mail.corp.com/login')
    await expect(runtime.retrieve(candidate.providerKey)).resolves.toEqual({
      username: 'a@x.com',
      password: 's3cret',
    })
    expect(backend.readLoginFields).toHaveBeenCalledWith('item1', 'ACC1', expect.any(AbortSignal))
  })

  it('retrieve on a deleted item evicts it from the index', async () => {
    const backend = ops({
      readLoginFields: vi.fn().mockRejectedValue(new OpError('item_unreadable', 'gone')),
    })
    const runtime = await readyRuntime(backend)
    const [candidate] = runtime.listCandidates('https://mail.corp.com/login')
    await expect(runtime.retrieve(candidate.providerKey)).rejects.toMatchObject({
      code: 'item_unreadable',
    })
    expect(runtime.listCandidates('https://mail.corp.com/login')).toEqual([])
  })

  it('shutdown during a build resets to none and discards the late rejection (epoch)', async () => {
    let finishList!: (error: OpError) => void
    const backend = ops({
      listLoginItems: vi.fn().mockReturnValue(new Promise<never>((_resolve, reject) => {
        finishList = reject
      })),
    })
    const runtime = new OnePasswordRuntime(backend)
    await runtime.connect()
    expect(runtime.isWarming()).toBe(true)
    await runtime.shutdown()
    expect(runtime.state()).toEqual({ state: 'none' })
    finishList(new OpError('unknown', 'late'))
    await Promise.resolve()
    expect(runtime.state()).toEqual({ state: 'none' })
  })

  it('a non-OpError vault load lands in failed instead of hanging on building', async () => {
    const backend = ops({
      listLoginItems: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const runtime = new OnePasswordRuntime(backend)
    await runtime.connect()
    await vi.waitFor(() => {
      expect(runtime.state()).toEqual({
        state: 'failed',
        code: 'unknown',
        message: 'boom',
      })
    })
  })

  it('shutdown cancels an in-flight retrieve', async () => {
    const backend = ops({
      readLoginFields: vi.fn().mockImplementation((
        _itemId: string,
        _accountUuid: string,
        signal?: AbortSignal,
      ) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new OpError('timeout', 'canceled'))
        })
      })),
    })
    const runtime = await readyRuntime(backend)
    const [candidate] = runtime.listCandidates('https://mail.corp.com/login')
    const pending = runtime.retrieve(candidate.providerKey)
    await runtime.shutdown()
    await expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'canceled' })
    expect(runtime.state()).toEqual({ state: 'none' })
  })

  it('connect after shutdown starts a fresh build, not the killed one', async () => {
    const firstList = vi.fn().mockReturnValue(new Promise(() => undefined))
    const secondList = vi.fn().mockResolvedValue([login('item2', 'SSO', 'https://sso.corp.com')])
    const backend = ops({
      listAccounts: vi.fn().mockResolvedValue([account('ACC1')]),
      listLoginItems: firstList,
    })
    const runtime = new OnePasswordRuntime(backend)
    await runtime.connect()
    await vi.waitFor(() => {
      expect(firstList).toHaveBeenCalledTimes(1)
    })
    await runtime.shutdown()
    backend.listLoginItems = secondList
    await runtime.connect()
    await vi.waitFor(() => {
      expect(runtime.state().state).toBe('ready')
    })
    expect(secondList).toHaveBeenCalledTimes(1)
    expect(runtime.listCandidates('https://sso.corp.com/login')[0]?.title).toBe('SSO')
  })

  it('builds the index from the login list and does not open items until fill', async () => {
    const backend = ops()
    const runtime = await readyRuntime(backend)
    expect(backend.listLoginItems).toHaveBeenCalled()
    expect(runtime.listCandidates('https://mail.corp.com/login')).toHaveLength(1)
    expect(backend.readLoginFields).not.toHaveBeenCalled()
  })
})

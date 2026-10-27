import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

interface ClientContract {
  toolkit: string
  lookup: Mock
  forward: Mock
  audit: Mock
  owner: Mock
  read(accountId?: string): Promise<Response>
  write?(signal?: AbortSignal): Promise<Response>
  operation(run: () => Promise<void>): Promise<void>
}

/** The transport guarantees every remote adapter must keep, regardless of HTTP
 * verb (Dropbox reads use POST) or provider-specific error envelopes. */
export function remoteClientContract(c: ClientContract): void {
  const write = c.write
  let test = 0
  const account = { id: 'account', toolkitSlug: c.toolkit, status: 'active', userId: 'alice', providerName: 'composio', providerConnectionId: 'connection' }
  describe(`${c.toolkit}: remote request contract`, () => {
    beforeEach(() => {
      vi.resetAllMocks()
      vi.useFakeTimers({ now: new Date('2035-01-01').getTime() + ++test * 100_000 })
      c.lookup.mockResolvedValue(account)
      c.owner.mockResolvedValue(null)
      c.forward.mockImplementation(async () => Response.json({ ok: true }))
    })
    afterEach(() => { vi.useRealTimers() })

    it('respects Retry-After for the whole account while other accounts continue', async () => {
      c.forward.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': '2' } }))
      const first = c.read()
      await vi.advanceTimersByTimeAsync(0)
      const second = c.read()
      await vi.advanceTimersByTimeAsync(1999)
      expect(c.forward).toHaveBeenCalledTimes(1)
      c.lookup.mockResolvedValueOnce({ ...account, id: 'other' })
      await c.read('other')
      expect(c.forward).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.all([first, second])
      expect(c.forward).toHaveBeenCalledTimes(4)
      expect(c.audit).not.toHaveBeenCalled()
    })

    it.each(['60', 'HTTP-date'])('returns a long %s cooldown without early retries', async header => {
      const value = header === 'HTTP-date' ? new Date(Date.now() + 60_000).toUTCString() : header
      c.forward.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': value } }))
      await expect(c.read()).rejects.toMatchObject({ status: 429, retryAfter: 60 })
      await expect(c.read()).rejects.toMatchObject({ status: 429, retryAfter: 60 })
      expect(c.forward).toHaveBeenCalledTimes(1)
    })

    it('bounds retries and backs off even when Retry-After is zero', async () => {
      c.forward.mockImplementation(async () => Response.json({}, { status: 429, headers: { 'Retry-After': '0' } }))
      const pending = (write ? write() : c.read()).catch(error => error)
      await vi.advanceTimersByTimeAsync(249)
      expect(c.forward).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1751)
      expect(await pending).toMatchObject({ status: 429 })
      expect(c.forward).toHaveBeenCalledTimes(4)
      expect(c.audit).toHaveBeenCalledTimes(write ? 1 : 0)
    })

    if (write) it('does not send a cancelled request or retry one cancelled during backoff', async () => {
      const aborted = new AbortController()
      aborted.abort()
      await expect(write(aborted.signal)).rejects.toMatchObject({ status: 409 })
      expect(c.forward).not.toHaveBeenCalled()
      const signal = new AbortController()
      c.forward.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': '2' } }))
      const pending = write(signal.signal).catch(error => error)
      await vi.advanceTimersByTimeAsync(0)
      expect(c.forward).toHaveBeenCalledTimes(1)
      signal.abort()
      expect(await pending).toMatchObject({ status: 409 })
      await vi.advanceTimersByTimeAsync(3000)
      expect(c.forward).toHaveBeenCalledTimes(1)
    })

    if (write) it('never replays a mutation whose outcome is unknown', async () => {
      c.forward.mockRejectedValueOnce(new Error('connection reset'))
      await expect(write()).rejects.toMatchObject({ status: 503 })
      c.forward.mockResolvedValueOnce(Response.json({}, { status: 502 }))
      await expect(write()).rejects.toMatchObject({ status: 503 })
      expect(c.forward).toHaveBeenCalledTimes(2)
    })

    it('can safely retry a read after an upstream failure', async () => {
      c.forward.mockResolvedValueOnce(Response.json({}, { status: 503 }))
      const pending = c.read()
      await vi.advanceTimersByTimeAsync(250)
      expect((await pending).status).toBe(200)
      expect(c.forward).toHaveBeenCalledTimes(2)
    })

    it('looks up account and owner once per operation, then checks revocation again', async () => {
      await c.operation(async () => { await c.read(); await c.read(); await c.read() })
      expect(c.lookup).toHaveBeenCalledTimes(1)
      expect(c.owner).toHaveBeenCalledTimes(1)
      c.lookup.mockResolvedValueOnce({ ...account, status: 'expired' })
      await expect(c.read()).rejects.toMatchObject({ code: 'not-accessible' })
      expect(c.forward).toHaveBeenCalledTimes(3)
    })

    if (write) it('audits mutations once without product analytics or read events', async () => {
      await c.read()
      await write()
      expect(c.audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: 'account', statusCode: 200 }), { analytics: false })
    })
  })
}

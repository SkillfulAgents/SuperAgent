import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, auditLog } from '@shared/lib/db/schema'
import { installTestKeyManager, uninstallKeyManager } from '@shared/lib/keys/testing/memory-key-manager'
import { signInMethodResolutionSchema } from '../../../../agent-container/src/login-schema'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const SETUP_URI = `otpauth://totp/GitHub:octocat?secret=${SECRET}&issuer=GitHub`

/** A fill report as the container gives it back: what the page did, never the code. */
const REPORT = {
  type: 'filled',
  origin: 'https://github.com',
  outcomes: [{ ref: '@e4', kind: 'otp', label: 'Code from the authenticator app', status: 'filled' }],
  lost: [],
  submitted: { via: 'click', ref: '@e5' },
}

/** The agent's container as the host reaches it: answers by path, and remembers what it was sent. */
const container = vi.hoisted(() => ({
  origin: 'https://github.com',
  prepareStatus: 200,
  setup: { status: 200, body: {} as Record<string, unknown> },
  fillOutcome: 'filled',
  calls: [] as Array<{ path: string; body?: unknown }>,
}))

vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: () => ({
      inputs: { complete: async () => {} },
      container: {
        fetch: async (url: string, init?: RequestInit) => {
          const body = init?.body ? JSON.parse(String(init.body)) : undefined
          container.calls.push({ path: url, ...(body !== undefined ? { body } : {}) })
          if (url === '/browser/login/prepare') {
            if (container.prepareStatus !== 200) return new Response(JSON.stringify({ error: 'no', problems: ['@e4 is not visible'] }), { status: container.prepareStatus })
            return new Response(JSON.stringify({ origin: container.origin, url: `${container.origin}/settings`, topOrigin: container.origin, fields: [], held: [] }), { status: 200 })
          }
          if (url === '/browser/login/authenticator') return new Response(JSON.stringify(container.setup.body), { status: container.setup.status })
          if (url === '/browser/login/fill') {
            const outcomes = [container.fillOutcome]
            const report = { ...REPORT, outcomes: [{ ...REPORT.outcomes[0], status: container.fillOutcome }] }
            return new Response(JSON.stringify({ success: true, filled: outcomes.filter((o) => o === 'filled').length, failed: 0, outcomes, submitted: true, problems: [], report }), { status: 200 })
          }
          return new Response('{}', { status: 404 })
        },
      },
    }),
  },
}))

const { addSignInMethod } = await import('./method-host')
const { grantAccount, getOwnedAccount, readAccountFill, saveAccount, setSignInMethodRequest } = await import('./vault-service')
const { totpCode } = await import('./totp')

let handle: TestDatabase
let dataDir: string

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'method-host-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  await installTestKeyManager()
})

afterAll(() => {
  vi.unstubAllEnvs()
  uninstallKeyManager()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(agents).values({ slug: 'agent-a', name: 'Agent A', createdAt: new Date() }).run()
  container.origin = 'https://github.com'
  container.prepareStatus = 200
  container.setup = { status: 200, body: { key: SETUP_URI, source: 'qr' } }
  container.fillOutcome = 'filled'
  container.calls = []
  vi.useFakeTimers({ toFake: ['Date'] })
  // Ten seconds into a period: its code has twenty left.
  vi.setSystemTime(1_800_000_010_000)
})

afterEach(async () => {
  vi.useRealTimers()
  await handle.close()
})

function call(input: Record<string, unknown>) {
  return addSignInMethod({ agentSlug: 'agent-a', sessionId: 's-1', toolUseId: 't-1', toolName: 'add_sign_in_method', input: JSON.stringify(input) })
}

async function grantedAccount(username = 'octocat', requested = true) {
  const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username, values: { password: 'pw' } })
  await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })
  if (requested) await setSignInMethodRequest(null, account.id, true, 'card')
  return account
}

const sent = (pathname: string) => container.calls.filter((entry) => entry.path === pathname).map((entry) => entry.body)
const resolution = (result: Awaited<ReturnType<typeof call>>) => {
  if (result.status !== 'resolved') throw new Error(`refused: ${result.reason}`)
  return signInMethodResolutionSchema.parse(JSON.parse(result.value))
}

describe('add_sign_in_method on the host', () => {
  it('saves the app the page set up once its current code went in, answering the owner\'s request', async () => {
    const account = await grantedAccount()
    const result = await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4', submit: '@e5', name: 'Gamut' })

    expect(resolution(result)).toEqual({ type: 'authenticator_added', site: 'github.com', username: 'octocat', issuer: 'GitHub', report: expect.objectContaining({ type: 'filled' }) })
    expect(sent('/browser/login/prepare')).toEqual([{
      sessionId: 's-1',
      toolUseId: 't-1',
      fields: [{ ref: '@e4', kind: 'otp', label: 'Code from the authenticator app', from: 'authenticator_app' }],
      submitRef: '@e5',
      providers: [],
    }])
    expect(sent('/browser/login/authenticator')).toEqual([{ toolUseId: 't-1' }])
    const seed = { secret: SECRET, algorithm: 'SHA1' as const, digits: 6, period: 30 }
    expect(sent('/browser/login/fill')).toEqual([{
      sessionId: 's-1',
      toolUseId: 't-1',
      expectedOrigin: 'https://github.com',
      values: [totpCode(seed, Date.now())],
      account: { username: 'octocat', site: 'github.com', source: 'vault', saved: false, held: [] },
      answer: false,
    }])
    const saved = await getOwnedAccount(null, account.id)
    expect(saved?.signInMethods).toEqual({ authenticator: { addedAt: Date.now(), issuer: 'GitHub', accountName: 'octocat', name: 'Gamut' } })
    expect((await readAccountFill(account.id)).totp).toEqual(seed)
    const audit = await testDb.select({ action: auditLog.action, details: auditLog.details }).from(auditLog).all()
    expect(audit.at(-1)?.action).toBe('method_added')
    expect(JSON.parse(audit.at(-1)!.details!)).toEqual({ method: 'authenticator_app', agentSlug: 'agent-a', sessionId: 's-1', asked: 'request' })
    // The seed only ever sealed: not in the answer, the audit log or anything else the container was sent.
    expect(JSON.stringify([result, audit, container.calls.filter((entry) => entry.path !== '/browser/login/fill')])).not.toContain(SECRET)
  })

  it('adds one the user asked for in the conversation, and logs their words', async () => {
    await grantedAccount('octocat', false)
    expect((await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4' })).status).toBe('rejected')
    expect(sent('/browser/login/authenticator')).toEqual([])

    container.calls = []
    const result = await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4', user_request: 'Set up 2FA codes on my GitHub for yourself' })
    expect(resolution(result).type).toBe('authenticator_added')
    const audit = await testDb.select({ action: auditLog.action, details: auditLog.details }).from(auditLog).all()
    expect(JSON.parse(audit.at(-1)!.details!)).toMatchObject({ askedInChat: 'Set up 2FA codes on my GitHub for yourself' })
  })

  it('refuses an account the agent may not use, without reading the page\'s setup', async () => {
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat' })
    await setSignInMethodRequest(null, account.id, true, 'logins')
    expect(await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4' })).toEqual({
      status: 'rejected',
      reason: 'no saved account "octocat" on github.com that you may use: sign in with request_login first (the user saves the account there)',
    })
    expect(sent('/browser/login/authenticator')).toEqual([])
  })

  it('keeps nothing when the code did not go into the page', async () => {
    const account = await grantedAccount()
    container.fillOutcome = 'failed'
    expect(resolution(await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4' })).type).toBe('authenticator_not_added')
    const kept = await getOwnedAccount(null, account.id)
    expect(kept?.signInMethods.authenticator).toBeUndefined()
    expect(kept?.signInMethods.requested).toBeDefined()
    expect((await readAccountFill(account.id)).totp).toBeNull()
  })

  it('refuses a setup the vault cannot make codes for, and says why the page could not be read', async () => {
    await grantedAccount()
    container.setup = { status: 200, body: { key: `otpauth://hotp/GitHub:octocat?secret=${SECRET}&counter=1`, source: 'qr' } }
    expect(await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4' })).toEqual({
      status: 'rejected',
      reason: 'the setup on the page is not one the vault can use: only an authenticator app\'s time-based codes (TOTP)',
    })
    container.setup = { status: 422, body: { error: 'no QR code or setup key for an authenticator app was found on the page: open the step that shows the QR code first' } }
    expect(await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4' })).toEqual({
      status: 'rejected',
      reason: 'no QR code or setup key for an authenticator app was found on the page: open the step that shows the QR code first',
    })
    container.prepareStatus = 422
    expect(await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4' })).toEqual({ status: 'rejected', reason: 'the page could not be used: @e4 is not visible' })
    expect(sent('/browser/login/fill')).toEqual([])
  })

  it('notes that the site offers none, answering the request with why', async () => {
    const account = await grantedAccount()
    const result = await call({ method: 'none', username: 'octocat', reason: 'Two-factor authentication is off for this account.' })
    expect(resolution(result)).toEqual({ type: 'unavailable_noted', site: 'github.com', username: 'octocat' })
    expect((await getOwnedAccount(null, account.id))?.signInMethods).toEqual({
      unavailable: { at: Date.now(), reason: 'Two-factor authentication is off for this account.' },
    })
    expect(sent('/browser/login/authenticator')).toEqual([])
  })

  it('refuses this app\'s own pages', async () => {
    await grantedAccount()
    container.origin = 'http://localhost:47891'
    vi.stubEnv('PORT', '47891')
    expect((await call({ method: 'authenticator_app', username: 'octocat', code_field: '@e4' })).status).toBe('rejected')
    expect(sent('/browser/login/authenticator')).toEqual([])
  })
})

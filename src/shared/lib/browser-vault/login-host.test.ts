import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, auditLog, user } from '@shared/lib/db/schema'
import type { LoginContext } from '@shared/lib/tools/request-login/login-request'
import { resetVaultKeyCache } from './vault-crypto'
import { loginFillAccountSchema } from '../../../../agent-container/src/login-schema'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

/** The agent's container as the host reaches it: answers by path, and remembers what it was sent. */
const container = vi.hoisted(() => ({
  context: null as unknown,
  contextStatus: [] as number[],
  fillStatus: 200,
  /** The `reason` a refused fill gives (`browser_closed`), if any. */
  fillReason: null as string | null,
  /** Per-field outcomes the fill answers with; null answers the counts only. */
  fillOutcomes: null as string[] | null,
  calls: [] as Array<{ path: string; body?: unknown }>,
}))

vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: () => ({
      inputs: {
        get: async () => null,
        enrich: async () => false,
        complete: async () => {},
      },
      container: {
        fetch: async (url: string, init?: RequestInit) => {
          const body = init?.body ? JSON.parse(String(init.body)) : undefined
          container.calls.push({ path: url, ...(body !== undefined ? { body } : {}) })
          if (url.startsWith('/browser/login/context')) {
            const status = container.contextStatus.shift() ?? 200
            if (status === 404) return new Response(JSON.stringify({ error: 'still locating' }), { status })
            if (status === 409) return new Response(JSON.stringify({ error: 'no', problems: ['@e3 is not visible'] }), { status })
            if (status !== 200) return new Response(JSON.stringify({ error: 'Host authentication is required' }), { status })
            return new Response(JSON.stringify(container.context), { status: 200 })
          }
          if (url === '/browser/login/fill') {
            if (container.fillStatus !== 200) {
              return new Response(JSON.stringify({ error: 'This sign-in request is no longer open', ...(container.fillReason ? { reason: container.fillReason } : {}) }), { status: container.fillStatus })
            }
            if (container.fillOutcomes) {
              const outcomes = container.fillOutcomes
              const count = (status: string) => outcomes.filter((outcome) => outcome === status).length
              return new Response(JSON.stringify({ success: true, filled: count('filled'), failed: count('failed'), outcomes, submitted: false, problems: [] }), { status: 200 })
            }
            return new Response(JSON.stringify({ success: true, filled: body.values.filter(Boolean).length, failed: 0, submitted: true, problems: [] }), { status: 200 })
          }
          if (url.startsWith('/inputs/')) return new Response('{}', { status: 200 })
          return new Response('{}', { status: 404 })
        },
      },
    }),
  },
}))

const { decideLoginRequest } = await import('./login-host')
const { grantAccount, getOwnedAccount, readAccountValues, saveAccount, listAccountAgentSlugs } = await import('./vault-service')
const { holdLoginValues, heldLoginFor, resetHeldLogins, recentSignInIdentity } = await import('./held-values')

const field = (kind: LoginContext['fields'][number]['kind'], label: string, inputType = 'text') =>
  ({ kind, label, inputType, inputMode: '', autocomplete: '', maxLength: -1 })

const GITHUB: LoginContext = {
  origin: 'https://github.com',
  url: 'https://github.com/login',
  topOrigin: 'https://github.com',
  submit: true,
  fields: [field('username', 'Username or email'), field('password', 'Password', 'password')],
  held: [],
  providers: [],
}

let handle: TestDatabase
let dataDir: string

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-host-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  vi.stubEnv('BETTER_AUTH_SECRET', '')
  resetVaultKeyCache()
})

afterAll(() => {
  vi.unstubAllEnvs()
  resetVaultKeyCache()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(agents).values({ slug: 'agent-a', name: 'Agent A', createdAt: new Date() }).run()
  container.context = GITHUB
  container.contextStatus = []
  container.fillStatus = 200
  container.fillReason = null
  container.fillOutcomes = null
  container.calls = []
  resetHeldLogins()
})

afterEach(async () => {
  await handle.close()
})

function decide(input: Record<string, unknown>, sessionId = 's-1') {
  return decideLoginRequest({ agentSlug: 'agent-a', sessionId, toolUseId: 't-1', input: JSON.stringify({ message: 'Sign in.', ...input }) })
}

async function grantedAccount(username: string, values: Record<string, string> = {}, site = 'github.com', origin = 'https://github.com') {
  const { account } = await saveAccount({ owner: null, site, origin, username, values })
  await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })
  return account
}

const fills = () => container.calls.filter((call) => call.path === '/browser/login/fill')
const answers = () => container.calls
  .filter((call) => call.path.startsWith('/inputs/'))
  .map((call) => ({ path: call.path, value: JSON.parse((call.body as { value: string }).value) }))

describe('decideLoginRequest', () => {
  it('leaves a request to the form when the agent has no account on the site', async () => {
    expect(await decide({ fields: [] })).toEqual({ action: 'ask', vault: { mode: 'new' }, login: GITHUB })
    expect(fills()).toEqual([])
  })

  it('lists the agent\'s accounts on the site and fills nothing, even when there is one', async () => {
    await grantedAccount('octocat', { password: 'pw' })
    const google = await saveAccount({ owner: null, site: 'google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const { account: viaGoogle } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'me@gmail.com', viaAccountId: google.account.id })
    await grantAccount({ accountId: viaGoogle.id, agentSlug: 'agent-a', grantedBy: null })

    expect(await decide({ fields: [] })).toEqual({ action: 'settled' })
    expect(fills()).toEqual([])
    const [answer] = answers()
    expect(answer.path).toBe('/inputs/t-1/resolve')
    expect(answer.value).toMatchObject({ type: 'accounts', site: 'github.com' })
    expect(answer.value.accounts).toEqual(expect.arrayContaining([
      { username: 'octocat', label: null, parts: ['password'], via: null },
      { username: 'me@gmail.com', label: null, parts: [], via: { site: 'google.com', username: 'me@gmail.com', name: 'Google' } },
    ]))
    expect(JSON.stringify(answer)).not.toContain('pw')
  })

  it('fills a named account into the page and submits, recording the use', async () => {
    const account = await grantedAccount('Octocat', { password: 'hunter2' })
    expect(await decide({ username: 'octocat', fields: [] })).toEqual({ action: 'settled' })

    expect(fills()).toEqual([{
      path: '/browser/login/fill',
      body: {
        sessionId: 's-1',
        toolUseId: 't-1',
        expectedOrigin: 'https://github.com',
        values: ['Octocat', 'hunter2'],
        account: { username: 'Octocat', site: 'github.com', source: 'vault', saved: false, held: [] },
      },
    }])
    expect((await getOwnedAccount(null, account.id))?.lastUsedAt).toBeInstanceOf(Date)
    expect(await testDb.select({ action: auditLog.action }).from(auditLog).all()).toEqual([{ action: 'used' }])
    expect(recentSignInIdentity('agent-a', 's-1', 'github.com')).toBe('Octocat')
  })

  it('asks for just what a named account lacks', async () => {
    const account = await grantedAccount('octocat')
    expect(await decide({ username: 'octocat' })).toEqual({
      action: 'ask',
      vault: { mode: 'complete', username: 'octocat', accountId: account.id, covered: [0] },
      login: GITHUB,
    })
    expect(fills()).toEqual([])
  })

  it('leaves a request to the user for an account the agent may not use', async () => {
    await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat', values: { password: 'pw' } })
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'ask', vault: { mode: 'ask', username: 'octocat' }, login: GITHUB })
    expect(fills()).toEqual([])
  })

  it('opens the form when asked to, even with a saved account', async () => {
    await grantedAccount('octocat', { password: 'pw' })
    expect(await decide({ username: 'octocat', ask_user: true })).toEqual({ action: 'ask', vault: { mode: 'ask', username: 'octocat' }, login: GITHUB })
    expect(await decide({ ask_user: true })).toEqual({ action: 'ask', vault: { mode: 'ask' }, login: GITHUB })
    expect(fills()).toEqual([])
  })

  it('raises nothing for a call whose fields could not be used, and waits for fields still being located', async () => {
    container.contextStatus = [409]
    expect(await decide({})).toEqual({ action: 'none' })
    container.contextStatus = [404, 200]
    expect(await decide({})).toEqual({ action: 'ask', vault: { mode: 'new' }, login: GITHUB })
  })

  it('does not fill a secret saved on an encrypted page into a plain-HTTP one', async () => {
    container.context = { ...GITHUB, origin: 'http://github.com', topOrigin: 'http://github.com', url: 'http://github.com/login' }
    const account = await grantedAccount('octocat', { password: 'pw' })
    expect(await decide({ username: 'octocat' })).toMatchObject({ action: 'ask', vault: { mode: 'complete', accountId: account.id, covered: [0] } })
    expect(fills()).toEqual([])
  })

  it('fills what the user entered for this step earlier, then saves it to the account', async () => {
    const account = await grantedAccount('octocat')
    holdLoginValues('agent-a', 's-1', 'github.com', {
      username: 'octocat',
      values: { password: 'held-pw' },
      origin: 'https://github.com',
      save: { owner: null, origin: 'https://github.com' },
    })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }

    // Without naming the account: the held step is this sign-in's.
    expect(await decide({})).toEqual({ action: 'settled' })
    expect(fills()[0].body).toMatchObject({ values: ['held-pw'], account: { username: 'octocat', source: 'user', held: [] } })
    expect(await readAccountValues(account.id)).toEqual({ password: 'held-pw' })
    expect(heldLoginFor('agent-a', 's-1', 'github.com')).toBeNull()
    expect(await listAccountAgentSlugs(account.id)).toEqual(['agent-a'])
    // The site may have turned the held password down: now saved, it is not refilled without the user.
    expect(await decide({ username: 'octocat' })).toMatchObject({ action: 'ask', vault: { mode: 'ask', filledAt: expect.any(String) } })
    expect(fills()).toHaveLength(1)
  })

  it('saves a held value only into an account that is still there and still granted', async () => {
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat' })
    // Granted when the user saved it with the email, revoked in Settings since.
    holdLoginValues('agent-a', 's-1', 'github.com', {
      username: 'octocat',
      values: { password: 'held-pw' },
      origin: 'https://github.com',
      save: { owner: null, origin: 'https://github.com' },
    })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }

    expect(await decide({})).toEqual({ action: 'settled' })
    expect(fills()[0].body).toMatchObject({ values: ['held-pw'] })
    expect(await readAccountValues(account.id)).toEqual({})
    expect(await listAccountAgentSlugs(account.id)).toEqual([])
  })

  it('saves a held value into the saver\'s own account, not another member\'s with the same username', async () => {
    const now = new Date()
    for (const id of ['alice', 'bob']) {
      await testDb.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now }).run()
    }
    const alices = (await saveAccount({ owner: 'alice', site: 'github.com', origin: 'https://github.com', username: 'team@acme.com', values: { password: 'a-pw' } })).account
    const bobs = (await saveAccount({ owner: 'bob', site: 'github.com', origin: 'https://github.com', username: 'team@acme.com' })).account
    await grantAccount({ accountId: bobs.id, agentSlug: 'agent-a', grantedBy: 'bob' })
    // Alice's was granted last, so it comes first among the agent's accounts.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await grantAccount({ accountId: alices.id, agentSlug: 'agent-a', grantedBy: 'alice' })
    holdLoginValues('agent-a', 's-1', 'github.com', {
      username: 'team@acme.com',
      values: { password: 'b-pw' },
      origin: 'https://github.com',
      save: { owner: 'bob', origin: 'https://github.com' },
    })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }

    expect(await decide({})).toEqual({ action: 'settled' })
    expect(await readAccountValues(bobs.id)).toEqual({ password: 'b-pw' })
    expect(await readAccountValues(alices.id)).toEqual({ password: 'a-pw' })
  })

  it('does not fill a held value typed on an encrypted page into a plain-HTTP one', async () => {
    holdLoginValues('agent-a', 's-1', 'github.com', { username: 'octocat', values: { password: 'typed-on-https' }, origin: 'https://github.com', save: null })
    container.context = { ...GITHUB, origin: 'http://github.com', topOrigin: 'http://github.com', url: 'http://github.com/login', fields: [field('password', 'Password', 'password')] }
    expect(await decide({})).toEqual({ action: 'ask', vault: { mode: 'new' }, login: container.context })
    expect(fills()).toEqual([])
  })

  it('says the named account was not filled when no field was mapped', async () => {
    container.context = { ...GITHUB, fields: [], submit: false }
    await grantedAccount('octocat', { password: 'pw' })
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'settled' })
    expect(answers()[0].value).toMatchObject({ type: 'accounts', named: true, accounts: [{ username: 'octocat' }] })
  })

  it('sends every fill an account note the container accepts', async () => {
    await grantedAccount('octocat', { password: 'pw' })
    await decide({ username: 'octocat' })
    holdLoginValues('agent-a', 's-1', 'github.com', { username: null, values: { password: 'held-pw' }, origin: 'https://github.com', save: null })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }
    await decide({})
    expect(fills()).toHaveLength(2)
    for (const call of fills()) expect(loginFillAccountSchema.safeParse((call.body as { account: unknown }).account).success).toBe(true)
  })

  it('does not use a held step for another account', async () => {
    await grantedAccount('hubot', { password: 'hubot-pw' })
    holdLoginValues('agent-a', 's-1', 'github.com', { username: 'octocat', values: { password: 'held-pw' }, origin: 'https://github.com', save: null })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }

    expect(await decide({ username: 'hubot' })).toEqual({ action: 'settled' })
    expect(fills()[0].body).toMatchObject({ values: ['hubot-pw'], account: { username: 'hubot', source: 'vault' } })
    expect(heldLoginFor('agent-a', 's-1', 'github.com')).not.toBeNull()
  })

  it('names the provider account to sign in with on a page without fields', async () => {
    container.context = { ...GITHUB, fields: [], submit: false }
    const google = await saveAccount({ owner: null, site: 'google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'me@gmail.com', viaAccountId: google.account.id })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })

    expect(await decide({ username: 'me@gmail.com' })).toEqual({ action: 'settled' })
    expect(answers()[0].value).toEqual({
      type: 'via',
      site: 'github.com',
      username: 'me@gmail.com',
      provider: { site: 'google.com', username: 'me@gmail.com', name: 'Google' },
      saved: true,
    })
  })

  it('names the provider account even where the page also shows a password form', async () => {
    const google = await saveAccount({ owner: null, site: 'google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'me@gmail.com', viaAccountId: google.account.id })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })

    expect(await decide({ username: 'me@gmail.com' })).toEqual({ action: 'settled' })
    expect(fills()).toEqual([])
    expect(answers()[0].value).toMatchObject({ type: 'via', provider: { site: 'google.com', username: 'me@gmail.com', name: 'Google' } })
    expect((await getOwnedAccount(null, account.id))?.lastUsedAt).toBeInstanceOf(Date)
  })

  it('asks the user for the site\'s own code after an account signs in through Google', async () => {
    const google = await saveAccount({ owner: null, site: 'google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'me@gmail.com', viaAccountId: google.account.id })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })
    container.context = { ...GITHUB, fields: [field('otp', 'Enter the code we emailed you')] }
    expect(await decide({ username: 'me@gmail.com' })).toEqual({
      action: 'ask',
      vault: { mode: 'complete', username: 'me@gmail.com', accountId: account.id, covered: [] },
      login: container.context,
    })
    expect(answers()).toEqual([])
  })

  it('opens no card when the browser closed before the vault\'s fill: the next try uses the same account', async () => {
    await grantedAccount('octocat', { password: 'pw' })
    container.fillStatus = 409
    container.fillReason = 'browser_closed'
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'settled' })
    expect(answers()[0].value).toEqual({ type: 'browser_closed', site: 'github.com', kept: { how: 'vault', username: 'octocat' } })
  })

  it('keeps what was held when the browser closed before it went in', async () => {
    holdLoginValues('agent-a', 's-1', 'github.com', { username: 'octocat', values: { password: 'held-pw' }, origin: 'https://github.com', save: null })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }
    container.fillStatus = 409
    container.fillReason = 'browser_closed'
    expect(await decide({})).toEqual({ action: 'settled' })
    expect(answers()[0].value).toEqual({ type: 'browser_closed', site: 'github.com', kept: { how: 'held', username: 'octocat' } })
    expect(JSON.stringify(answers())).not.toContain('held-pw')
    expect(heldLoginFor('agent-a', 's-1', 'github.com')?.values).toEqual({ password: 'held-pw' })
  })

  it('leaves the request to the user when the page refuses the saved account\'s fill', async () => {
    const account = await grantedAccount('octocat', { password: 'pw' })
    container.fillStatus = 409
    expect(await decide({ username: 'octocat' })).toMatchObject({ action: 'ask', vault: { mode: 'complete', accountId: account.id, covered: [0, 1] } })
    expect((await getOwnedAccount(null, account.id))?.lastUsedAt).toBeNull()
  })

  it('counts only what the browser wrote: a field it could not write keeps its held value, and spends no attempt', async () => {
    const account = await grantedAccount('octocat', { password: 'saved-pw' })
    holdLoginValues('agent-a', 's-1', 'github.com', {
      username: 'octocat',
      values: { password: 'held-pw' },
      origin: 'https://github.com',
      save: { owner: null, origin: 'https://github.com' },
    })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }
    // A stale ref: the container answers, but the field took nothing.
    container.fillOutcomes = ['failed']
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'settled' })
    expect(heldLoginFor('agent-a', 's-1', 'github.com', 'octocat')?.values).toEqual({ password: 'held-pw' })
    expect(await readAccountValues(account.id)).toEqual({ password: 'saved-pw' })
    expect((await getOwnedAccount(null, account.id))?.lastUsedAt).toBeNull()

    // The agent maps the field again: the held password goes in this time, with no card.
    container.fillOutcomes = ['filled']
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'settled' })
    expect(fills().map((call) => (call.body as { values: string[] }).values)).toEqual([['held-pw'], ['held-pw']])
    expect(await readAccountValues(account.id)).toEqual({ password: 'held-pw' })
  })

  it('counts a write sent without an answer as tried: the page may hold the password, so no silent retry', async () => {
    await grantedAccount('octocat')
    holdLoginValues('agent-a', 's-1', 'github.com', {
      username: 'octocat',
      values: { password: 'held-pw' },
      origin: 'https://github.com',
      save: { owner: null, origin: 'https://github.com' },
    })
    container.context = { ...GITHUB, fields: [field('password', 'Password', 'password')] }
    container.fillOutcomes = ['unconfirmed']
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'settled' })
    expect(heldLoginFor('agent-a', 's-1', 'github.com', 'octocat')).toBeNull()
    expect(await decide({ username: 'octocat' })).toMatchObject({ action: 'ask', vault: { mode: 'ask', filledAt: expect.any(String) } })
    expect(fills()).toHaveLength(1)
  })

  it('opens the form when the container cannot be read: only its own word means the call is over', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    container.contextStatus = [503]
    expect(await decide({ fields: [] })).toEqual({ action: 'ask', vault: { mode: 'new' } })
    errors.mockRestore()
  })

  it('asks the user when the agent says the site rejected an account, and fills it without them only once they enter it again', async () => {
    const account = await grantedAccount('octocat', { password: 'old' })
    expect(await decide({ username: 'octocat', ask_user: true, reason: 'The page says "Incorrect password."' })).toEqual({
      action: 'ask',
      vault: { mode: 'ask', username: 'octocat', reason: 'The page says "Incorrect password."' },
      login: GITHUB,
    })
    expect((await getOwnedAccount(null, account.id))?.rejectedAt).toBeInstanceOf(Date)

    // Another session, and the agent does not say why: still the user's to answer.
    expect(await decide({ username: 'octocat' }, 's-2')).toMatchObject({ action: 'ask', vault: { mode: 'ask', username: 'octocat', rejectedAt: expect.any(String) } })
    expect(fills()).toEqual([])
    // Listed with it, so the agent knows.
    expect(await decide({}, 's-2')).toEqual({ action: 'settled' })
    expect(answers().at(-1)?.value.accounts).toEqual([expect.objectContaining({ username: 'octocat', rejected: true })])

    await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'octocat', values: { password: 'new' } })
    expect(await decide({ username: 'octocat' }, 's-3')).toEqual({ action: 'settled' })
    expect(fills()[0].body).toMatchObject({ values: ['octocat', 'new'] })
  })

  it('marks nothing rejected when the step the agent says failed asks for a code, not the password', async () => {
    const account = await grantedAccount('octocat', { password: 'pw' })
    container.context = { ...GITHUB, fields: [field('otp', 'Authentication code')] }
    expect(await decide({ username: 'octocat', ask_user: true, reason: 'The page says "Incorrect code."' })).toMatchObject({
      action: 'ask',
      vault: { mode: 'ask', username: 'octocat', reason: 'The page says "Incorrect code."' },
    })
    expect((await getOwnedAccount(null, account.id))?.rejectedAt).toBeNull()
  })

  it('fills a saved password once in a while per session: the next sign-in with it goes to the user', async () => {
    await grantedAccount('octocat', { password: 'pw' })
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'settled' })
    // The site may well have turned it down: no second unattended attempt.
    expect(await decide({ username: 'octocat' })).toMatchObject({ action: 'ask', vault: { mode: 'ask', username: 'octocat', filledAt: expect.any(String) } })
    // A code step after it asks for no password: the vault goes on.
    container.context = { ...GITHUB, fields: [field('username', 'Username or email')] }
    expect(await decide({ username: 'octocat' })).toEqual({ action: 'settled' })
    // Another session starts afresh.
    container.context = GITHUB
    expect(await decide({ username: 'octocat' }, 's-2')).toEqual({ action: 'settled' })
    expect(fills()).toHaveLength(3)
  })

  it('fills the workspace of an account that signs in through Google, but never its old password', async () => {
    const google = await saveAccount({ owner: null, site: 'accounts.google.com', origin: 'https://accounts.google.com', username: 'me@gmail.com' })
    const { account } = await saveAccount({ owner: null, site: 'github.com', origin: 'https://github.com', username: 'me@gmail.com', values: { password: 'old', 'text:workspace': 'acme' }, viaAccountId: google.account.id })
    await grantAccount({ accountId: account.id, agentSlug: 'agent-a', grantedBy: null })

    // A password form: the account signs in with Google now.
    expect(await decide({ username: 'me@gmail.com' })).toEqual({ action: 'settled' })
    expect(fills()).toEqual([])
    expect(answers()[0].value).toMatchObject({ type: 'via', provider: { name: 'Google' } })

    container.context = { ...GITHUB, fields: [field('text', 'Workspace')] }
    expect(await decide({ username: 'me@gmail.com' })).toEqual({ action: 'settled' })
    expect(fills()[0].body).toMatchObject({ values: ['acme'] })
  })

  it('keeps tenants of a shared host apart: another tenant gets the form', async () => {
    container.context = { ...GITHUB, origin: 'https://acme.okta.com', url: 'https://acme.okta.com/login', topOrigin: 'https://acme.okta.com' }
    await grantedAccount('me@acme.com', { password: 'pw' }, 'acme.okta.com', 'https://acme.okta.com')
    container.context = { ...GITHUB, origin: 'https://evil.okta.com', url: 'https://evil.okta.com/login', topOrigin: 'https://evil.okta.com' }
    expect(await decide({ username: 'me@acme.com' })).toMatchObject({ action: 'ask', vault: { mode: 'ask', username: 'me@acme.com' } })
    expect(await decide({})).toMatchObject({ action: 'ask', vault: { mode: 'new' } })
    expect(fills()).toEqual([])
  })
})

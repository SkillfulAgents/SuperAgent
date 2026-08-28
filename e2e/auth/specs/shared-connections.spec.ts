/**
 * Connections another member shared onto an agent, from the agent owner's side.
 *
 * Two things used to leave an owner stuck with a connection they did not own:
 *
 *  1. The Agent Connections page showed the link as a bare "Shared" row with no
 *     control on it. The only unlink route was keyed on the ACCOUNT id and
 *     owner-scoped, and the foreign DTO withholds that id by design — so there
 *     was no reachable call at all, not merely a hidden button.
 *  2. When the shared credential expired mid-run, the reauth card blocked every
 *     session of the agent. Reconnecting belongs to the credential's owner, and
 *     the card offered nobody else a way out, so the agent sat wedged until the
 *     five-minute timer fired.
 *
 * This narrative proves both against the real server with real users: the owner
 * can now unlink and dismiss, and — the half that matters as much — a member
 * holding only `user` on the agent still cannot, and neither path can be aimed
 * at a different agent by passing its ids to this one's URL.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'

// Serial narrative — each test builds on state from the previous ones.
test.describe.configure({ mode: 'serial' })

// Mirrors how playwright.auth.config.ts derives this project's dataDir: a base
// that SUPERAGENT_DATA_DIR overrides, then the per-project subdirectory. Both
// halves matter — CI sets that env var, a local run usually does not, so a
// spec that only handles one branch passes in exactly one of the two places.
const DATA_DIR = path.join(
  path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(process.cwd(), '.e2e-data-auth')),
  'shared-connections',
)
const RECORDER_FILE = path.join(DATA_DIR, '.e2e-mock-recorder.jsonl')

const first = { name: 'Ada Admin', email: 'ada@test.com', password: 'password123' }
const owner = { name: 'Odette Owner', email: 'odette@test.com', password: 'password123' }
const member = { name: 'Mel Member', email: 'mel@test.com', password: 'password123' }

let agentSlug = ''
let otherAgentSlug = ''
let sharedAccountId = ''
let sharedMappingId = ''
let expiredAccountId = ''
let expiredMappingId = ''
let proxyToken = ''

async function signUp(page: Page, user: typeof owner) {
  const authPage = new AuthPage(page)
  const appPage = new AppPage(page)
  await authPage.resetToAuthPage()
  await authPage.signUpOrSignIn(user.name, user.email, user.password)
  await appPage.waitForAppLoaded()
  await appPage.dismissWizardIfVisible()
}

// A retry re-runs this whole serial narrative in the same worker, so module
// state survives and the database still holds the failed attempt's rows.
// Connection ids are UNIQUE, so they have to be minted per call — a constant
// seeded once at import time is not enough.
let accountSeq = 0

/** Create a connected account owned by whoever `page` is signed in as. */
async function createAccount(
  page: Page,
  displayName: string,
  status: 'active' | 'expired',
): Promise<string> {
  accountSeq += 1
  const res = await page.request.post('/api/connected-accounts', {
    data: {
      providerConnectionId: `conn-${accountSeq}-${Date.now().toString(36)}`,
      toolkitSlug: 'github',
      displayName,
      status,
    },
  })
  expect(res.ok(), `create account ${res.status()}`).toBeTruthy()
  const { account } = (await res.json()) as { account: { id: string } }
  return account.id
}

async function assignAccount(page: Page, slug: string, accountId: string) {
  const res = await page.request.post(`/api/agents/${slug}/connected-accounts`, {
    data: { accountIds: [accountId] },
  })
  expect(res.ok(), `assign account ${res.status()}`).toBeTruthy()
}

type AgentAccount =
  | { kind: 'connected-account'; toolkitSlug: string; mappingId: string }
  | { id: string; displayName: string; mappingId: string }

async function listAgentAccounts(page: Page, slug: string): Promise<AgentAccount[]> {
  const res = await page.request.get(`/api/agents/${slug}/connected-accounts`)
  expect(res.ok(), `list agent accounts ${res.status()}`).toBeTruthy()
  const { accounts } = (await res.json()) as { accounts: AgentAccount[] }
  return accounts
}

function readRecords(): Array<{ type: string; agentSlug: string; proxyToken?: string }> {
  if (!fs.existsSync(RECORDER_FILE)) return []
  return fs
    .readFileSync(RECORDER_FILE, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function waitForProxyToken(slug: string, timeoutMs = 45000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = readRecords().find((r) => r.type === 'container_start' && r.agentSlug === slug)
    if (found?.proxyToken) return found.proxyToken
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for the mock container to record a proxy token for ${slug}`)
}

async function pendingReauthRequestId(page: Page, slug: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await page.request.get(`/api/agents/${slug}/pending-requests`)
    if (res.ok()) {
      const { requests } = (await res.json()) as {
        requests: Array<{ id: string; kind: string }>
      }
      const reauth = requests.find((r) => r.kind === 'account_reauth_required')
      if (reauth) return reauth.id
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Timed out waiting for an account_reauth_required request')
}

test.describe('Shared agent connections', () => {
  test('three users sign up and the owner shares an agent with a member', async ({
    user1Page,
    user2Page,
    user3Page,
  }) => {
    // The first account in an auth-mode install is promoted to global admin,
    // and admins bypass the agent ACL entirely. Burning that promotion on a
    // user this narrative never acts as is what makes the owner an ORDINARY
    // agent owner and the member an ordinary member.
    await signUp(user1Page, first)

    await signUp(user2Page, owner)
    const agentRes = await user2Page.request.post('/api/agents', { data: { name: 'Shared Agent' } })
    expect(agentRes.ok()).toBeTruthy()
    agentSlug = ((await agentRes.json()) as { slug: string }).slug

    const otherRes = await user2Page.request.post('/api/agents', { data: { name: 'Solo Agent' } })
    expect(otherRes.ok()).toBeTruthy()
    otherAgentSlug = ((await otherRes.json()) as { slug: string }).slug

    await signUp(user3Page, member)

    const searchRes = await user2Page.request.get(
      `/api/agents/${agentSlug}/access/search-users?q=${encodeURIComponent(member.email)}`,
    )
    expect(searchRes.ok()).toBeTruthy()
    const found = (await searchRes.json()) as Array<{ id: string; email: string }>
    const memberId = found.find((u) => u.email === member.email)?.id
    expect(memberId, 'member is findable from the owner’s access tab').toBeTruthy()

    const grantRes = await user2Page.request.post(`/api/agents/${agentSlug}/access`, {
      data: { userId: memberId, role: 'user' },
    })
    expect(grantRes.status()).toBe(201)
  })

  test('the member attaches their own connection to the shared agent', async ({ user3Page }) => {
    sharedAccountId = await createAccount(user3Page, 'Mel GitHub', 'active')
    await assignAccount(user3Page, agentSlug, sharedAccountId)

    const asMember = await listAgentAccounts(user3Page, agentSlug)
    expect(asMember).toHaveLength(1)
    expect(asMember[0]).toMatchObject({ id: sharedAccountId, displayName: 'Mel GitHub' })
  })

  test('the owner sees the link as an opaque shared row carrying only a link id', async ({
    user2Page,
  }) => {
    const asOwner = await listAgentAccounts(user2Page, agentSlug)
    expect(asOwner).toHaveLength(1)

    const row = asOwner[0]
    expect(row).toMatchObject({ kind: 'connected-account', toolkitSlug: 'github' })
    // Everything that identifies the account or its owner stays withheld; the
    // link id is the whole of what the owner gets, and it is enough to unlink.
    expect(row).not.toHaveProperty('id')
    expect(row).not.toHaveProperty('displayName')
    expect(JSON.stringify(row)).not.toContain(sharedAccountId)

    sharedMappingId = row.mappingId
    expect(sharedMappingId).toBeTruthy()
  })

  test('the account-keyed unlink still refuses to touch another member’s link', async ({
    user2Page,
  }) => {
    // The owner would have to guess the id to try this at all, but the guard
    // has to stay closed regardless: this route unlinks only accounts the
    // CALLER owns, whatever their role on the agent.
    const res = await user2Page.request.delete(
      `/api/agents/${agentSlug}/connected-accounts/${sharedAccountId}`,
    )
    expect(res.status()).toBe(404)
    expect(await listAgentAccounts(user2Page, agentSlug)).toHaveLength(1)
  })

  test('a member with only `user` on the agent cannot unlink by link id', async ({ user3Page }) => {
    const res = await user3Page.request.delete(
      `/api/agents/${agentSlug}/connected-accounts/mapping/${sharedMappingId}`,
    )
    expect(res.status()).toBe(403)
    expect(await listAgentAccounts(user3Page, agentSlug)).toHaveLength(1)
  })

  test('the owner cannot aim a link id at a different agent’s URL', async ({ user2Page }) => {
    // The owner owns both agents, so the ACL lets the call through — only the
    // route's agent+link match stops it from severing the other agent's link.
    const res = await user2Page.request.delete(
      `/api/agents/${otherAgentSlug}/connected-accounts/mapping/${sharedMappingId}`,
    )
    expect(res.status()).toBe(404)
    expect(await listAgentAccounts(user2Page, agentSlug)).toHaveLength(1)
  })

  test('the owner removes the shared connection from the Connections page', async ({
    user2Page,
  }) => {
    await user2Page.goto(`/agents/${agentSlug}/connections`)

    const removeButton = user2Page.getByTestId(`connection-shared-remove-${sharedMappingId}`)
    await expect(removeButton).toBeVisible({ timeout: 15000 })
    await removeButton.click()
    await user2Page.getByTestId('connection-shared-remove-confirm').click()

    await expect(removeButton).toHaveCount(0)
    expect(await listAgentAccounts(user2Page, agentSlug)).toHaveLength(0)
  })

  test('the connection itself survives — only the link died', async ({ user3Page }) => {
    const res = await user3Page.request.get('/api/connected-accounts')
    expect(res.ok()).toBeTruthy()
    const { accounts } = (await res.json()) as { accounts: Array<{ id: string }> }
    expect(accounts.map((a) => a.id)).toContain(sharedAccountId)
  })

  test('an expired shared credential parks the agent on a card the owner cannot clear', async ({
    user2Page,
    user3Page,
  }) => {
    expiredAccountId = await createAccount(user3Page, 'Mel Stale GitHub', 'expired')
    // Let the request past the policy gate so it reaches the re-auth park,
    // which is what this test is about.
    const policyRes = await user3Page.request.put(`/api/policies/scope/${expiredAccountId}`, {
      data: { policies: [{ scope: '*', decision: 'allow' }] },
    })
    expect(policyRes.ok(), `set policy ${policyRes.status()}`).toBeTruthy()
    await assignAccount(user3Page, agentSlug, expiredAccountId)

    // The shared link removed above left the agent empty, so this is the only
    // one. Asserted rather than assumed: picking the wrong link silently would
    // make every dismissal check below prove nothing.
    const owned = await listAgentAccounts(user2Page, agentSlug)
    expect(owned).toHaveLength(1)
    expiredMappingId = (owned[0] as { mappingId: string }).mappingId

    // Waking a session starts the mock container, which records the proxy
    // token — the credential a real agent authenticates to the proxy with.
    const sessionRes = await user2Page.request.post(`/api/agents/${agentSlug}/sessions`, {
      data: { message: 'use the shared connection' },
    })
    expect(sessionRes.ok()).toBeTruthy()
    proxyToken = await waitForProxyToken(agentSlug)
  })

  test('the owner dismisses the reauth card and the parked call fails as dismissed', async ({
    user2Page,
    user3Page,
  }) => {
    // Fire the proxy call the way the container would and leave it hanging.
    const parked = user2Page.request.fetch(
      `/api/proxy/${agentSlug}/${expiredAccountId}/api.github.com/user`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${proxyToken}` },
        timeout: 60000,
        failOnStatusCode: false,
      },
    )

    const requestId = await pendingReauthRequestId(user2Page, agentSlug)

    // The credential is the member's, so the owner cannot reconnect it. Before
    // the escape hatch this was the wedge: nothing to press, five minutes to
    // wait. A cross-agent dismissal still has to bounce.
    const crossAgent = await user2Page.request.post(
      `/api/agents/${otherAgentSlug}/reauth-request/${requestId}/dismiss`,
      { data: {} },
    )
    expect(crossAgent.status()).toBe(404)

    const dismissed = await user2Page.request.post(
      `/api/agents/${agentSlug}/reauth-request/${requestId}/dismiss`,
      { data: { reason: 'the owner is out today' } },
    )
    expect(dismissed.ok(), `dismiss ${dismissed.status()}`).toBeTruthy()

    // The agent learns a person decided this, not that the wait stalled — a
    // 408 timeout would invite it straight back into the same wall.
    const response = await parked
    expect(response.status()).toBe(403)
    const failure = (await response.json()) as { error: string; message: string }
    expect(failure.error).toBe('account_reauth_dismissed')
    // The card's reason box promises the agent hears WHY, so the words the
    // dismisser typed have to survive all the way onto the parked call.
    expect(failure.message).toContain('the owner is out today')

    // Card gone: no session of the agent is still held awaiting input.
    const pending = await user2Page.request.get(`/api/agents/${agentSlug}/pending-requests`)
    const { requests } = (await pending.json()) as { requests: Array<{ kind: string }> }
    expect(requests.filter((r) => r.kind === 'account_reauth_required')).toHaveLength(0)

    // Dismissing abandons one call; it never touches the credential itself.
    const stillThere = await user3Page.request.get('/api/connected-accounts')
    const { accounts } = (await stillThere.json()) as { accounts: Array<{ id: string }> }
    expect(accounts.map((a) => a.id)).toContain(expiredAccountId)
  })

  test('dismissing again is a no-op rather than an error', async ({ user2Page }) => {
    // A second tab, a double click, or a card revived from a stale snapshot
    // must not read as a failure to the person pressing it.
    const res = await user2Page.request.post(
      `/api/agents/${agentSlug}/reauth-request/${'00000000-0000-4000-8000-000000000000'}/dismiss`,
      { data: {} },
    )
    expect(res.ok()).toBeTruthy()
    expect(await res.json()).toMatchObject({ alreadySettled: true })
  })

  test('a member with only `user` on the agent may still dismiss', async ({
    user2Page,
    user3Page,
  }) => {
    // Unlinking is the owner's; abandoning a call the agent is stuck on is not.
    // Whoever can put work into the agent can give up on it.
    const parked = user2Page.request.fetch(
      `/api/proxy/${agentSlug}/${expiredAccountId}/api.github.com/user`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${proxyToken}` },
        timeout: 60000,
        failOnStatusCode: false,
      },
    )

    const requestId = await pendingReauthRequestId(user3Page, agentSlug)
    const res = await user3Page.request.post(
      `/api/agents/${agentSlug}/reauth-request/${requestId}/dismiss`,
      { data: {} },
    )
    expect(res.ok(), `member dismiss ${res.status()}`).toBeTruthy()

    expect((await parked).status()).toBe(403)
  })

  test('the owner can unlink the expired shared credential too', async ({ user2Page }) => {
    const res = await user2Page.request.delete(
      `/api/agents/${agentSlug}/connected-accounts/mapping/${expiredMappingId}`,
    )
    expect(res.ok(), `unlink ${res.status()}`).toBeTruthy()
    expect(await listAgentAccounts(user2Page, agentSlug)).toHaveLength(0)
  })
})

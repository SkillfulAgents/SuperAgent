/**
 * Session-scoped routes must be scoped to the session, not just to the agent.
 *
 * Auth-mode routes authorize the AGENT in the URL. The session id in the URL was
 * never checked against it, and the registries these routes drive — the message
 * persister above all — are keyed by session id ALONE, with no agent dimension.
 * So a user holding a role on their own agent could name a stranger's session id
 * and reach it: subscribe to its live event stream, interrupt it, post into it.
 *
 * This narrative proves the boundary against the real server: two users, two
 * agents, no shared access. Every cross-agent call must 404, and every identical
 * call against the caller's own session must still succeed — a gate that closed
 * the hole by breaking the feature would pass the first half alone.
 */
import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'

// Mirrors the `auth-session-scope` project's dataDir in playwright.auth.config.ts.
const SESSION_SCOPE_DATA_DIR = path.join(
  path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(process.cwd(), '.e2e-data-auth')),
  'session-scope',
)

// Serial narrative — each test builds on state from the previous ones.
test.describe.configure({ mode: 'serial' })

const attacker = { name: 'Mallory Mine', email: 'mallory@test.com', password: 'password123' }
const victim = { name: 'Val Victim', email: 'val@test.com', password: 'password123' }

let attackerAgent = ''
let attackerSession = ''
let victimAgent = ''
let victimSession = ''

async function signUp(page: import('@playwright/test').Page, user: typeof attacker) {
  const authPage = new AuthPage(page)
  const appPage = new AppPage(page)
  await authPage.resetToAuthPage()
  await authPage.signUpOrSignIn(user.name, user.email, user.password)
  await appPage.waitForAppLoaded()
  await appPage.dismissWizardIfVisible()
}

async function createAgentWithSession(
  page: import('@playwright/test').Page,
  agentName: string,
): Promise<{ slug: string; sessionId: string }> {
  const agentRes = await page.request.post('/api/agents', { data: { name: agentName } })
  expect(agentRes.ok()).toBeTruthy()
  const { slug } = (await agentRes.json()) as { slug: string }

  const sessionRes = await page.request.post(`/api/agents/${slug}/sessions`, {
    data: { message: 'hello' },
  })
  expect(sessionRes.ok()).toBeTruthy()
  const { id } = (await sessionRes.json()) as { id: string }

  expect(slug).toBeTruthy()
  expect(id).toBeTruthy()
  return { slug, sessionId: id }
}

test.describe('Cross-agent session scoping', () => {
  test('both users sign up and each creates an agent with a live session', async ({
    user1Page,
    user2Page,
  }) => {
    // The victim signs up FIRST on purpose: the first account in an auth-mode
    // install is promoted to admin, and admins bypass the agent ACL entirely.
    // The attacker has to be an ordinary member for this to test anything.
    await signUp(user2Page, victim)
    const theirs = await createAgentWithSession(user2Page, 'Val Agent')
    victimAgent = theirs.slug
    victimSession = theirs.sessionId

    await signUp(user1Page, attacker)
    const mine = await createAgentWithSession(user1Page, 'Mallory Agent')
    attackerAgent = mine.slug
    attackerSession = mine.sessionId

    // Distinct agents, distinct sessions, no ACL between them.
    expect(attackerAgent).not.toBe(victimAgent)
    expect(attackerSession).not.toBe(victimSession)
  })

  test('the victim’s agent is not reachable directly', async ({ user1Page }) => {
    // Baseline: the agent-level ACL already blocks the obvious route, and it
    // confirms the attacker really is unprivileged. The rest of this narrative
    // is about the session id that the ACL never looked at.
    const res = await user1Page.request.post(
      `/api/agents/${victimAgent}/sessions/${victimSession}/interrupt`,
    )
    expect(res.status()).toBe(403)
  })

  test('interrupt with the victim’s session id under the attacker’s agent 404s', async ({
    user1Page,
  }) => {
    const res = await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${victimSession}/interrupt`,
    )
    expect(res.status()).toBe(404)
  })

  test('the SSE stream for the victim’s session 404s', async ({ user1Page }) => {
    const res = await user1Page.request.get(
      `/api/agents/${attackerAgent}/sessions/${victimSession}/stream`,
    )
    expect(res.status()).toBe(404)
  })

  test('posting a message into the victim’s session 404s', async ({ user1Page }) => {
    const res = await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${victimSession}/messages`,
      { data: { content: 'injected' } },
    )
    expect(res.status()).toBe(404)
  })

  test('broadcasting a typing indicator into the victim’s session 404s', async ({ user1Page }) => {
    const res = await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${victimSession}/typing`,
      { data: {} },
    )
    expect(res.status()).toBe(404)
  })

  test('deleting the victim’s session 404s', async ({ user1Page }) => {
    const res = await user1Page.request.delete(
      `/api/agents/${attackerAgent}/sessions/${victimSession}`,
    )
    expect(res.status()).toBe(404)
  })

  test('a transcript forged in the attacker’s own workspace does not reach the victim’s session', async ({ user1Page }) => {
    // The attacker's workspace is bind-mounted read/write into its own
    // container, so its agent can create any file it likes in there — including
    // one named after a session it does not own. Written directly here, since
    // the mock container does not run real tool calls.
    //
    // Deliberately no status assertion. Whether the route refuses the id or
    // accepts it and resolves it inside the attacker's OWN namespace is an
    // implementation choice; the property that has to hold either way is
    // asserted by the two tests below — the victim's session survives, and the
    // victim can still drive it.
    const attackerAgentDir = path.join(SESSION_SCOPE_DATA_DIR, 'agents', attackerAgent)
    // Fail loudly rather than forging into a path nothing reads: a wrong data
    // dir here would turn the whole test into a silent no-op.
    expect(fs.existsSync(attackerAgentDir)).toBeTruthy()

    const forged = path.join(
      attackerAgentDir,
      'workspace', '.claude', 'projects', '-workspace',
      `${victimSession}.jsonl`,
    )
    fs.mkdirSync(path.dirname(forged), { recursive: true })
    fs.writeFileSync(forged, '{}\n')

    await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${victimSession}/interrupt`,
    )
    await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${victimSession}/messages`,
      { data: { content: 'injected' } },
    )
    await user1Page.request.delete(`/api/agents/${attackerAgent}/sessions/${victimSession}`)
  })

  test('the victim’s session survives every attempt', async ({ user2Page }) => {
    const res = await user2Page.request.get(
      `/api/agents/${victimAgent}/sessions/${victimSession}`,
    )
    expect(res.ok()).toBeTruthy()
    const session = (await res.json()) as { id: string }
    expect(session.id).toBe(victimSession)
  })

  test('the victim can still drive their own session afterwards', async ({ user2Page }) => {
    // Survival is not just "the row is still there": the session must still be
    // usable. A gate that left the victim's live state half torn down would
    // pass the GET above and fail here.
    const typing = await user2Page.request.post(
      `/api/agents/${victimAgent}/sessions/${victimSession}/typing`,
      { data: {} },
    )
    expect(typing.ok()).toBeTruthy()

    const message = await user2Page.request.post(
      `/api/agents/${victimAgent}/sessions/${victimSession}/messages`,
      { data: { content: 'still mine' } },
    )
    expect(message.ok()).toBeTruthy()
  })

  test('the attacker can still drive their OWN session', async ({ user1Page }) => {
    const typing = await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${attackerSession}/typing`,
      { data: {} },
    )
    expect(typing.ok()).toBeTruthy()

    const message = await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${attackerSession}/messages`,
      { data: { content: 'my own session' } },
    )
    expect(message.ok()).toBeTruthy()

    const interrupt = await user1Page.request.post(
      `/api/agents/${attackerAgent}/sessions/${attackerSession}/interrupt`,
    )
    expect(interrupt.ok()).toBeTruthy()
  })
})

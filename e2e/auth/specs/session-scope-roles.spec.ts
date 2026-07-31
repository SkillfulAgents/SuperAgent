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
import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'

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

  test('the victim’s session survives every attempt', async ({ user2Page }) => {
    const res = await user2Page.request.get(
      `/api/agents/${victimAgent}/sessions/${victimSession}`,
    )
    expect(res.ok()).toBeTruthy()
    const session = (await res.json()) as { id: string }
    expect(session.id).toBe(victimSession)
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

import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'http'
import * as fs from 'fs/promises'
import path from 'path'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'
import { SessionPage } from '../../pages/session.page'
import { mockRecorder } from '../../helpers/mock-recorder'

/** Run: npx playwright test --config playwright.connection-replacement-demo.config.ts
 * Real Auth Mode, app UI, proxy, SQLite mapping swap and session lifecycle.
 * Only the agent/model and upstream Slack provider are simulated. */
test.skip(process.env.E2E_CONNECTION_REPLACEMENT_DEMO !== 'true', 'Requires the dedicated Auth Mode demo config')

test('a non-owner replaces expired Slack and the interrupted script resumes with its new ID', async ({ browser, baseURL }, testInfo) => {
  const upstreamCalls: string[] = []
  const upstream = createServer((req, res) => {
    if (req.url !== '/api/conversations.list') { res.writeHead(404).end(); return }
    upstreamCalls.push(String(req.headers['x-demo-connection-id']))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, channels: [{ name: 'general' }, { name: 'product' }, { name: 'engineering' }] }))
  })
  const upstreamUrl = URL.parse(process.env.E2E_DEMO_SLACK_URL!)
  if (!upstreamUrl) throw new Error('Invalid mock Slack URL')
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(Number(upstreamUrl.port), '127.0.0.1', resolve)
  })
  const contexts: BrowserContext[] = []
  const recorder = mockRecorder<{
    type: string; agentSlug?: string; sessionId?: string; content?: string;
    key?: string; value?: string; scope?: string; hadTurnInFlight?: boolean;
  }>()
  const marks: Record<string, number> = {}

  async function signUp(name: string, email: string) {
    const context = await browser.newContext({ baseURL })
    contexts.push(context)
    const page = await context.newPage()
    const auth = new AuthPage(page)
    await page.goto('/')
    await auth.signUpOrSignIn(name, email, 'password123')
    const app = new AppPage(page)
    await app.waitForAppLoaded()
    await app.dismissWizardIfVisible()
    return page
  }
  async function account(page: Page, providerConnectionId: string, displayName: string, status: string) {
    const res = await page.request.post('/api/connected-accounts', {
      data: { providerConnectionId, toolkitSlug: 'slack', displayName, status },
    })
    expect(res.ok()).toBeTruthy()
    const { account: created } = await res.json() as { account: { id: string } }
    const policies = await page.request.put(`/api/policies/scope/${created.id}`, {
      data: { policies: [{ scope: '*', decision: 'allow' }] },
    })
    expect(policies.ok()).toBeTruthy()
    return created.id
  }
  async function pause(page: Page, ms: number) {
    // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- video pacing after assertions, never synchronization
    await page.waitForTimeout(ms)
  }
  try {
    // The first signup becomes global admin. The two people in the demo must
    // be ordinary users so this genuinely exercises the agent member ACL.
    await signUp('Demo Admin', 'admin@demo.test')
    const owner = await signUp('Odette Owner', 'owner@demo.test')
    const member = await signUp('Mel Member', 'member@demo.test')
    const agentRes = await owner.request.post('/api/agents', { data: { name: 'Shared Slack Agent' } })
    expect(agentRes.ok()).toBeTruthy()
    const { slug } = await agentRes.json() as { slug: string }
    const search = await owner.request.get(`/api/agents/${slug}/access/search-users?q=member%40demo.test`)
    const users = await search.json() as Array<{ id: string; email: string }>
    const memberId = users.find((u) => u.email === 'member@demo.test')!.id
    const grant = await owner.request.post(`/api/agents/${slug}/access`, { data: { userId: memberId, role: 'user' } })
    expect(grant.status()).toBe(201)
    const oldId = await account(owner, 'demo-slack-owner-expired', 'Odette — Shared workspace', 'expired')
    const newId = await account(member, 'demo-slack-member-active', 'Mel — Demo workspace', 'active')
    expect(newId).not.toBe(oldId)
    const assignment = await owner.request.post(`/api/agents/${slug}/connected-accounts`, { data: { accountIds: [oldId] } })
    expect(assignment.ok()).toBeTruthy()

    // Only record the actual member walkthrough, not signup/setup.
    const context = await browser.newContext({
      baseURL, storageState: await member.context().storageState(),
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: testInfo.outputPath('recording'), size: { width: 1440, height: 900 } },
    })
    contexts.push(context)
    const page = await context.newPage()
    marks.recordingStart = Date.now()
    await page.goto(`/agents/${slug}`)
    const session = new SessionPage(page)
    await expect(session.getMessageInput()).toBeVisible()
    marks.start = Date.now()
    await pause(page, 1200)
    await session.getMessageInput().pressSequentially('List the Slack channels using the shared connection.', { delay: 38 })
    await pause(page, 800)
    const createdSession = page.waitForResponse((r) => r.url().endsWith(`/api/agents/${slug}/sessions`) && r.request().method() === 'POST')
    await session.getSendButton().click()
    const sessionRes = await createdSession
    expect(sessionRes.ok()).toBeTruthy()
    const { id: sessionId } = await sessionRes.json() as { id: string }

    const expired = page.getByTestId('account-reauth-request')
    await expect(expired).toBeVisible({ timeout: 30_000 })
    await expect(expired).toContainText('This request needs Slack access that has expired.')
    await expect(expired).toContainText('Replace it with an account you own')
    await expect(page.getByTestId('account-reauth-reconnect-btn')).toHaveCount(0)
    expect(upstreamCalls).toEqual([])
    marks.expired = Date.now()
    await page.screenshot({ path: testInfo.outputPath('expired.png') })
    await pause(page, 3500)
    await page.getByTestId('account-reauth-replace-btn').hover()
    await pause(page, 1000)
    await page.getByTestId('account-reauth-replace-btn').click()
    const picker = page.getByTestId('connected-account-request')
    await expect(picker).toBeVisible()
    await expect(picker).toContainText('Mel — Demo workspace')
    await expect(picker).not.toContainText('Odette — Shared workspace')
    marks.picker = Date.now()
    await page.screenshot({ path: testInfo.outputPath('picker.png') })
    await pause(page, 4500)
    const submit = picker.getByRole('button', { name: 'Replace connection', exact: true })
    await expect(submit).toBeEnabled()
    await submit.hover()
    await pause(page, 1000)
    const replacementResponse = page.waitForResponse((r) => r.url().endsWith('/replace-account') && r.request().method() === 'POST')
    marks.replace = Date.now()
    await submit.click()
    const replacement = await replacementResponse
    expect(replacement.ok()).toBeTruthy()
    expect(await replacement.json()).toMatchObject({ success: true, liveRefresh: true, sessionNotification: true })
    await expect(expired).toHaveCount(0)
    await expect(picker).toHaveCount(0)
    await expect(page.getByText('The script ran successfully against the mock Slack API.', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('message-assistant').getByText(newId, { exact: true })).toBeVisible()
    const notice = page.getByTestId('connection-replacement-notice')
    await expect(notice).toContainText('Slack connection replaced')
    await expect(notice).toContainText('Session interrupted. Agent notified')
    await expect(page.getByTestId('interrupt-marker')).toHaveCount(0)
    await expect(page.getByText('#engineering', { exact: true })).toBeVisible()
    expect(upstreamCalls).toEqual(['demo-slack-member-active'])

    const sent = await recorder.waitFor((r) => r.type === 'sendMessage' && r.sessionId === sessionId && !!r.content?.includes(`New account ID: ${newId}`))
    expect(sent.content).toContain(`Previous account ID: ${oldId}`)
    const events = recorder.read().filter((r) => r.agentSlug === slug)
    const refreshIndex = events.findIndex((r) => r.type === 'connectionEnvironment' && !!r.value?.includes(newId))
    const interruptIndex = events.findIndex((r) => r.type === 'interruptSession' && r.sessionId === sessionId)
    const messageIndex = events.findIndex((r) => r.type === 'sendMessage' && r.content === sent.content)
    expect(refreshIndex).toBeGreaterThanOrEqual(0)
    expect(interruptIndex).toBeGreaterThan(refreshIndex)
    expect(messageIndex).toBeGreaterThan(interruptIndex)
    expect(events[interruptIndex]).toMatchObject({ scope: 'turn', hadTurnInFlight: true })
    const projected = JSON.parse(events[refreshIndex].value!)
    expect(JSON.stringify(projected)).toContain(newId)
    expect(JSON.stringify(projected)).not.toContain(oldId)
    const mappings = await page.request.get(`/api/agents/${slug}/connected-accounts`)
    expect((await mappings.json()).accounts.map((a: { id: string }) => a.id)).toEqual([newId])
    const originalAccounts = await owner.request.get('/api/connected-accounts')
    expect((await originalAccounts.json()).accounts.some((a: { id: string }) => a.id === oldId)).toBe(true)
    const scriptPath = path.join(process.env.SUPERAGENT_DATA_DIR!, 'agents', slug, 'workspace', 'scripts', 'list-slack-channels.mjs')
    const script = await fs.readFile(scriptPath, 'utf8')
    expect(script).toContain(newId)
    expect(script).not.toContain(oldId)
    marks.complete = Date.now()
    await page.screenshot({ path: testInfo.outputPath('continued.png') })
    await fs.writeFile(testInfo.outputPath('evidence.json'), JSON.stringify({
      mock: 'Model/runtime and local Slack provider; real application UI, APIs, script execution and authorization',
      agentSlug: slug, sessionId, memberRole: 'user', oldId, newId, systemMessage: sent.content,
      runtimeSequence: events.filter((r) => ['connectionEnvironment', 'interruptSession', 'sendMessage'].includes(r.type)),
      upstreamCalls, script,
    }, null, 2))
    await notice.getByText('Connection details', { exact: true }).click()
    await expect(notice.getByText(oldId, { exact: true })).toBeVisible()
    await expect(notice.getByText(newId, { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('replacement-details.png') })
    await pause(page, 4000)
    await notice.getByText('Connection details', { exact: true }).click()
    await pause(page, 3000)
    marks.end = Date.now()
    await fs.writeFile(testInfo.outputPath('marks.json'), JSON.stringify(marks, null, 2))
    const video = page.video()!
    await context.close()
    await video.saveAs(testInfo.outputPath('demo.webm'))
    // The same renderer must survive reloading persisted history.
    await member.goto(`/agents/${slug}/sessions/${sessionId}`)
    await expect(member.getByTestId('connection-replacement-notice')).toContainText('Slack connection replaced')
    await expect(member.getByTestId('interrupt-marker')).toHaveCount(0)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
  }
})

/** Real Docker + Anthropic + browser probe. See README.md for prerequisites. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect, type Browser, type Page } from '@playwright/test'
import { z } from 'zod'
import { SessionPage } from '../../pages/session.page'

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, '').split('=')
  return [key, value.join('=')]
}))
const mode = z.enum(['bug', 'fixed']).parse(args.expect ?? 'fixed')
const image = args.image ?? 'superagent-container:thinking-followup'
const source = args.source ?? path.join(os.homedir(), 'Downloads/superagent-sdk257')
const port = Number(args.port ?? 3476)
const base = `http://127.0.0.1:${port}`
const runDir = path.resolve(args.output ?? `test-results/live-thinking-${mode}-${Date.now()}`)
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'thinking-followup-data-'))
const model = args.model ?? 'claude-sonnet-4-6'
const messageSchema = z.object({
  id: z.string(), type: z.string(), queued: z.boolean().optional(),
  content: z.object({ text: z.string().optional() }).passthrough(),
  thinking: z.array(z.object({ id: z.string().optional(), text: z.string() })).optional(),
}).passthrough()
const messagesSchema = z.array(messageSchema)
type ProbeEvent = { type: string; thinkingId?: string; queuedMidTurn?: boolean; isActive?: boolean; taskId?: string }
declare global {
  interface Window { thinkingProbeEvents: ProbeEvent[] }
}

async function json(url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert(response.ok, `${url}: HTTP ${response.status}`)
  return response.json()
}

async function main() {
  mkdirSync(runDir, { recursive: true })
  let host: ReturnType<typeof spawn> | undefined
  let browser: Browser | undefined
  let slug: string | undefined
  let sessionUrl: string | undefined
  let page: Page | undefined
  const output = createWriteStream(path.join(runDir, 'host.log'), { mode: 0o600 })
  try {
    // Copy only the required key; never print it or copy the source database.
    const settings = JSON.parse(readFileSync(path.join(source, 'settings.json'), 'utf8'))
    const key = settings.apiKeys?.anthropicApiKey
    assert(typeof key === 'string' && key.length > 0, 'Source has no Anthropic API key')
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      apiKeys: { anthropicApiKey: key }, llmProvider: 'anthropic',
      models: { agentModel: model },
      container: { containerRunner: 'docker', agentImage: image, resourceLimits: { cpu: 2, memory: '2g' } },
      app: { setupCompleted: true }, shareAnalytics: false, shareErrorReports: false,
    }), { mode: 0o600 })
    const env = { ...process.env, SUPERAGENT_DATA_DIR: dataDir, VITE_CACHE_DIR: path.join(dataDir, '.vite'), PORT: String(port),
      SUPERAGENT_BASE_PORT: '5900', E2E_MOCK: '', AUTH_MODE: 'false', NODE_ENV: 'development' }
    // Use the seeded direct Anthropic account, not ambient provider overrides.
    for (const name of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|GENERIC_|OPENROUTER_)/.test(name)) delete env[name as keyof typeof env]
    }
    host = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    host.stdout?.pipe(output)
    host.stderr?.pipe(output)
    await expect.poll(async () => {
      try { return (await fetch(`${base}/api/settings`)).ok } catch { return false }
    }, { timeout: 120_000 }).toBe(true)
    console.log(`Real host ready: ${base}; evidence: ${runDir}`)
    slug = z.object({ slug: z.string() }).parse(await json('/api/agents', { name: `Thinking follow-up ${mode}` })).slug
    const session = z.object({ id: z.string() }).parse(await json(`/api/agents/${slug}/sessions`, {
      message: 'Reply exactly READY. Do not use any tools.', model, effort: 'high',
    }))
    sessionUrl = `/api/agents/${slug}/sessions/${session.id}`
    await expect.poll(async () => {
      const sessions = z.array(z.object({ id: z.string(), isActive: z.boolean() })).parse(await json(`/api/agents/${slug}/sessions`))
      return sessions.find(item => item.id === session.id)?.isActive
    }, { timeout: 180_000, intervals: [1000] }).toBe(false)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, recordVideo: { dir: runDir } })
    await context.addInitScript(() => {
      const events: ProbeEvent[] = []
      window.thinkingProbeEvents = events
      const NativeEventSource = window.EventSource
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options)
          this.addEventListener('message', event => {
            try {
              const value = JSON.parse(event.data)
              if (typeof value.type === 'string') events.push({
                type: value.type, thinkingId: value.thinkingId, queuedMidTurn: value.queuedMidTurn,
                isActive: value.isActive, taskId: value.taskId,
              })
            } catch { /* Ignore non-JSON keepalives. */ }
          })
        }
      }
    })
    page = await context.newPage()
    page.on('pageerror', error => console.error(`Browser error: ${error.message}`))
    page.on('requestfailed', request => {
      if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
        console.error(`Browser request failed: ${request.url()} ${request.failure()?.errorText}`)
      }
    })
    await page.goto(`${base}/agents/${slug}/sessions/${session.id}`)
    const composer = new SessionPage(page)
    await expect(composer.getMessageInput()).toBeVisible({ timeout: 30_000 })
    const prompt = 'Run this small diagnostic using exactly three separate Bash calls in order, waiting for each result before the next: first printf "probe-one\\n"; second printf "probe-two\\n"; third sleep 600 with run_in_background=true. Consider each result before proceeding. After the third call returns its background task ID, reply exactly BACKGROUND_READY and END YOUR TURN. Do not wait for, poll, or stop the background task. When I later send status ?, reply exactly STILL_RUNNING without tools and leave the task running.'
    await composer.sendMessage(prompt)
    await expect.poll(() => page!.evaluate(() => window.thinkingProbeEvents.some(event => event.type === 'session_waiting_background')),
      { timeout: 180_000, intervals: [1000] }).toBe(true)
    await expect(page.getByText('BACKGROUND_READY', { exact: true })).toBeVisible({ timeout: 30_000 })
    const before = messagesSchema.parse(await json(`${sessionUrl}/messages`))
    const promptIndex = before.findIndex(message => message.type === 'user' && message.content.text?.includes('Run this small diagnostic'))
    assert(promptIndex >= 0, 'Prompt must be persisted')
    const priorThinking = before.slice(promptIndex).flatMap(message => message.thinking ?? []).filter(block => block.text.trim())
    assert(priorThinking.length > 0, 'Need persisted reasoning from the real model')
    await expect(page.getByTestId('thinking-block')).toHaveCount(priorThinking.length, { timeout: 15_000 })
    await page.screenshot({ path: path.join(runDir, 'before-followup.png'), fullPage: true })
    const eventsBeforeSend = await page.evaluate(() => window.thinkingProbeEvents.length)
    const response = page.waitForResponse(res => res.url().endsWith(`${sessionUrl}/messages`) && res.request().method() === 'POST')
    await composer.sendMessage('status ?')
    const receipt = z.object({ queued: z.boolean() }).parse(await (await response).json())
    await expect(page.getByText('STILL_RUNNING', { exact: true })).toBeVisible({ timeout: 120_000 })
    await expect.poll(() => page!.evaluate(start => window.thinkingProbeEvents.slice(start).some(event => event.type === 'turn_output_complete'), eventsBeforeSend),
      { timeout: 60_000, intervals: [1000] }).toBe(true)
    const after = messagesSchema.parse(await json(`${sessionUrl}/messages`))
    const followupIndex = after.findLastIndex(message => message.type === 'user' && message.content.text?.trim().endsWith('status ?'))
    assert(followupIndex >= 0, 'Follow-up must be persisted')
    assert(!after[followupIndex].queued, 'Follow-up must start a new foreground turn')
    const currentThinking = after.slice(followupIndex).flatMap(message => message.thinking ?? []).filter(block => block.text.trim())
    const cardsBelowFollowup = page.locator('xpath=//*[@data-testid="message-user" and contains(., "status ?")]/following::*[@data-testid="thinking-block"]')
    const expectedCards = currentThinking.length + (mode === 'bug' ? priorThinking.length : 0)
    await expect(cardsBelowFollowup).toHaveCount(expectedCards, { timeout: 15_000 })
    await page.screenshot({ path: path.join(runDir, 'after-followup.png'), fullPage: true })
    const events = await page.evaluate(() => window.thinkingProbeEvents)
    const sessionActive = z.object({ isActive: z.boolean() }).parse(await json(sessionUrl)).isActive
    assert(sessionActive, 'The background job must still be keeping the session active')
    const proof = { mode, model, image, imageId: execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim(),
      gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      slug, sessionId: session.id, receipt, priorThinking: priorThinking.length, currentThinking: currentThinking.length,
      cardsBelowFollowup: await cardsBelowFollowup.count(), resurrectedCards: expectedCards - currentThinking.length,
      sessionActive, events }
    writeFileSync(path.join(runDir, 'proof.json'), JSON.stringify(proof, null, 2))
    // Persist counts/identities, not the model's reasoning text.
    console.log(JSON.stringify({ mode, priorThinking: proof.priorThinking, currentThinking: proof.currentThinking,
      cardsBelowFollowup: proof.cardsBelowFollowup, resurrectedCards: proof.resurrectedCards, receipt }))
    await context.close()
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(runDir, 'failure.png'), fullPage: true }).catch(() => {})
      writeFileSync(path.join(runDir, 'events-on-failure.json'), JSON.stringify(await page.evaluate(() => window.thinkingProbeEvents).catch(() => []), null, 2))
    }
    throw error
  } finally {
    if (sessionUrl) await json(`${sessionUrl}/interrupt`, { scope: 'all' }).catch(() => {})
    await browser?.close()
    if (host?.pid) {
      try { process.kill(-host.pid, 'SIGTERM') } catch { host.kill('SIGTERM') }
    }
    if (slug) {
      try { execFileSync('docker', ['rm', '-f', `superagent-${slug}`], { stdio: 'ignore' }) } catch { /* Already stopped. */ }
    }
    output.end()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })

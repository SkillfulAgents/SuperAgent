/** Opt-in real app → Docker agent → model → Bash validation. See README.md. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, expect, type Browser, type Page } from '@playwright/test'
import { z } from 'zod'
import { SessionPage } from '../../pages/session.page'
import { runHttpTransport } from './http-transport'
import {
  agentSchema, artifactManifestSchema, containerIdentitySchema, eventSchema, messagesSchema,
  optionsSchema, projectPythonSchema, proofSchema, receiptSchema, sessionSchema, sessionStateSchema,
  toolEvidenceSchema, widgetRefreshSchema,
} from './schema'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=')
  return [key, value.join('=')]
}))
const options = optionsSchema.parse({
  baseUrl: args['base-url'] ?? 'http://127.0.0.1:47931',
  image: args.image ?? 'superagent-container:runtime-refresh',
  model: args.model ?? process.env.CONTAINER_SMOKE_MODEL ?? 'claude-haiku-5-5',
  providerId: args.provider ?? process.env.CONTAINER_SMOKE_PROVIDER_ID,
  transport: args.transport !== undefined && args.transport !== 'false',
  appContainer: args['app-container'],
  appImageId: args['app-image-id'],
  agentImageId: args['agent-image-id'],
  output: path.resolve(args.output ?? `/tmp/container-refresh/runtime-proof-${Date.now()}`),
  timeoutMs: args['timeout-ms'] ?? 600_000,
  expected: {
    node: args.node ?? '22.23.4', python: args.python ?? '3.11.17',
    uv: args.uv ?? '0.13.4', bun: args.bun ?? '1.4.3',
    rclone: args.rclone ?? '1.75.2', typescript: args.typescript ?? '5.9.3',
    'ts-node': args['ts-node'] ?? '10.9.2',
  },
})
const base = options.baseUrl.replace(/\/$/, '')
const runId = randomUUID()
const relativeRoot = `runtime-smoke-${runId}`
const workspaceRoot = `/workspace/${relativeRoot}`
const project = `${workspaceRoot}/agent-project`
const initialMarker = `runtime:${runId}:42:six-1.17.0`
const resumeMarker = `resume:${runId}:42:six-1.17.0`
const startedAt = Date.now()

declare global {
  interface Window { containerRuntimeProbeCounts: Record<string, number> }
}

async function request(route: string, method = 'GET', body?: unknown): Promise<Response> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  assert(response.ok, `${method} ${route}: HTTP ${response.status}`)
  return response
}

async function json(route: string, method = 'GET', body?: unknown): Promise<unknown> {
  return (await request(route, method, body)).json()
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = options.timeoutMs): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function docker(...dockerArgs: string[]): Promise<string> {
  const result = await exec('docker', dockerArgs, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trim()
}

async function containerIdentity(name: string) {
  // Never dump docker inspect: Config.Env contains the agent's credentials.
  const selected = await docker('inspect', '--format', '{{.Id}} {{.Image}} {{.Config.Image}} {{.State.Running}}', name)
  const [id, imageId, image, running] = selected.split(' ')
  return containerIdentitySchema.parse({ id, imageId, image, running: running === 'true' })
}

async function fixture(name: string, phase: 'initial' | 'restart') {
  const fixturePath = `/tmp/container-runtime-tools-${runId}.sh`
  await docker('cp', path.join(here, 'tools-smoke.sh'), `${name}:${fixturePath}`)
  await docker('exec', '--user', 'root', name, 'chmod', '0555', fixturePath)
  let stdout: string
  let stderr: string
  try {
    ({ stdout, stderr } = await exec('docker', [
      'exec', '--user', 'claude', name, 'bash', fixturePath, phase, `${workspaceRoot}/deterministic`,
    ], { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 }))
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    await writeFile(path.join(options.output, `tools-${phase}.log`), `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { mode: 0o600 })
    throw new Error(`Deterministic ${phase} tools failed; inspect tools-${phase}.log`)
  }
  await writeFile(path.join(options.output, `tools-${phase}.log`), `${stdout}\n${stderr}`, { mode: 0o600 })
  const versions: Record<string, string> = {}
  const checks: string[] = []
  for (const line of stdout.split('\n')) {
    const [kind, key, value] = line.split('\t')
    if (kind === 'RUNTIME' && key && value) versions[key] = value
    if (kind === 'CHECK' && key && value === 'ok') checks.push(key)
  }
  const evidence = toolEvidenceSchema.parse({ phase, versions, checks })
  for (const [name, version] of Object.entries(options.expected)) {
    assert.equal(evidence.versions[name], version, `${name} version`)
  }
  const required = phase === 'initial'
    ? ['python-stdlib', 'pip-user', 'stdlib-venv', 'copied-venv', 'uv-venv', 'native-wheel', 'uv-project', 'uv-tool', 'uvx', 'node-typescript', 'bun', 'archives', 'media', 'rclone', 'python-helpers']
    : ['persisted-pip-user', 'persisted-stdlib-venv', 'persisted-copied-venv', 'persisted-uv-venv', 'persisted-native-wheel', 'persisted-uv-project', 'persisted-uv-tool', 'persisted-bun', 'persisted-files']
  for (const check of required) assert(checks.includes(check), `Missing tools check: ${check}`)
  console.log(`[runtime-smoke] ${phase}: ${checks.length} deterministic tool checks passed`)
  return evidence
}

async function readAgentFile(slug: string, relative: string): Promise<string | undefined> {
  const response = await fetch(`${base}/api/agents/${slug}/files/${relative.split('/').map(encodeURIComponent).join('/')}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) return undefined
  assert(response.ok, `Read test artifact: HTTP ${response.status}`)
  return response.text()
}

async function projectPython(container: string) {
  const output = await docker('exec', '--user', 'claude', container, `${project}/.venv/bin/python`, '-c',
    'import json, platform, sys; print(json.dumps({"version": platform.python_version(), "prefix": sys.prefix, "basePrefix": sys.base_prefix}))')
  let value: unknown
  try { value = JSON.parse(output) }
  catch { throw new Error('Agent project interpreter returned invalid identity JSON') }
  const identity = projectPythonSchema.parse(value)
  assert.equal(identity.version, options.expected.python, 'Agent project must use the candidate Python version')
  assert.equal(identity.prefix, `${project}/.venv`, 'Agent project must use its own venv')
  assert(identity.basePrefix.startsWith('/opt/python/'), 'Agent venv must use image-managed Python')
  return identity
}

function bashCalls(messages: z.infer<typeof messagesSchema>) {
  return messages.flatMap(message => message.toolCalls).filter(call => call.name === 'Bash')
}

async function artifactScenario(slug: string, page: Page, sessionRoutes: string[]) {
  const artifactSlug = `runtime-${runId.slice(0, 8)}`
  const marker = `artifact:${runId}`
  const artifactRoot = `/workspace/artifacts/${artifactSlug}`
  const prompt = `Create your own small plain Bun/TypeScript dashboard AND widget in ${artifactRoot}. Read the dashboards and widgets skill contracts as needed. Do not use React, Vite, external packages, credentials, environment listings, delegation, or unrelated files. package.json must have name, description, scripts.start="bun run serve.ts", scripts.widget="bun run widget.ts", and gamut.widget.size="small". Write serve.ts yourself using Bun.serve on Number(process.env.DASHBOARD_PORT), serving an HTML document with visible text ${marker}, an initial counter 42 in data-testid="runtime-counter", and a button data-testid="runtime-increment" which increments it to 43 in browser JavaScript. Write widget.ts yourself: compute 19+23, write static widget.html showing ${marker} and 42 with inline CSS supporting light/dark via html[data-theme], and write widget.json with validUntil two hours in the future. Use Bun.write and a typed variable in both TypeScript files. Execute bun run widget. Use the platform start_dashboard tool to start this exact artifact, and refresh_widget to render its widget; inspect the tool outcomes and fix any failures. After those actually succeed, write exactly ${marker} to ${workspaceRoot}/artifact-result.txt using Bash and reply ARTIFACT_READY. Leave the managed dashboard running, but start no other background jobs.`
  const session = sessionSchema.parse(await json(`/api/agents/${slug}/sessions`, 'POST', {
    message: prompt, model: options.model, llmProviderId: options.providerId,
  }))
  const route = `/api/agents/${slug}/sessions/${session.id}`
  sessionRoutes.push(route)
  await page.goto(`${base}/agents/${slug}/sessions/${session.id}`)
  await waitFor('agent-authored Bun dashboard and widget', async () => {
    const result = await readAgentFile(slug, `${relativeRoot}/artifact-result.txt`)
    return result?.trim() === marker && !sessionStateSchema.parse(await json(route)).isActive
  })
  const messages = messagesSchema.parse(await json(`${route}/messages`))
  assert(!messages.some(message => message.apiError), 'Model API error in artifact transcript')
  const calls = messages.flatMap(message => message.toolCalls).filter(call => call.isError === false)
  for (const name of ['Bash', 'start_dashboard', 'refresh_widget']) {
    assert(calls.some(call => call.name === name || call.name.endsWith(`__${name}`)), `Artifact agent must execute ${name}`)
  }
  const manifestText = await readAgentFile(slug, `artifacts/${artifactSlug}/package.json`)
  assert(manifestText, 'Agent-authored artifact manifest is missing')
  try { artifactManifestSchema.parse(JSON.parse(manifestText)) }
  catch { throw new Error('Agent-authored artifact manifest does not meet the dashboard/widget contract') }
  for (const file of ['serve.ts', 'widget.ts']) {
    const source = await readAgentFile(slug, `artifacts/${artifactSlug}/${file}`)
    assert(source, `Agent-authored ${file} is missing`)
    await writeFile(path.join(options.output, `agent-${file}`), source, { mode: 0o600 })
  }
  const artifactRoute = `/api/agents/${slug}/artifacts/${artifactSlug}`
  // An explicit platform refresh proves the new Bun script and the image's
  // Chromium execute. A mock snapshot or lastError alone cannot pass this.
  const refresh = widgetRefreshSchema.parse(await json(`${artifactRoute}/widget/refresh`, 'POST'))
  const pngs: Array<{ name: string; width: number; height: number; sha256: string }> = []
  for (const family of ['small', 'medium'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const scale of [2, 3]) {
        const name = `${family}-${scheme}@${scale}x`
        assert(refresh.snapshot.renderedSizes.includes(name), `Missing rendered widget variant ${name}`)
        const response = await request(`${artifactRoute}/widget/snapshot?family=${family}&scheme=${scheme}&scale=${scale}`)
        assert(response.headers.get('content-type')?.includes('image/png'), 'Snapshot must be served as PNG')
        const bytes = Buffer.from(await response.arrayBuffer())
        assert(bytes.length > 100, 'PNG is empty')
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature')
        assert.equal(bytes.subarray(12, 16).toString(), 'IHDR', 'PNG header')
        const width = bytes.readUInt32BE(16)
        const height = bytes.readUInt32BE(20)
        assert.equal(width, (family === 'small' ? 170 : 364) * scale)
        assert.equal(height, 170 * scale)
        await writeFile(path.join(options.output, `${name}.png`), bytes, { mode: 0o600 })
        pngs.push({ name, width, height, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  for (const scheme of ['light', 'dark']) {
    const html = await (await request(`${artifactRoute}/widget/html?scheme=${scheme}`)).text()
    assert(html.includes(marker) && html.includes('42'), `Rendered ${scheme} widget content`)
  }
  const dashboard = await page.context().newPage()
  try {
    await dashboard.goto(`${base}${artifactRoute}/`)
    await expect(dashboard.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(dashboard.getByTestId('runtime-counter')).toHaveText('42')
    await dashboard.getByTestId('runtime-increment').click()
    await expect(dashboard.getByTestId('runtime-counter')).toHaveText('43')
    await dashboard.screenshot({ path: path.join(options.output, 'dashboard-interaction.png'), fullPage: true })
  } finally {
    await dashboard.close()
  }
  await page.screenshot({ path: path.join(options.output, 'artifact-ready.png'), fullPage: true })
  console.log('[runtime-smoke] Real agent authored Bun dashboard/widget; app-proxied interaction and all 8 Chromium PNG variants passed')
  return {
    slug: artifactSlug, sessionId: session.id, successfulToolCalls: calls.length,
    dashboardCounterBefore: 42, dashboardCounterAfter: 43, snapshot: refresh.snapshot, pngs,
  }
}

async function main() {
  await mkdir(options.output, { recursive: true, mode: 0o700 })
  let browser: Browser | undefined
  let page: Page | undefined
  let slug: string | undefined
  let sessionRoute: string | undefined
  let container: string | undefined
  const sessionRoutes: string[] = []
  let completedProof: z.infer<typeof proofSchema> | undefined
  let executionError: unknown
  try {
    if (options.transport) {
      assert(options.appContainer && options.appImageId && options.agentImageId,
        '--transport requires --app-container, --app-image-id and --agent-image-id')
    }
    await request('/api/settings') // Check readiness without reading or logging settings.
    slug = agentSchema.parse(await json('/api/agents', 'POST', { name: `Runtime smoke ${runId.slice(0, 8)}` })).slug
    // Prewarming also resolves agent defaults; keep it on the selected scratch
    // connection even when the app's unrelated global provider is unconfigured.
    await request(`/api/agents/${slug}/preferences`, 'PUT', {
      defaultLlmProviderId: options.providerId, defaultModel: options.model,
    })
    container = `superagent-${slug}`
    await request(`/api/agents/${slug}/start`, 'POST')
    const before = await containerIdentity(container)
    assert.equal(before.image, options.image, 'The host must use the requested refreshed image')
    const tools = [await fixture(container, 'initial')]

    const session = sessionSchema.parse(await json(`/api/agents/${slug}/sessions`, 'POST', {
      message: 'Reply exactly READY. Do not use tools.', model: options.model, llmProviderId: options.providerId,
    }))
    sessionRoute = `/api/agents/${slug}/sessions/${session.id}`
    sessionRoutes.push(sessionRoute)
    await waitFor('warm-up turn to settle', async () => !sessionStateSchema.parse(await json(sessionRoute!)).isActive)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      window.containerRuntimeProbeCounts = {}
      const NativeEventSource = window.EventSource
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          this.addEventListener('message', event => {
            try {
              const value: unknown = JSON.parse(event.data)
              if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string' && value.type.length <= 100) {
                const type = value.type
                window.containerRuntimeProbeCounts[type] = (window.containerRuntimeProbeCounts[type] ?? 0) + 1
              }
            } catch { /* Ignore stream keepalives. */ }
          })
        }
      }
    })
    page = await context.newPage()
    await page.goto(`${base}/agents/${slug}/sessions/${session.id}`)
    const composer = new SessionPage(page)
    await expect(composer.getMessageInput()).toBeVisible({ timeout: 60_000 })

    const prompt = `Create and execute your own small Python project in ${project}. Use Bash and uv, not a prewritten test fixture. Create pyproject.toml with requires-python >=3.11 and exactly six==1.17.0, generate uv.lock, and create its .venv with the image's existing python3 (set UV_PYTHON_DOWNLOADS=never; do not download another interpreter). Write main.py yourself: import six, sqlite3, tomllib and zoneinfo; calculate 19+23 using SQLite, verify TOML parsing and America/New_York timezone data, and print exactly ${initialMarker} (with the computed answer and actual six version). Run it with uv run --frozen and save stdout to ${workspaceRoot}/agent-result.txt. Keep the project, lock and environment for a restart test. Do not access credentials, inspect environment variables, delegate, or create background tasks. After actual execution succeeds, reply exactly PROJECT_READY.`
    const sent = page.waitForResponse(response => response.url().endsWith(`${sessionRoute}/messages`) && response.request().method() === 'POST')
    await composer.sendMessage(prompt)
    receiptSchema.parse(await (await sent).json())
    await waitFor('agent-authored project and settled turn', async () => {
      const result = await readAgentFile(slug!, `${relativeRoot}/agent-result.txt`)
      const state = sessionStateSchema.parse(await json(sessionRoute!))
      return result?.trim() === initialMarker && !state.isActive
    })
    const initialMessages = messagesSchema.parse(await json(`${sessionRoute}/messages`))
    assert(!initialMessages.some(message => message.apiError), 'Model API error in initial transcript')
    const initialCalls = bashCalls(initialMessages)
    assert(initialCalls.some(call => call.isError === false && typeof call.input.command === 'string' && call.input.command.includes('uv')), 'Real agent must complete uv through Bash')
    const source = await readAgentFile(slug, `${relativeRoot}/agent-project/main.py`)
    const lock = await readAgentFile(slug, `${relativeRoot}/agent-project/uv.lock`)
    assert(source && lock, 'Agent project source and lock must exist')
    for (const module of ['six', 'sqlite3', 'tomllib', 'zoneinfo']) assert(source.includes(module), `Agent code must exercise ${module}`)
    await writeFile(path.join(options.output, 'agent-main.py'), source, { mode: 0o600 })
    await writeFile(path.join(options.output, 'agent-uv.lock'), lock, { mode: 0o600 })
    const pythonBefore = await projectPython(container)
    assert.equal(await docker('exec', '--user', 'claude', '--workdir', project, container, 'uv', 'run', '--offline', '--frozen', '--no-sync', 'python', 'main.py'), initialMarker)
    await page.screenshot({ path: path.join(options.output, 'project-ready.png'), fullPage: true })
    console.log('[runtime-smoke] Real agent authored and ran the Python/uv project; independently reproduced offline')

    // Use the host's lifecycle API: stop/start replaces the container rather
    // than merely restarting a process in its existing writable layer.
    await request(`/api/agents/${slug}/stop`, 'POST')
    await request(`/api/agents/${slug}/start`, 'POST')
    const after = await containerIdentity(container)
    assert.notEqual(after.id, before.id, 'Expected a fresh container')
    assert.equal(after.imageId, before.imageId, 'Restart must use the same tested image')
    tools.push(await fixture(container, 'restart'))
    const pythonAfter = await projectPython(container)
    assert.deepEqual(pythonAfter, pythonBefore, 'Container replacement must preserve the project interpreter')
    assert.equal(await docker('exec', '--user', 'claude', '--workdir', project, container, 'uv', 'run', '--offline', '--frozen', '--no-sync', 'python', 'main.py'), initialMarker)
    assert.equal(await readAgentFile(slug, `${relativeRoot}/agent-project/uv.lock`), lock, 'Restart must preserve the lockfile')

    const resumed = page.waitForResponse(response => response.url().endsWith(`${sessionRoute}/messages`) && response.request().method() === 'POST')
    await composer.sendMessage(`The container was replaced. In this same session, rerun your existing project with cd ${project} && uv run --offline --frozen --no-sync python main.py. Do not reinstall packages, recreate the environment, or modify the source/lock. Check its output is ${initialMarker}, then use Bash to write exactly ${resumeMarker} to ${workspaceRoot}/resumed-result.txt. Reply exactly RESTART_READY when done. Do not create background tasks.`)
    receiptSchema.parse(await (await resumed).json())
    await waitFor('resumed real-agent execution', async () => {
      const result = await readAgentFile(slug!, `${relativeRoot}/resumed-result.txt`)
      return result?.trim() === resumeMarker && !sessionStateSchema.parse(await json(sessionRoute!)).isActive
    })
    const afterMessages = messagesSchema.parse(await json(`${sessionRoute}/messages`))
    assert(!afterMessages.some(message => message.apiError), 'Model API error in resumed transcript')
    const seen = new Set(initialCalls.map(call => call.id))
    const resumedCalls = bashCalls(afterMessages).filter(call => !seen.has(call.id))
    assert(resumedCalls.some(call => call.isError === false && typeof call.input.command === 'string' && call.input.command.includes('uv')), 'Resumed real agent must complete the persisted project')
    assert.equal(await readAgentFile(slug, `${relativeRoot}/agent-project/main.py`), source, 'Resume must not modify source')
    assert.equal(await readAgentFile(slug, `${relativeRoot}/agent-project/uv.lock`), lock, 'Resume must not modify lock')
    await page.screenshot({ path: path.join(options.output, 'restart-ready.png'), fullPage: true })
    const pythonStreamCounts = z.record(z.string(), z.number().int().nonnegative()).parse(await page.evaluate(() => window.containerRuntimeProbeCounts))
    const artifact = await artifactScenario(slug, page, sessionRoutes)
    const transport = options.transport ? await runHttpTransport({
      base, slug, container, output: options.output, runId, page,
      appContainer: options.appContainer!, appImageId: options.appImageId!, agentImageId: options.agentImageId!,
    }) : undefined
    const streamEventCounts = z.record(z.string(), z.number().int().nonnegative()).parse(await page.evaluate(() => window.containerRuntimeProbeCounts))
    for (const [type, count] of Object.entries(pythonStreamCounts)) streamEventCounts[type] = (streamEventCounts[type] ?? 0) + count
    for (const type of Object.keys(streamEventCounts)) eventSchema.parse({ type })
    assert(Object.values(streamEventCounts).reduce((sum, count) => sum + count, 0) > 0, 'Browser must receive real session SSE events')

    completedProof = proofSchema.parse({
      status: 'passed', runId, gitCommit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
      baseUrl: base, model: options.model, providerId: options.providerId, agentSlug: slug, sessionId: session.id,
      before, after, expected: options.expected, tools,
      agentProject: {
        initialResult: initialMarker, resumedResult: resumeMarker,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        lockSha256: createHash('sha256').update(lock).digest('hex'),
        bashCallsBeforeRestart: initialCalls.filter(call => call.isError === false).length,
        bashCallsAfterRestart: resumedCalls.filter(call => call.isError === false).length,
        pythonBefore, pythonAfter,
      },
      artifact, transport, streamEventCounts, durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    await page?.screenshot({ path: path.join(options.output, 'failure.png'), fullPage: true }).catch(() => {})
    executionError = error
  }
  // Every cleanup operation is independent: a browser close failure must not
  // strand a live agent, and failed app cleanup must never produce PASS proof.
  const cleanupErrors: string[] = []
  for (const route of sessionRoutes) await request(`${route}/interrupt`, 'POST', { scope: 'all' }).catch(() => {})
  try { await browser?.close() }
  catch { cleanupErrors.push('Browser close failed') }
  if (slug) {
    try { await request(`/api/agents/${slug}`, 'DELETE') }
    catch {
      cleanupErrors.push(`App could not delete test agent ${slug}`)
      if (container) {
        try { await docker('rm', '-f', container) }
        catch { cleanupErrors.push(`Fallback could not remove test container ${container}`) }
      }
    }
  }
  if (executionError || cleanupErrors.length) {
    const message = executionError instanceof Error ? executionError.message : executionError ? 'Validation failed' : ''
    throw new Error([message, ...cleanupErrors].filter(Boolean).join('; '))
  }
  assert(completedProof, 'Validation did not produce proof')
  const proof = proofSchema.parse({ ...completedProof, durationMs: Date.now() - startedAt })
  await writeFile(path.join(options.output, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
  console.log(`[runtime-smoke] PASS: ${proof.tools.reduce((sum, item) => sum + item.checks.length, 0)} deterministic checks${proof.transport ? `, ${proof.transport.checks.length} HTTP transport checks` : ''}, real-agent Python project/resume, Bun dashboard/widget, cleanup; evidence ${options.output}`)
}

main().catch(error => {
  console.error(`[runtime-smoke] ${error instanceof Error ? error.message : 'Validation failed'}`)
  process.exitCode = 1
})

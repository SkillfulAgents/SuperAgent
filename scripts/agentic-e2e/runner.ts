#!/usr/bin/env tsx
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runTest, type TestResult, type DriverOptions } from './claude-code-driver'
import { ensureKeys, ensureGitHub } from './setup'
import { launchElectron, killElectron, rebuildForElectron, rebuildForNode } from './setup/launch-electron'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadEnvFile() {
  const envPath = resolve(__dirname, '.env.local')
  if (!existsSync(envPath)) return
  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
  console.log(`[setup] Loaded env from ${envPath}`)
}

loadEnvFile()

interface TestCase {
  id: string
  name: string
  /** Feature file names from steps/ directory (e.g. "agent-create", "session-chat"). Exploration mode ignores this. */
  steps?: string[]
  tags?: string[]
  /** Setup modules to run before the test (e.g. "ensureKeys"). API keys are pre-injected — the QA agent does NOT need to configure them. */
  setup?: string[]
  teardown?: string[]
}

interface TestSuiteResult {
  startedAt: string
  finishedAt: string
  totalDurationMs: number
  total: number
  passed: number
  failed: number
  results: Array<{
    testCase: TestCase
    result: TestResult
  }>
}

type TestTarget = 'web' | 'electron'

function parseArgs() {
  const args = process.argv.slice(2)
  let filter: string | undefined
  let tag: string | undefined
  let verbose = false
  let maxRetries = 1
  let baseUrl = 'http://localhost:47892'
  let target: TestTarget = 'web'

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--filter':
        filter = args[++i]
        break
      case '--tag':
        tag = args[++i]
        break
      case '--verbose':
        verbose = true
        break
      case '--retries':
        maxRetries = parseInt(args[++i], 10) || 1
        break
      case '--base-url':
        baseUrl = args[++i]
        break
      case '--target':
        target = args[++i] as TestTarget
        if (target !== 'web' && target !== 'electron') {
          console.error(`Invalid target: ${target}. Must be "web" or "electron".`)
          process.exit(1)
        }
        break
    }
  }

  return { filter, tag, verbose, maxRetries, baseUrl, target }
}

async function loadStepFiles(steps: string[]): Promise<string> {
  const parts: string[] = []
  for (const name of steps) {
    const filePath = resolve(__dirname, 'steps', `${name}.md`)
    try {
      const content = await readFile(filePath, 'utf-8')
      parts.push(content.trim())
    } catch {
      console.warn(`  [warn] Step file not found: ${filePath}, skipping`)
    }
  }
  return parts.join('\n\n---\n\n')
}

async function loadTestCases(filterStr?: string, tagStr?: string): Promise<TestCase[]> {
  const raw = await readFile(resolve(__dirname, 'test-cases.json'), 'utf-8')
  let cases: TestCase[] = JSON.parse(raw)

  if (filterStr) {
    const pattern = filterStr.toLowerCase()
    cases = cases.filter(
      (c) => c.id.toLowerCase().includes(pattern) || c.name.toLowerCase().includes(pattern),
    )
  }

  if (tagStr) {
    cases = cases.filter((c) => c.tags?.includes(tagStr))
  }

  return cases
}

async function loadAllStepsAsReference(): Promise<string> {
  const stepsDir = resolve(__dirname, 'steps')
  const files = (await readdir(stepsDir)).filter((f) => f.endsWith('.md')).sort()
  const parts: string[] = []
  for (const file of files) {
    const content = await readFile(resolve(stepsDir, file), 'utf-8')
    parts.push(`### ${file.replace('.md', '')}\n\n${content.trim()}`)
  }
  return parts.join('\n\n---\n\n')
}

async function buildExplorationPrompt(baseUrl: string): Promise<string> {
  const reference = await loadAllStepsAsReference()
  return `You are an exploration QA tester for a web application called SuperAgent at ${baseUrl}.

Your goal: **find bugs**. Explore the app freely, try unexpected flows, edge cases, rapid actions, weird inputs, and anything that might break things.

## Rules
- Navigate to ${baseUrl} first.
- You are NOT required to follow any specific order. Do whatever you think is most likely to surface bugs.
- Try things like: creating agents with empty/special-character names, sending messages before agent is ready, clicking buttons rapidly, navigating away mid-operation, opening settings and changing things while agent is working, etc.
- After each interesting action, take a screenshot.
- If you find a bug (error message, crash, unexpected behavior, UI glitch, broken state), document it immediately.
- Keep going until you've explored thoroughly or hit a dead end.

## Reference: Known UI Actions
Below is a reference of all known features and actions. Use these as inspiration, NOT as a checklist.

${reference}

## Output
Report ALL bugs found. Your response MUST end with a JSON block:

\`\`\`json
{
  "passed": true or false,
  "reason": "Summary of exploration and findings",
  "bugs": ["Bug 1: description", "Bug 2: description"],
  "steps": ["What you did, in order"]
}
\`\`\`

Set "passed" to false if you found any bugs, true if the app survived your exploration.`
}

async function buildPrompt(tc: TestCase, baseUrl: string, target: TestTarget): Promise<string> {
  if (tc.id === 'exploration') {
    return buildExplorationPrompt(baseUrl)
  }

  if (!tc.steps || tc.steps.length === 0) {
    throw new Error(`Test case "${tc.id}" has no steps defined`)
  }

  const isElectron = target === 'electron'
  const features = await loadStepFiles(tc.steps)
  const appDescription = isElectron
    ? `a desktop Electron app called SuperAgent (API at ${baseUrl})`
    : `a web app called SuperAgent at ${baseUrl}`
  const navigationStep = isElectron
    ? `1. The Electron app is already open in front of you — do NOT navigate to a URL. Just take a screenshot to see the current state. Dismiss the Getting Started Wizard if it appears.`
    : `1. Navigate to ${baseUrl}. Dismiss the Getting Started Wizard if it appears.`

  return `You are a senior QA engineer testing ${appDescription}.

## Your Mission

Thoroughly test every feature in the areas described below. The feature descriptions are **hints and references** — they tell you what exists and roughly how to find it, but they are NOT a rigid script. You should:

- Use the feature hints as a starting point, then **explore beyond them**. Click around, try edge cases, test error states, verify visual feedback, and cover anything else you notice.
- Think like a real user: what would they try? What could go wrong? What happens with empty inputs, special characters, rapid clicks, or unexpected navigation?
- Test the **complete surface area** of each feature — not just the happy path. If a feature has a form, test validation. If there's a list, test empty/one/many states. If something can be added, test adding AND removing.
- If you discover features or UI elements not mentioned in the hints, test those too.

## How to Work

${navigationStep}
2. For each feature area below, read the hints to understand what's available, then test comprehensively.
   - Take a screenshot after each key action.
   - When you find unexpected behavior — that's a **bug**. Screenshot it, document what happened vs what you expected, then keep going.
   - If something is blocked (e.g. agent not running), try to unblock it yourself. Only skip as a last resort, and note exactly why.
3. After testing everything, compile your findings.

## Feature Hints

The following sections describe the features you should focus on. Treat these as a map of what to test, not a step-by-step script.

${features}

## Bug Reporting

For each bug, record:
- **What you did** (action)
- **What you expected** (expected result)
- **What actually happened** (actual result)

## Final Output

After testing, you MUST end your response with this exact JSON format:

\`\`\`json
{
  "passed": true or false,
  "reason": "Summary of what was tested and any bugs found",
  "bugs": ["Bug 1: description", "Bug 2: description"],
  "steps": ["Step 1: what you did", "Step 2: what you did"]
}
\`\`\`

Set "passed" to false if you found any bugs.`
}

/**
 * Generate a temporary MCP config that tells @playwright/mcp to connect
 * to an existing browser via CDP instead of launching a new one.
 */
async function writeCdpMcpConfig(cdpEndpoint: string): Promise<string> {
  const config = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['@playwright/mcp@latest', '--cdp-endpoint', cdpEndpoint],
      },
    },
  }
  const tmpPath = resolve(tmpdir(), `playwright-mcp-cdp-${randomUUID()}.json`)
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8')
  return tmpPath
}

async function runSetupModule(mod: string, baseUrl: string): Promise<void> {
  console.log(`  [setup] Running ${mod}...`)
  switch (mod) {
    case 'ensureKeys':
      await ensureKeys(baseUrl)
      break
    case 'ensureGitHub':
      await ensureGitHub(baseUrl)
      break
    default:
      console.warn(`  [setup] Unknown module: ${mod}`)
  }
}

async function main() {
  let { filter, tag, verbose, maxRetries, baseUrl, target } = parseArgs()

  console.log('=== SuperAgent Agentic E2E Test Runner ===\n')
  console.log(`Target: ${target}`)
  console.log(`Base URL: ${baseUrl}`)
  console.log(`Max retries: ${maxRetries}`)
  console.log(`Verbose: ${verbose}\n`)

  if (target === 'electron') {
    rebuildForElectron()
  } else {
    rebuildForNode()
  }

  let mcpConfigPath: string | undefined

  if (target === 'electron') {
    console.log('[electron] Launching Electron app...')
    const { cdpEndpoint, apiPort } = await launchElectron()
    mcpConfigPath = await writeCdpMcpConfig(cdpEndpoint)
    baseUrl = `http://localhost:${apiPort}`
    console.log(`[electron] MCP config written: ${mcpConfigPath}`)
    console.log(`[electron] CDP endpoint: ${cdpEndpoint}`)
    console.log(`[electron] Base URL overridden to: ${baseUrl}\n`)
  }

  const testCases = await loadTestCases(filter, tag)

  if (testCases.length === 0) {
    console.log('No test cases match the given filters.')
    process.exit(0)
  }

  console.log(`Found ${testCases.length} test case(s):\n`)
  for (const tc of testCases) {
    console.log(`  - [${tc.id}] ${tc.name}`)
  }
  console.log()

  const resultsDir = resolve(__dirname, 'results')
  await mkdir(resultsDir, { recursive: true })

  const suiteStart = Date.now()
  const results: TestSuiteResult['results'] = []

  for (const tc of testCases) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`> Running: [${tc.id}] ${tc.name}`)
    console.log(`${'─'.repeat(60)}\n`)

    if (tc.setup && tc.setup.length > 0) {
      console.log(`[setup] ${tc.setup.join(', ')}`)
      try {
        for (const mod of tc.setup) await runSetupModule(mod, baseUrl)
      } catch (err) {
        const reason = `Setup failed: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[setup] ${reason}`)
        results.push({
          testCase: tc,
          result: { passed: false, reason, steps: [], rawOutput: '', durationMs: 0 },
        })
        continue
      }
    }

    let prompt: string
    try {
      prompt = await buildPrompt(tc, baseUrl, target)
    } catch (err) {
      const reason = `Prompt build failed: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[prompt] ${reason}`)
      results.push({
        testCase: tc,
        result: { passed: false, reason, steps: [], rawOutput: '', durationMs: 0 },
      })
      continue
    }

    if (verbose) {
      console.log('[prompt] Built prompt:')
      console.log(prompt.slice(0, 800) + (prompt.length > 800 ? '...(truncated)' : ''))
      console.log()
    }

    const driverOptions: DriverOptions = {
      verbose,
      mcpConfigPath,
    }

    let lastResult: TestResult | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) {
        console.log(`\n  Retry ${attempt}/${maxRetries}...\n`)
      }

      try {
        lastResult = await runTest(prompt, driverOptions)
      } catch (err) {
        lastResult = {
          passed: false,
          reason: `Runner error: ${err instanceof Error ? err.message : String(err)}`,
          steps: [],
          rawOutput: '',
          durationMs: 0,
        }
      }

      if (lastResult.passed) break
    }

    const finalResult = lastResult!
    results.push({ testCase: tc, result: finalResult })

    const status = finalResult.passed ? 'PASSED' : 'FAILED'
    console.log(`\n[${status}] [${tc.id}] ${tc.name}`)
    console.log(`   Reason: ${finalResult.reason}`)
    console.log(`   Duration: ${(finalResult.durationMs / 1000).toFixed(1)}s`)

    if (finalResult.steps.length > 0) {
      console.log('   Steps:')
      for (const step of finalResult.steps) {
        console.log(`     - ${step}`)
      }
    }

    const outputPath = resolve(resultsDir, `${tc.id}.txt`)
    await writeFile(outputPath, finalResult.rawOutput, 'utf-8')

    if (tc.teardown && tc.teardown.length > 0) {
      console.log(`[teardown] ${tc.teardown.join(', ')}`)
      try {
        for (const mod of tc.teardown) await runSetupModule(mod, baseUrl)
      } catch (err) {
        console.warn(`[teardown] Warning: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const suiteEnd = Date.now()
  const totalDurationMs = suiteEnd - suiteStart

  const summary: TestSuiteResult = {
    startedAt: new Date(suiteStart).toISOString(),
    finishedAt: new Date(suiteEnd).toISOString(),
    totalDurationMs,
    total: results.length,
    passed: results.filter((r) => r.result.passed).length,
    failed: results.filter((r) => !r.result.passed).length,
    results: results.map(({ testCase, result }) => ({
      testCase,
      result: {
        passed: result.passed,
        reason: result.reason,
        steps: result.steps,
        rawOutput: '[see results/<id>.txt]',
        durationMs: result.durationMs,
      },
    })),
  }

  const summaryPath = resolve(resultsDir, 'summary.json')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')

  console.log(`\n${'═'.repeat(60)}`)
  console.log('SUMMARY')
  console.log(`${'═'.repeat(60)}`)
  console.log(`Total:    ${summary.total}`)
  console.log(`Passed:   ${summary.passed}`)
  console.log(`Failed:   ${summary.failed}`)
  console.log(`Duration: ${(totalDurationMs / 1000).toFixed(1)}s`)
  console.log(`Results:  ${summaryPath}`)
  console.log(`${'═'.repeat(60)}\n`)

  if (target === 'electron') {
    killElectron()
    if (mcpConfigPath) {
      const { unlink } = await import('node:fs/promises')
      await unlink(mcpConfigPath).catch(() => {})
    }
  }

  process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  killElectron()
  process.exit(2)
})

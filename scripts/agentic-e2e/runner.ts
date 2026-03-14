#!/usr/bin/env tsx
import { readFile, mkdir, writeFile, readdir, copyFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runTest, type TestResult, type DriverOptions } from './claude-code-driver'
import { ensureSecrets, ensureOAuth, ensureAgent, deleteAgent } from './setup'
import { launchElectron, killElectron, rebuildForElectron, rebuildForNode } from './setup/launch-electron'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestCase {
  id: string
  name: string
  /** Feature files to test independently (e.g. "session-chat", "agent-settings"). */
  features?: string[]
  tags?: string[]
  /** Programmatic setup modules (e.g. "ensureSecrets", "ensureAgent"). */
  setup?: string[]
  teardown?: string[]
}

interface FeatureResult {
  feature: string
  result: TestResult
}

interface TestCaseResult {
  testCase: TestCase
  agentName: string
  featureResults: FeatureResult[]
  overallPassed: boolean
}

interface TestSuiteResult {
  startedAt: string
  finishedAt: string
  totalDurationMs: number
  totalTestCases: number
  passedTestCases: number
  failedTestCases: number
  totalFeatures: number
  passedFeatures: number
  failedFeatures: number
  results: TestCaseResult[]
}

type TestTarget = 'web' | 'electron'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2)
  let filter: string | undefined
  let tag: string | undefined
  let verbose = false
  let maxRetries = 1
  let baseUrl = 'http://localhost:47891'
  let target: TestTarget = 'web'
  let exploration = false
  let model: string | undefined

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
      case '--exploration':
        exploration = true
        break
      case '--model':
        model = args[++i]
        break
    }
  }

  return { filter, tag, verbose, maxRetries, baseUrl, target, exploration, model }
}

// ---------------------------------------------------------------------------
// Agent name generation
// ---------------------------------------------------------------------------

function generateAgentName(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hour = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  return `QA-${now.getFullYear()}${month}${day}-${hour}${min}`
}

// ---------------------------------------------------------------------------
// Feature file loading
// ---------------------------------------------------------------------------

async function loadFeatureFile(name: string): Promise<string> {
  const filePath = resolve(__dirname, 'features', `${name}.md`)
  try {
    return (await readFile(filePath, 'utf-8')).trim()
  } catch {
    throw new Error(`Feature file not found: ${filePath}`)
  }
}

async function loadAllFeaturesAsReference(): Promise<string> {
  const featuresDir = resolve(__dirname, 'features')
  const files = (await readdir(featuresDir)).filter((f) => f.endsWith('.md')).sort()
  const parts: string[] = []
  for (const file of files) {
    const content = await readFile(resolve(featuresDir, file), 'utf-8')
    parts.push(`### ${file.replace('.md', '')}\n\n${content.trim()}`)
  }
  return parts.join('\n\n---\n\n')
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const OUTPUT_INSTRUCTIONS = `
## Final Output

After testing, end your response with a structured report. The very first line of your report MUST be one of:

[TEST_PASS]
[TEST_FAIL]

Then continue with:

[REASON] One-line summary of what was tested
[BUG_FOUND] Description of bug 1
[BUG_FOUND] Description of bug 2
[STEP] What you did first — result
[STEP] What you did next — result

Use [TEST_FAIL] if you found any bugs. Each marker must be on its own line. Do NOT reference screenshot filenames you invented — only reference what you actually see on screen.`

async function buildFeaturePrompt(opts: {
  featureName: string
  agentName: string
  baseUrl: string
  target: TestTarget
  exploration?: boolean
}): Promise<string> {
  const { featureName, agentName, baseUrl, target, exploration } = opts
  const featureContent = await loadFeatureFile(featureName)
  const isElectron = target === 'electron'

  const appDescription = isElectron
    ? `a desktop Electron app called SuperAgent (API at ${baseUrl})`
    : `a web app called SuperAgent at ${baseUrl}`

  const navigationInstruction = isElectron
    ? `The Electron app is already open. Take a screenshot to see the current state. Dismiss the Getting Started Wizard if it appears.`
    : `Navigate to ${baseUrl}. Dismiss the Getting Started Wizard if it appears.`

  const agentContext = agentName
    ? `\n## Context\n\nAn agent named **"${agentName}"** has already been created and started.\nYou do NOT need to create a new agent. Find this agent in the sidebar and click on it.\nIf the agent is sleeping, start it and wait for it to become idle before proceeding.\n`
    : ''

  const taskInstructions = exploration
    ? `Then test the following feature area. The description below tells you what exists and roughly how to find it — treat it as a loose guide, not a script.

You should be **thorough and curious**. Don't just verify the basics — actively look for things that seem off, try variations the description doesn't mention, follow tangents if something catches your eye, and generally spend more time poking around than you normally would. The goal is to find anything interesting, not just confirm the happy path works.

- Take a screenshot after each key action.
- If you find unexpected behavior, document it as a bug and keep going.
- When you've covered the described steps, keep exploring — try different inputs, different sequences, different states. Use your judgment on what's worth investigating.`
    : `Then test the following feature area thoroughly. The description below is a **hint and reference** — it tells you what exists and roughly how to find it, but it is NOT a rigid script. You should:

- Use the hints as a starting point, then **explore beyond them**.
- Think like a real user: what would they try? What could go wrong?
- Test the **complete surface area** — not just the happy path.
- Take a screenshot after each key action.
- If you find unexpected behavior, document it as a bug and keep going.`

  return `You are a senior QA engineer testing ${appDescription}.
${agentContext}
## Task

${navigationInstruction}

${taskInstructions}

### Feature: ${featureName}

${featureContent}

## Bug Reporting

For each bug, record:
- **What you did** (action)
- **What you expected** (expected result)
- **What actually happened** (actual result)
${OUTPUT_INSTRUCTIONS}`
}

const CHAOS_OUTPUT_INSTRUCTIONS = `
## Output

As soon as you find a bug, **take a screenshot first**, then STOP and output a report. The very first line MUST be one of:

[BUG_FOUND] Short description of the bug
[NO_BUG_FOUND]

If you found a bug, continue with:

[ACTION] What you did
[EXPECTED] What you expected
[ACTUAL] What actually happened
[STEP] What you did first — result
[STEP] What you did next — result

**CRITICAL: The first line of your output MUST start with [BUG_FOUND] or [NO_BUG_FOUND]. This is how the runner detects your findings.**`

async function buildExplorationPrompt(baseUrl: string): Promise<string> {
  const reference = await loadAllFeaturesAsReference()
  return `You are an exploration QA tester for a web application called SuperAgent at ${baseUrl}.

Your goal: **find one bug**. Explore the app freely — try unexpected flows, edge cases, weird inputs, anything that might break things. As soon as you find a bug, stop and report it.

## Rules
- Navigate to ${baseUrl} first.
- You are NOT required to follow any specific order. Do whatever you think is most likely to surface bugs.
- Try things like: creating agents with empty/special-character names, sending messages before agent is ready, clicking buttons rapidly, navigating away mid-operation, opening settings and changing things while agent is working, etc.
- After each interesting action, take a screenshot.
- As soon as you find a bug (error message, crash, unexpected behavior, UI glitch, broken state), **take a screenshot first**, then STOP and output your JSON.

## Reference: Known UI Actions
Below is a reference of all known features and actions. Use these as inspiration, NOT as a checklist.

${reference}
${CHAOS_OUTPUT_INSTRUCTIONS}`
}

// ---------------------------------------------------------------------------
// Screenshot collection
// ---------------------------------------------------------------------------

const PLAYWRIGHT_MCP_DIR = resolve(__dirname, '../../.playwright-mcp')

async function collectScreenshots(sinceMs: number, destDir: string): Promise<string[]> {
  let files: string[]
  try {
    files = await readdir(PLAYWRIGHT_MCP_DIR)
  } catch {
    return []
  }

  const pngs = files
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      // filename: page-2026-03-13T20-21-28-927Z.png → 2026-03-13T20:21:28.927Z
      const tsMatch = f.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/)
      const ts = tsMatch
        ? new Date(`${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}.${tsMatch[7]}Z`).getTime()
        : 0
      return { name: f, ts }
    })
    .filter((f) => f.ts >= sinceMs)
    .sort((a, b) => b.ts - a.ts)

  if (pngs.length === 0) return []

  await mkdir(destDir, { recursive: true })

  const copied: string[] = []
  for (let i = 0; i < pngs.length; i++) {
    const destName = `${i + 1}.png`
    await copyFile(resolve(PLAYWRIGHT_MCP_DIR, pngs[i].name), resolve(destDir, destName))
    copied.push(destName)
  }
  return copied
}

// ---------------------------------------------------------------------------
// Electron CDP config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Setup modules
// ---------------------------------------------------------------------------

interface SetupContext {
  agentName: string
  agentSlug: string | null
}

async function runSetupModule(mod: string, baseUrl: string, ctx: SetupContext): Promise<void> {
  console.log(`  [setup] Running ${mod}...`)
  switch (mod) {
    case 'ensureSecrets':
      await ensureSecrets(baseUrl)
      break
    case 'ensureOAuth':
      await ensureOAuth(baseUrl)
      break
    case 'ensureAgent':
      ctx.agentSlug = await ensureAgent(baseUrl, ctx.agentName)
      break
    default:
      console.warn(`  [setup] Unknown module: ${mod}`)
  }
}

// ---------------------------------------------------------------------------
// Run a single feature with retries
// ---------------------------------------------------------------------------

async function runFeatureWithRetries(
  prompt: string,
  driverOptions: DriverOptions,
  maxRetries: number,
): Promise<TestResult> {
  let lastResult: TestResult | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(`    Retry ${attempt}/${maxRetries}...`)
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

  return lastResult!
}

// ---------------------------------------------------------------------------
// Print a single feature result
// ---------------------------------------------------------------------------

function printFeatureResult(feature: string, result: TestResult) {
  const status = result.passed ? 'PASSED' : 'FAILED'
  console.log(`  [${status}] ${feature} (${(result.durationMs / 1000).toFixed(1)}s)`)
  if (!result.passed) {
    console.log(`    Reason: ${result.reason}`)
  }
  if (result.steps.length > 0) {
    for (const step of result.steps) {
      console.log(`    - ${step}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let { filter, tag, verbose, maxRetries, baseUrl, target, exploration, model } = parseArgs()

  console.log('=== SuperAgent Agentic E2E Test Runner ===\n')
  console.log(`Target: ${target}`)
  console.log(`Base URL: ${baseUrl}`)
  console.log(`Max retries: ${maxRetries}`)
  console.log(`Verbose: ${verbose}`)
  console.log(`Exploration: ${exploration}\n`)

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
  const allResults: TestCaseResult[] = []

  for (const tc of testCases) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`> [${tc.id}] ${tc.name}`)
    console.log(`${'─'.repeat(60)}`)

    const agentName = generateAgentName()
    const needsAgent = tc.setup?.includes('ensureAgent') ?? false
    const ctx: SetupContext = { agentName, agentSlug: null }

    // --- Programmatic setup ---
    if (tc.setup && tc.setup.length > 0) {
      console.log(`\n[setup] ${tc.setup.join(', ')}`)
      if (needsAgent) {
        console.log(`[agent] Name: ${agentName}`)
      }
      try {
        for (const mod of tc.setup) await runSetupModule(mod, baseUrl, ctx)
      } catch (err) {
        const reason = `Setup failed: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[setup] ${reason}`)
        allResults.push({
          testCase: tc,
          agentName: needsAgent ? agentName : '',
          featureResults: [],
          overallPassed: false,
        })
        continue
      }
    }

    const driverOptions: DriverOptions = { verbose, mcpConfigPath, model }

    // --- Chaos monkey mode: find one bug per round, resume with context ---
    if (tc.id === 'chaos-monkey') {
      const MAX_ROUNDS = 100
      const bugsFound: string[] = []
      const chaosResults: FeatureResult[] = []
      const sessionId = randomUUID()

      console.log(`\n> Unleashing the chaos monkey (max ${MAX_ROUNDS} rounds, one bug per round)...`)
      console.log(`[chaos-monkey] Session: ${sessionId}`)

      const initialPrompt = await buildExplorationPrompt(baseUrl)

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        console.log(`\n> [chaos-monkey] Round ${round}/${MAX_ROUNDS}...`)
        const roundStartMs = Date.now()

        const isFirstRound = round === 1
        let prompt: string
        if (isFirstRound) {
          prompt = initialPrompt
        } else {
          const bugList = bugsFound.map((b, i) => `${i + 1}. ${b}`).join('\n')
          prompt = `Good, you found ${bugsFound.length} bug(s) so far:\n${bugList}\n\nKeep going — explore areas you haven't touched yet and find the next bug. Avoid re-testing bugs you already found. As soon as you find a new bug, STOP and output your JSON with the \`"bug"\` field set to a description string. If you can't find any more bugs, set \`"bug": null\`.`
        }

        if (verbose) {
          console.log('[prompt] ' + prompt.slice(0, 600) + (prompt.length > 600 ? '...(truncated)\n' : '\n'))
        }

        let result: TestResult
        try {
          result = await runTest(prompt, {
            ...driverOptions,
            sessionId: isFirstRound ? sessionId : undefined,
            resumeSessionId: isFirstRound ? undefined : sessionId,
          })
        } catch (err) {
          console.warn(`[chaos-monkey] Round ${round} error: ${err instanceof Error ? err.message : String(err)}`)
          break
        }

        const roundDir = resolve(resultsDir, `${tc.id}--round-${round}`)
        await mkdir(roundDir, { recursive: true })
        await writeFile(resolve(roundDir, 'report.md'), result.rawOutput, 'utf-8')

        const screenshots = await collectScreenshots(roundStartMs, roundDir)
        if (screenshots.length > 0) {
          console.log(`  [screenshots] ${screenshots.length} saved to ${tc.id}--round-${round}/`)
        }

        // Extract bug from output using [BUG_FOUND] / [NO_BUG_FOUND] markers
        const bugMatch = result.rawOutput.match(/^\[BUG_FOUND\]\s*(.+)$/m)
        const noBugMatch = result.rawOutput.match(/^\[NO_BUG_FOUND\]/m)
        const bugDesc = bugMatch ? bugMatch[1].trim() : null

        if (!bugMatch && !noBugMatch) {
          console.log(`  [WARN] Agent returned no [BUG_FOUND] or [NO_BUG_FOUND] marker, continuing...`)
          chaosResults.push({ feature: `round-${round}`, result })
          continue
        }

        if (bugDesc) {
          bugsFound.push(bugDesc)
          console.log(`  [BUG #${bugsFound.length}] ${bugDesc}`)
        } else {
          console.log(`  [NO BUG] Agent found no new bugs this round.`)
        }

        chaosResults.push({ feature: `round-${round}`, result })

        if (!bugDesc) {
          console.log(`[chaos-monkey] No more bugs found, stopping.`)
          break
        }
      }

      console.log(`\n[chaos-monkey] Total bugs found: ${bugsFound.length}`)
      for (let i = 0; i < bugsFound.length; i++) {
        console.log(`  ${i + 1}. ${bugsFound[i]}`)
      }

      const overallPassed = bugsFound.length === 0
      allResults.push({
        testCase: tc,
        agentName: '',
        featureResults: chaosResults,
        overallPassed,
      })
      continue
    }

    // --- Run features independently ---
    const featureResults: FeatureResult[] = []
    const features = tc.features ?? []

    for (const feat of features) {
      console.log(`\n> Running feature: ${feat}...`)
      const featureStartMs = Date.now()
      const prompt = await buildFeaturePrompt({
        featureName: feat,
        agentName: needsAgent ? agentName : '',
        baseUrl,
        target,
        exploration,
      })
      if (verbose) {
        console.log('[prompt] ' + prompt.slice(0, 600) + '...(truncated)\n')
      }
      const result = await runFeatureWithRetries(prompt, driverOptions, maxRetries)
      featureResults.push({ feature: feat, result })

      const featDir = resolve(resultsDir, `${tc.id}--${feat}`)
      await mkdir(featDir, { recursive: true })
      await writeFile(resolve(featDir, 'report.md'), result.rawOutput, 'utf-8')

      const screenshots = await collectScreenshots(featureStartMs, featDir)
      if (screenshots.length > 0) {
        console.log(`  [screenshots] ${screenshots.length} saved to ${tc.id}--${feat}/`)
      }

      printFeatureResult(feat, result)
    }

    const overallPassed = featureResults.length > 0 && featureResults.every((fr) => fr.result.passed)
    allResults.push({
      testCase: tc,
      agentName: needsAgent ? agentName : '',
      featureResults,
      overallPassed,
    })

    // --- Auto-teardown: delete agent created by ensureAgent ---
    if (ctx.agentSlug) {
      console.log(`\n[teardown] Deleting agent ${ctx.agentSlug}...`)
      try {
        await deleteAgent(baseUrl, ctx.agentSlug)
      } catch (err) {
        console.warn(`[teardown] Warning: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // --- Manual teardown modules ---
    if (tc.teardown && tc.teardown.length > 0) {
      console.log(`[teardown] ${tc.teardown.join(', ')}`)
      try {
        for (const mod of tc.teardown) await runSetupModule(mod, baseUrl, ctx)
      } catch (err) {
        console.warn(`[teardown] Warning: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const suiteEnd = Date.now()
  const totalDurationMs = suiteEnd - suiteStart

  const allFeatureResults = allResults.flatMap((r) => r.featureResults)
  const summary: TestSuiteResult = {
    startedAt: new Date(suiteStart).toISOString(),
    finishedAt: new Date(suiteEnd).toISOString(),
    totalDurationMs,
    totalTestCases: allResults.length,
    passedTestCases: allResults.filter((r) => r.overallPassed).length,
    failedTestCases: allResults.filter((r) => !r.overallPassed).length,
    totalFeatures: allFeatureResults.length,
    passedFeatures: allFeatureResults.filter((fr) => fr.result.passed).length,
    failedFeatures: allFeatureResults.filter((fr) => !fr.result.passed).length,
    results: allResults.map((r) => ({
      ...r,
      featureResults: r.featureResults.map((fr) => ({
        ...fr,
        result: {
          ...fr.result,
          rawOutput: `[see results/${r.testCase.id}--${fr.feature}/report.md]`,
        },
      })),
    })),
  }

  const summaryPath = resolve(resultsDir, 'summary.json')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')

  console.log(`\n${'═'.repeat(60)}`)
  console.log('SUMMARY')
  console.log(`${'═'.repeat(60)}`)

  for (const tcResult of allResults) {
    const tcStatus = tcResult.overallPassed ? 'PASSED' : 'FAILED'
    console.log(`\n  [${tcStatus}] ${tcResult.testCase.id}${tcResult.agentName ? ` (agent: ${tcResult.agentName})` : ''}`)
    for (const fr of tcResult.featureResults) {
      const frStatus = fr.result.passed ? 'PASSED' : 'FAILED'
      console.log(`    ${frStatus}  ${fr.feature} (${(fr.result.durationMs / 1000).toFixed(1)}s)`)
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Test cases: ${summary.passedTestCases}/${summary.totalTestCases} passed`)
  console.log(`Features:   ${summary.passedFeatures}/${summary.totalFeatures} passed`)
  console.log(`Duration:   ${(totalDurationMs / 1000).toFixed(1)}s`)
  console.log(`Results:    ${summaryPath}`)
  console.log(`${'═'.repeat(60)}\n`)

  if (target === 'electron') {
    killElectron()
    if (mcpConfigPath) {
      const { unlink } = await import('node:fs/promises')
      await unlink(mcpConfigPath).catch(() => {})
    }
  }

  process.exit(summary.failedTestCases > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  killElectron()
  process.exit(2)
})

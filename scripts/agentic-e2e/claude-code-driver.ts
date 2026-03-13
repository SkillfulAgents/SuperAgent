import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface TestResult {
  passed: boolean
  reason: string
  steps: string[]
  rawOutput: string
  durationMs: number
}

export interface DriverOptions {
  systemPrompt?: string
  mcpConfigPath?: string
  model?: string
  verbose?: boolean
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MODEL = 'sonnet'
const DEFAULT_MAX_BUDGET_USD = 100

async function loadSystemPrompt(): Promise<string> {
  const uiDetails = await readFile(resolve(__dirname, 'UI-details.md'), 'utf-8')
  const prompt = await readFile(resolve(__dirname, 'system-prompt.md'), 'utf-8')
  return `${prompt}\n\n---\n\n## UI Reference\n\n${uiDetails}`
}

function extractResult(parsed: Record<string, unknown>): Pick<TestResult, 'passed' | 'reason' | 'steps'> {
  let reason = String(parsed.reason || '')
  const bugs = Array.isArray(parsed.bugs) ? parsed.bugs.map(String) : []
  if (bugs.length > 0) {
    reason += `\n  Bugs found:\n${bugs.map((b) => `    - ${b}`).join('\n')}`
  }
  return {
    passed: Boolean(parsed.passed),
    reason,
    steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : [],
  }
}

function parseTestResult(output: string): Pick<TestResult, 'passed' | 'reason' | 'steps'> {
  const jsonMatch = output.match(/```json\s*\n([\s\S]*?)\n\s*```/)
  if (jsonMatch) {
    try { return extractResult(JSON.parse(jsonMatch[1])) } catch { /* fall through */ }
  }

  const bareJsonMatch = output.match(/\{[\s\S]*"passed"\s*:\s*(true|false)[\s\S]*\}/)
  if (bareJsonMatch) {
    try { return extractResult(JSON.parse(bareJsonMatch[0])) } catch { /* fall through */ }
  }

  return {
    passed: false,
    reason: 'Could not parse test result JSON from agent output',
    steps: [],
  }
}

export async function runTest(
  testPrompt: string,
  options: DriverOptions = {},
): Promise<TestResult> {
  const {
    model = DEFAULT_MODEL,
    verbose = false,
  } = options
  const timeoutMs = DEFAULT_TIMEOUT_MS
  const maxBudgetUsd = DEFAULT_MAX_BUDGET_USD

  const systemPrompt = options.systemPrompt ?? (await loadSystemPrompt())
  const mcpConfigPath = options.mcpConfigPath ?? resolve(__dirname, 'playwright-mcp-config.json')

  const startTime = Date.now()

  const systemPromptFile = resolve(tmpdir(), `qa-agent-system-${randomUUID()}.md`)
  await writeFile(systemPromptFile, systemPrompt, 'utf-8')

  const args: string[] = [
    '-p', testPrompt,
    '--output-format', 'text',
    '--model', model,
    '--mcp-config', mcpConfigPath,
    '--max-budget-usd', String(maxBudgetUsd),
    '--system-prompt', systemPromptFile,
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--allowedTools', 'mcp__playwright__*',
  ]

  console.log(`[claude-driver] MCP config: ${mcpConfigPath}`)
  console.log(`[claude-driver] Spawning claude (model: ${model})...`)

  return new Promise<TestResult>((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let killed = false
    let lastOutputTime = Date.now()

    const proc: ChildProcess = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DISABLE_INTERACTIVITY: '1',
      },
    })

    if (proc.pid) {
      console.log(`[claude-driver] Process spawned, PID: ${proc.pid}`)
    } else {
      console.log(`[claude-driver] WARNING: spawn returned but no PID yet`)
    }

    const timer = setTimeout(() => {
      killed = true
      console.log(`[claude-driver] TIMEOUT after ${Math.round(timeoutMs / 1000)}s, killing process...`)
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5000)
    }, timeoutMs)

    const activityCheck = setInterval(() => {
      if (!proc.pid || proc.killed) {
        console.log(`[claude-driver] Process no longer alive, stopping health check`)
        clearInterval(activityCheck)
        return
      }
      try {
        process.kill(proc.pid, 0)
      } catch {
        console.log(`[claude-driver] Process ${proc.pid} is gone`)
        clearInterval(activityCheck)
        return
      }
      const silentMs = Date.now() - lastOutputTime
      if (silentMs > 120000) {
        console.log(`[claude-driver] No output for ${Math.round(silentMs / 1000)}s — process alive but silent (stdout: ${stdout.length} bytes)`)
      }
    }, 30000)

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      lastOutputTime = Date.now()
      if (verbose) process.stdout.write(text)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      lastOutputTime = Date.now()
      console.log(`[claude-driver][stderr] ${text.trimEnd()}`)
    })

    const cleanup = () => {
      clearInterval(activityCheck)
      unlink(systemPromptFile).catch(() => {})
    }

    proc.on('error', (err) => {
      clearTimeout(timer)
      cleanup()
      console.log(`[claude-driver] SPAWN ERROR: ${err.message}`)
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      const durationMs = Date.now() - startTime
      console.log(`[claude-driver] Process exited with code ${code} after ${(durationMs / 1000).toFixed(1)}s`)
      console.log(`[claude-driver] stdout: ${stdout.length} bytes, stderr: ${stderr.length} bytes`)
      if (stderr && !verbose) {
        console.log(`[claude-driver] stderr tail: ${stderr.slice(-500)}`)
      }

      if (killed) {
        resolvePromise({
          passed: false,
          reason: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
          steps: [],
          rawOutput: stdout,
          durationMs,
        })
        return
      }

      if (code !== 0 && !stdout.includes('"passed"')) {
        resolvePromise({
          passed: false,
          reason: `claude CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
          steps: [],
          rawOutput: stdout,
          durationMs,
        })
        return
      }

      const result = parseTestResult(stdout)
      resolvePromise({
        ...result,
        rawOutput: stdout,
        durationMs,
      })
    })
  })
}

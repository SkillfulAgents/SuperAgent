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
  /** Override the default timeout (ms). When hit, process is killed and partial output is returned. */
  timeoutMs?: number
  /** Resume an existing session instead of starting a new one. */
  resumeSessionId?: string
  /** Pin a specific session ID (enables persistence + resume). */
  sessionId?: string
  /** Limit the number of agentic turns per invocation. */
  maxTurns?: number
  /** Per-invocation spending cap in USD. */
  maxBudgetUsd?: number
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MODEL = 'sonnet'
const DEFAULT_MAX_BUDGET_USD = 5

async function loadSystemPrompt(): Promise<string> {
  const uiDetails = await readFile(resolve(__dirname, 'UI-details.md'), 'utf-8')
  const prompt = await readFile(resolve(__dirname, 'system-prompt.md'), 'utf-8')
  return `${prompt}\n\n---\n\n## UI Reference\n\n${uiDetails}`
}

function parseTestResult(output: string): Pick<TestResult, 'passed' | 'reason' | 'steps'> {
  const passMatch = output.match(/^\[TEST_PASS\]/m)
  const failMatch = output.match(/^\[TEST_FAIL\]/m)
  const reasonMatch = output.match(/^\[REASON\]\s*(.+)$/m)
  const bugLines = [...output.matchAll(/^\[BUG_FOUND\]\s*(.+)$/gm)].map((m) => m[1].trim())
  const stepLines = [...output.matchAll(/^\[STEP\]\s*(.+)$/gm)].map((m) => m[1].trim())

  if (passMatch || failMatch) {
    const passed = !!passMatch && !failMatch
    let reason = reasonMatch ? reasonMatch[1].trim() : ''
    if (bugLines.length > 0) {
      reason += `\n  Bugs found:\n${bugLines.map((b) => `    - ${b}`).join('\n')}`
    }
    return { passed, reason, steps: stepLines }
  }

  return {
    passed: false,
    reason: `No [TEST_PASS] or [TEST_FAIL] marker found. Tail: ${output.slice(-300)}`,
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
    resumeSessionId,
    sessionId,
    maxTurns,
    maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  } = options

  const mcpConfigPath = options.mcpConfigPath ?? resolve(__dirname, 'playwright-mcp-config.json')

  const startTime = Date.now()

  let systemPromptFile: string | undefined
  const args: string[] = [
    '-p', testPrompt,
    '--output-format', 'text',
    '--model', model,
    '--mcp-config', mcpConfigPath,
    '--max-budget-usd', String(maxBudgetUsd),
    '--dangerously-skip-permissions',
    '--allowedTools', 'mcp__playwright__*',
  ]

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
  } else {
    const systemPrompt = options.systemPrompt ?? (await loadSystemPrompt())
    systemPromptFile = resolve(tmpdir(), `qa-agent-system-${randomUUID()}.md`)
    await writeFile(systemPromptFile, systemPrompt, 'utf-8')
    args.push('--system-prompt', systemPromptFile)
    if (!sessionId) {
      args.push('--no-session-persistence')
    }
  }

  if (sessionId) {
    args.push('--session-id', sessionId)
  }

  if (maxTurns) {
    args.push('--max-turns', String(maxTurns))
  }

  console.log(`[claude-driver] MCP config: ${mcpConfigPath}`)
  if (resumeSessionId) {
    console.log(`[claude-driver] Resuming session ${resumeSessionId} (model: ${model})...`)
  } else {
    console.log(`[claude-driver] Spawning claude (model: ${model})...`)
  }

  return new Promise<TestResult>((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let killed = false

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
        clearInterval(activityCheck)
        return
      }
      try {
        process.kill(proc.pid, 0)
      } catch {
        clearInterval(activityCheck)
        return
      }
      const elapsedMs = Date.now() - startTime
      console.log(`[health] agent processing... (${Math.round(elapsedMs / 1000)}s)`)
    }, 60000)

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      if (verbose) process.stdout.write(text)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      console.log(`[claude-driver][stderr] ${text.trimEnd()}`)
    })

    const cleanup = () => {
      clearInterval(activityCheck)
      if (systemPromptFile) unlink(systemPromptFile).catch(() => {})
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

      if (code !== 0 && !stdout.match(/\[TEST_PASS\]|\[TEST_FAIL\]|\[BUG_FOUND\]/)) {
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

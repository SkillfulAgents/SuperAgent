/**
 * Integration test: verifies the Claude Agent SDK preserves the `uuid` field
 * on SDKUserMessage when writing to JSONL.
 *
 * This tests an undocumented SDK behavior that our message author attribution
 * feature depends on. If the SDK stops honoring the uuid field, this test
 * will fail — alerting us that sender attribution is broken.
 *
 * Requires ANTHROPIC_API_KEY env var (set locally or via GH secret in CI).
 * Skipped if the key is not available.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.resolve(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

// Load .env.test.local if it exists (gitignored, for local dev)
const envFile = path.resolve(__dirname, '../.env.test.local')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim()
    }
  }
}

const API_KEY = process.env.SDK_TEST_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY

describe('SDK uuid preservation', () => {
  let tmpDir: string | null = null

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it.skipIf(!API_KEY)('preserves a provided uuid on user messages in the JSONL', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-uuid-test-'))

    const KNOWN_UUID = '11111111-2222-3333-4444-555555555555' as `${string}-${string}-${string}-${string}-${string}`

    const message: SDKUserMessage = {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Reply with just the word "ok" and nothing else.' }],
      },
      parent_tool_use_id: null,
      uuid: KNOWN_UUID,
    }

    const abortController = new AbortController()
    const q = query({
      prompt: (async function* () {
        yield message
        // Don't yield more — single turn
      })(),
      options: {
        cwd: tmpDir,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
        maxTurns: 1,
        model: 'claude-haiku-4-5-20251001',
        executable: 'node',
        pathToClaudeCodeExecutable: CLI_PATH,
        env: (() => {
          // Clone env and remove markers that prevent launching CC inside CC
          const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: API_KEY! }
          for (const key of Object.keys(env)) {
            if (key.startsWith('CLAUDE') || key === 'PARENT_TASK_ID') {
              delete env[key]
            }
          }
          return env
        })(),
      },
    })

    // Consume the query until it finishes (single turn, should be fast)
    let sessionId: string | null = null
    try {
      for await (const msg of q) {
        if (msg && 'session_id' in msg && msg.session_id) {
          sessionId = msg.session_id as string
        }
      }
    } catch {
      // Query may throw on abort or completion — expected
    }

    // Fallback: find session ID from JSONL files on disk
    if (!sessionId) {
      const findJsonl = (dir: string): string | null => {
        if (!fs.existsSync(dir)) return null
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            const found = findJsonl(full)
            if (found) return found
          } else if (entry.name.endsWith('.jsonl')) {
            return full
          }
        }
        return null
      }
      const jsonlPath = findJsonl(path.join(tmpDir, '.claude'))
      if (jsonlPath) {
        sessionId = path.basename(jsonlPath, '.jsonl')
      }
    }

    expect(sessionId).toBeTruthy()

    // Read back using the SDK's own getSessionMessages API
    const messages = await getSessionMessages(sessionId!, { dir: tmpDir })
    const userMessages = messages.filter((m) => m.type === 'user')

    expect(userMessages.length).toBeGreaterThanOrEqual(1)

    // THE CRITICAL ASSERTION: SDK must preserve our UUID
    expect(userMessages[0].uuid).toBe(KNOWN_UUID)
  }, 60_000) // 60s timeout — includes API round-trip
})

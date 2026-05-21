/**
 * Ad-hoc end-to-end validation of per-message model selection.
 *
 * NOT a committed test (filename ends in .local.ts and is gitignored).
 * Spins up a real container against a real Anthropic API key, sends three
 * messages flipping model between Haiku and Opus, and probes the SDK-written
 * JSONL transcript to confirm `message.model` reflects the requested family.
 *
 * Run from the repo root:
 *   npx tsx scripts/validate-model-selection.local.ts
 *
 * Reads the Anthropic API key from the dev settings file
 * (~/Library/Application Support/Superagent-dev/settings.json) so this works
 * out of the box on the developer machine.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { containerManager } from '../src/shared/lib/container/container-manager'
import { createAgent, agentExists } from '../src/shared/lib/services/agent-service'
import { getSessionJsonlPath } from '../src/shared/lib/utils/file-storage'

const DEV_SETTINGS = path.join(
  os.homedir(),
  'Library/Application Support/Superagent-dev/settings.json'
)

function loadDevAnthropicKey(): string {
  if (!fs.existsSync(DEV_SETTINGS)) {
    throw new Error(`Dev settings not found at ${DEV_SETTINGS}`)
  }
  const raw = JSON.parse(fs.readFileSync(DEV_SETTINGS, 'utf-8')) as { apiKeys?: { anthropicApiKey?: string } }
  const key = raw.apiKeys?.anthropicApiKey
  if (!key) throw new Error('No anthropicApiKey in dev settings.json')
  return key
}

interface JsonlEntry {
  type?: string
  message?: { model?: string; content?: unknown }
  timestamp?: string
}

function readJsonl(filePath: string): JsonlEntry[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlEntry)
}

function lastAssistantModel(entries: JsonlEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'assistant' && e.message?.model) return e.message.model
  }
  return undefined
}

async function waitForAssistantTurn(jsonlPath: string, sinceCount: number, timeoutMs = 90_000): Promise<JsonlEntry[]> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const entries = readJsonl(jsonlPath)
    if (entries.filter((e) => e.type === 'assistant').length > sinceCount) {
      return entries
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for new assistant turn in ${jsonlPath}`)
}

async function main(): Promise<void> {
  // Inject the real key into env so the container env-var injection picks it up.
  process.env.ANTHROPIC_API_KEY = loadDevAnthropicKey()

  const agentSlug = `validate-model-${Date.now()}`
  if (!(await agentExists(agentSlug))) {
    await createAgent({
      name: agentSlug,
      slug: agentSlug,
      description: 'Ad-hoc validation agent for per-message model selection',
      systemPrompt: 'You are a validation harness. Reply tersely.',
      tools: [],
    } as any)
    console.log(`[validate] Created agent ${agentSlug}`)
  }

  const client = await containerManager.ensureRunning(agentSlug)
  console.log(`[validate] Container running for ${agentSlug}`)

  // ---- Scenario 1: create session with Haiku ----
  const session = await client.createSession({
    initialMessage: 'Reply with just the word ok.',
    model: 'claude-haiku-4-5',
    effort: 'low',
  })
  const jsonlPath = getSessionJsonlPath(agentSlug, session.id)
  console.log(`[validate] Session ${session.id} -- JSONL ${jsonlPath}`)

  let entries = await waitForAssistantTurn(jsonlPath, 0)
  let model = lastAssistantModel(entries)
  console.log(`[validate] Scenario 1 (Haiku) -> assistant model = ${model}`)
  if (!model || !/haiku/i.test(model)) {
    throw new Error(`Scenario 1 expected haiku, got ${model}`)
  }

  // ---- Scenario 2: switch to Opus mid-session ----
  await client.sendMessage(session.id, 'Reply with just the word fine.', undefined, {
    model: 'claude-opus-4-7',
  })
  entries = await waitForAssistantTurn(jsonlPath, 1)
  model = lastAssistantModel(entries)
  console.log(`[validate] Scenario 2 (Opus) -> assistant model = ${model}`)
  if (!model || !/opus/i.test(model)) {
    throw new Error(`Scenario 2 expected opus, got ${model}`)
  }

  // ---- Scenario 3: switch back to Haiku ----
  await client.sendMessage(session.id, 'Reply with just the word great.', undefined, {
    model: 'claude-haiku-4-5',
  })
  entries = await waitForAssistantTurn(jsonlPath, 2)
  model = lastAssistantModel(entries)
  console.log(`[validate] Scenario 3 (Haiku again) -> assistant model = ${model}`)
  if (!model || !/haiku/i.test(model)) {
    throw new Error(`Scenario 3 expected haiku, got ${model}`)
  }

  console.log('[validate] All three scenarios passed -- mixed-model JSONL confirmed.')
  await client.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[validate] FAILED:', err)
  process.exit(1)
})

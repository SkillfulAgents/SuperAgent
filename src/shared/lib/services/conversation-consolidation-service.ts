/**
 * Conversation Consolidation Service
 *
 * Turns a finished chat conversation into two artifacts in one structured-output
 * call: durable, cross-conversation memory written to the agent's persistent
 * memory directory, and a short recap that seeds the next conversation. The
 * sweep (chat-integration-manager) is the only caller.
 *
 * Robustness contract (see the design spec):
 * - The transcript is size-bounded before the call.
 * - Deterministic failures (empty transcript, refusal, truncation, unparseable
 *   output) COMMIT an empty-memory fallback so a bad conversation is not retried
 *   every sweep forever. Only transient errors throw and let the sweep retry.
 * - The durable-memory write is idempotent (one file keyed by conversation id),
 *   and the commit is atomic (WHERE consolidated_at IS NULL), so an at-least-once
 *   run never duplicates memory or double-commits.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { getSessionMessages } from '@shared/lib/services/session-service'
import { markConversationConsolidated } from '@shared/lib/services/chat-integration-session-service'
import { getConfiguredLlmClient, extractTextFromLlmResponse } from '@shared/lib/llm-provider/helpers'
import { resolveActiveProviderModel, getActiveLlmProvider } from '@shared/lib/llm-provider'
import { getAgentMemoryDir } from '@shared/lib/utils/file-storage'
import { ConsolidationResultSchema, type ConsolidationResult } from './conversation-consolidation-schema'
import type { ChatIntegrationSession } from '@shared/lib/db/schema'
import type { JsonlMessageEntry } from '@shared/lib/types/agent'

/** ~100k tokens of input. Past this we keep the most-recent tail. */
const TRANSCRIPT_INPUT_CHAR_CAP = 400_000
const TRUNCATION_MARKER = '[earlier turns omitted]\n\n'
const CONSOLIDATION_MAX_TOKENS = 4000

const CONSOLIDATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    durableMemory: {
      type: 'string',
      description:
        'Lasting, cross-conversation facts and lessons worth remembering for all future conversations with this user. Markdown. Empty string if nothing is worth keeping.',
    },
    recap: {
      type: 'string',
      description:
        'A short summary that seeds the next conversation in this chat for continuity. Empty string if nothing is worth carrying forward.',
    },
  },
  required: ['durableMemory', 'recap'],
  additionalProperties: false,
} as const

/** Extract the readable text from a JSONL message entry's content. */
function entryText(entry: JsonlMessageEntry): string {
  const content = entry.message.content
  if (typeof content === 'string') return content
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') return `[tool: ${block.name}]`
      return '' // tool_result bodies and thinking are omitted to keep the input lean
    })
    .filter(Boolean)
    .join('\n')
}

/** Serialize a transcript to `Role: text` turns, dropping empty turns. */
function transcriptToText(entries: JsonlMessageEntry[]): string {
  return entries
    .map((entry) => {
      const text = entryText(entry).trim()
      if (!text) return ''
      const role = entry.type === 'assistant' ? 'Assistant' : 'User'
      return `${role}: ${text}`
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Cap the transcript, keeping the most-recent tail and marking the cut. */
function boundTranscript(text: string): string {
  if (text.length <= TRANSCRIPT_INPUT_CHAR_CAP) return text
  return TRUNCATION_MARKER + text.slice(text.length - TRANSCRIPT_INPUT_CHAR_CAP)
}

function buildConsolidationPrompt(transcript: string): string {
  return `A chat conversation between a user and an AI agent has ended (it crossed its "new conversation" idle threshold). Consolidate it before its context is lost.

Return two things:
1. durableMemory: the lasting, cross-conversation facts and lessons about this user or their work that future conversations should know. Be specific and durable. Return an empty string if there is genuinely nothing worth remembering.
2. recap: a short, plain summary that seeds the next conversation in this chat so the agent can pick up where it left off. Return an empty string if there is nothing worth carrying forward.

Conversation transcript:
${transcript}`
}

/** Write/overwrite the conversation's single keyed memory file (idempotent). */
async function writeDurableMemory(agentSlug: string, conversation: ChatIntegrationSession, memory: string): Promise<void> {
  const dir = getAgentMemoryDir(agentSlug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `consolidated-${conversation.id}.md`), memory, 'utf8')
}

/**
 * Consolidate one finished conversation into durable memory + a recap.
 *
 * Idempotent and safe to retry: an early `consolidatedAt` check and the atomic
 * commit mean a re-run is a no-op or a harmless memory overwrite.
 */
export async function consolidateConversation(conversation: ChatIntegrationSession): Promise<void> {
  if (conversation.consolidatedAt) return

  const integration = getChatIntegration(conversation.integrationId)
  if (!integration) return
  const agentSlug = integration.agentSlug

  const entries = await getSessionMessages(agentSlug, conversation.sessionId)
  const transcript = boundTranscript(transcriptToText(entries))
  // Empty transcript is terminal: commit so the row stops being a candidate.
  if (!transcript.trim()) {
    markConversationConsolidated(conversation.id, '')
    return
  }

  const client = getConfiguredLlmClient()
  const model = resolveActiveProviderModel(getActiveLlmProvider().getDefaultModel('consolidator'), 'consolidator')

  const response = await client.messages.create({
    model,
    max_tokens: CONSOLIDATION_MAX_TOKENS,
    messages: [{ role: 'user', content: buildConsolidationPrompt(transcript) }],
    output_config: { format: { type: 'json_schema' as const, schema: CONSOLIDATION_JSON_SCHEMA } },
  })

  // Terminal failures: commit an empty fallback so a too-long / refused /
  // truncated conversation never retries every 5 minutes forever. (max_tokens =>
  // truncated output; a retry at the same cap would truncate again.)
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    markConversationConsolidated(conversation.id, '')
    return
  }
  const text = extractTextFromLlmResponse(response)
  if (!text) {
    markConversationConsolidated(conversation.id, '')
    return
  }

  let result: ConsolidationResult
  try {
    result = ConsolidationResultSchema.parse(JSON.parse(text))
  } catch {
    // Bad/truncated output is terminal, not an infinite retry.
    markConversationConsolidated(conversation.id, '')
    return
  }

  if (result.durableMemory.trim()) {
    await writeDurableMemory(agentSlug, conversation, result.durableMemory)
  }
  markConversationConsolidated(conversation.id, result.recap)
}

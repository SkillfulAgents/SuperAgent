import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { HostToolResult } from '@shared/lib/agent-actor/host-port'
import { bindAgentModelChoice } from '@shared/lib/llm-provider/connection-runtime'
import { readAgentPreferences } from '@shared/lib/services/agent-preferences-service'

export function resolved(value: string, sessionEvents?: Record<string, unknown>[]): HostToolResult {
  return sessionEvents ? { status: 'resolved', value, sessionEvents } : { status: 'resolved', value }
}

export function rejected(reason: string): HostToolResult {
  return { status: 'rejected', reason }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The user who created the session, when one did; tools that act for them attribute to them. */
export async function sessionOwnerOf(agentSlug: string, sessionId: string): Promise<string | undefined> {
  return (await agentRegistry.get(agentSlug).sessions.metadata(sessionId))?.createdByUserId ?? undefined
}

// The shape create_webhook_endpoint's schema gives these fields, for every tool.
const modelChoiceSchema = z.object({ model: z.string().trim().min(1).nullish(), connection: z.string().trim().min(1).nullish() })

/** The model and account an automation tool names, checked as the session's creator, who the run is attributed to; throws on a refused choice. */
export async function agentModelChoice(
  agentSlug: string,
  sessionId: string,
  choice: { model?: unknown; connection?: unknown },
): Promise<{ model?: string; llmProviderId?: string }> {
  const parsed = modelChoiceSchema.safeParse({ model: choice.model, connection: choice.connection })
  if (!parsed.success) throw new Error('model and connection must be non-empty text.')
  const picked = { model: parsed.data.model ?? undefined, connection: parsed.data.connection ?? undefined }
  if (!picked.model && !picked.connection) return {}
  return bindAgentModelChoice(picked, await readAgentPreferences(agentSlug), await sessionOwnerOf(agentSlug, sessionId))
}

/** The tool input as JSON, or undefined when it does not parse. */
export function parseToolInput<T>(input: string): T | undefined {
  try {
    return JSON.parse(input) as T
  } catch {
    return undefined
  }
}

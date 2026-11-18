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

/** The model an automation tool names, bound to the agent's connection; throws on an unknown model. */
export async function agentModelChoice(agentSlug: string, model: string | undefined): Promise<{ model?: string; llmProviderId?: string }> {
  return model ? bindAgentModelChoice(model, await readAgentPreferences(agentSlug)) : {}
}

/** The tool input as JSON, or undefined when it does not parse. */
export function parseToolInput<T>(input: string): T | undefined {
  try {
    return JSON.parse(input) as T
  } catch {
    return undefined
  }
}

import { z } from 'zod'

/** Every AgentRuntimeError response has this body; a subclass may add fields via `body()`. */
export const agentRuntimeErrorBodySchema = z.looseObject({
  code: z.string().min(1),
  error: z.string(),
})
export type AgentRuntimeErrorBody = z.infer<typeof agentRuntimeErrorBodySchema>

/**
 * An expected session/runtime/agent failure that owns its HTTP response, so routes
 * stay `findAgentRuntimeError(error)?.toHttpResponse()`. The renderer picks a preview by `code`.
 */
export abstract class AgentRuntimeError extends Error {
  abstract readonly code: string
  abstract readonly status: number

  protected headers(): Record<string, string> {
    return {}
  }

  protected body(): AgentRuntimeErrorBody {
    return { code: this.code, error: this.message }
  }

  toHttpResponse(): Response {
    return Response.json(this.body(), { status: this.status, headers: this.headers() })
  }
}

/** Callers often wrap the failure (e.g. in MessageNotAcceptedError), so walk `cause`. */
export function findAgentRuntimeError(error: unknown): AgentRuntimeError | null {
  const seen = new Set<unknown>()
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof AgentRuntimeError) return current
    seen.add(current)
  }
  return null
}

import { agentRuntimeErrorBodySchema, type AgentRuntimeErrorBody } from '@shared/lib/agent-runtime-errors/agent-runtime-error'

/** A failed request whose body came from `AgentRuntimeError.toHttpResponse()`. */
export class AgentRuntimeRequestError extends Error {
  readonly code: string

  constructor(readonly status: number, readonly body: AgentRuntimeErrorBody) {
    super(body.error)
    this.name = 'AgentRuntimeRequestError'
    this.code = body.code
  }
}

export async function readAgentRuntimeError(res: Response, fallback: string): Promise<Error> {
  const body = agentRuntimeErrorBodySchema.safeParse(await res.json().catch(() => null))
  return body.success ? new AgentRuntimeRequestError(res.status, body.data) : new Error(fallback)
}

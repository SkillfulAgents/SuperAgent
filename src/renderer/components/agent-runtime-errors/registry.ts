import type { ComponentType } from 'react'

import { AgentRuntimeRequestError } from '@renderer/lib/agent-runtime-request-error'

export interface AgentRuntimeErrorPreviewProps {
  error: AgentRuntimeRequestError
}

// AgentRuntimeError `code` → inline preview. Adding a preview = one row here.
// Codes without a row keep the global toast with the server's message.
const PREVIEWS: Partial<Record<string, ComponentType<AgentRuntimeErrorPreviewProps>>> = {}

export function resolveAgentRuntimeErrorPreview(error: unknown): ComponentType<AgentRuntimeErrorPreviewProps> | undefined {
  return error instanceof AgentRuntimeRequestError ? PREVIEWS[error.code] : undefined
}

import type { ComponentType } from 'react'

import { AgentRuntimeRequestError } from './agent-runtime-request-error'

export interface AgentRuntimeErrorPreviewProps {
  error: AgentRuntimeRequestError
}

// Client only: AgentRuntimeError `code` → its preview, which lives in that error's folder.
// Server code must not import this file. Codes without a row keep the global toast.
const PREVIEWS: Partial<Record<string, ComponentType<AgentRuntimeErrorPreviewProps>>> = {}

export function resolveAgentRuntimeErrorPreview(error: unknown): ComponentType<AgentRuntimeErrorPreviewProps> | undefined {
  return error instanceof AgentRuntimeRequestError ? PREVIEWS[error.code] : undefined
}

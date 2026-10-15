import type { AgentRuntimeRequestError } from './agent-runtime-request-error'

import { resolveAgentRuntimeErrorPreview } from './previews'

/** Renders a failed start/send request inline when its `code` has a preview. */
export function AgentRuntimeErrorView({ error, className }: { error: unknown; className?: string }) {
  const Preview = resolveAgentRuntimeErrorPreview(error)
  if (!Preview) return null
  return (
    <div className={className}>
      <Preview error={error as AgentRuntimeRequestError} />
    </div>
  )
}

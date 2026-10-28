import { CircleStop } from 'lucide-react'
import type { UserMessageKindSpec, UserMessageRenderProps } from './types'

const INTERRUPT_PREFIX = '[Request interrupted by user'
const INTERRUPT_FOR_TOOL_USE = '[Request interrupted by user for tool use]'

/**
 * A small right-aligned chip: the person pressed stop here. The "for tool
 * use" variant says so, since it means the pending tool call never ran.
 */
export function InterruptMarkerChip({ text, message }: UserMessageRenderProps) {
  const beforeTool = text.startsWith(INTERRUPT_FOR_TOOL_USE)
  const stoppedAt = new Date(message.createdAt)
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
      title={Number.isNaN(stoppedAt.getTime()) ? undefined : stoppedAt.toLocaleString()}
      data-testid="interrupt-marker"
    >
      <CircleStop className="h-3 w-3" strokeWidth={2.25} aria-hidden />
      <span>{beforeTool ? 'Stopped before the tool ran' : 'Stopped'}</span>
    </div>
  )
}

/**
 * The synthetic "[Request interrupted by user]" / "[Request interrupted by
 * user for tool use]" user message the CLI appends when a turn is interrupted.
 * It ENDS the interrupted turn rather than starting a new one, so turn
 * scanning treats it specially. Drawn bare: it is not something the person
 * said, so no bubble and no copy/remove menu.
 */
export const interruptMarker: UserMessageKindSpec = {
  kind: 'interrupt',
  match: (text) => text.startsWith(INTERRUPT_PREFIX),
  hidden: false,
  Render: InterruptMarkerChip,
  chrome: 'bare',
}

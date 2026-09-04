import type { UserMessageKindSpec, UserMessageRenderProps } from './types'

/** Command name in monospace, arguments dimmed after it. */
export function SlashCommandBubble({ text }: UserMessageRenderProps) {
  const spaceIndex = text.indexOf(' ')
  const name = spaceIndex === -1 ? text : text.slice(0, spaceIndex)
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1)
  return (
    <div className="text-sm">
      <span className="font-mono font-medium">{name}</span>
      {args && <span className="opacity-80"> {args}</span>}
    </div>
  )
}

/** Any user message that starts with "/". More specific commands go before this. */
export const slashCommand: UserMessageKindSpec = {
  kind: 'slash',
  match: (text) => text.startsWith('/'),
  hidden: false,
  Render: SlashCommandBubble,
}

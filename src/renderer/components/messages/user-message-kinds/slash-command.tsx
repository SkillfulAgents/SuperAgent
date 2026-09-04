import type { UserMessageKindSpec, UserMessageRenderProps } from './types'

/**
 * Command name in monospace; the arguments render as ordinary Markdown so a
 * slash command's body looks exactly like a plain message's. Short arguments
 * sit on the command's line, longer ones wrap beneath it.
 */
export function SlashCommandBubble({ text, renderMarkdown }: UserMessageRenderProps) {
  const spaceIndex = text.indexOf(' ')
  const name = spaceIndex === -1 ? text : text.slice(0, spaceIndex)
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1)
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
      <span className="font-mono font-medium">{name}</span>
      {args && <div className="min-w-0 opacity-80">{renderMarkdown(args)}</div>}
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

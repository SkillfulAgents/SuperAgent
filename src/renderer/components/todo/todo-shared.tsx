import { useMemo, type ReactNode } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Plus, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import { FileIconTile } from '@renderer/components/ui/file-icon-tile'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import type { ApiAgent } from '@shared/lib/types/api'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import { useAgents } from '@renderer/hooks/use-agents'
import type { TodoAgentRef, TodoAttachment, TodoCard } from './todo-schema'

const GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#5b8def', '#8f6bff'],
  ['#ff8a5b', '#ff5b8d'],
  ['#2fbf9f', '#5b8def'],
  ['#f2b134', '#ff7a59'],
  ['#8f6bff', '#e05bff'],
  ['#3ac7e8', '#2fbf9f'],
]

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
}

function agentInitials(name: string): string {
  // Words that start with a letter or digit; an emoji or symbol prefix is
  // decoration, not a name.
  const parts = name
    .trim()
    .split(/\s+/)
    .map((w) => Array.from(w).filter((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((w) => w.length > 0)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).join('').toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Small round identity mark for an agent. Colour is hashed from the slug. */
export function TodoAgentAvatar({ agent, size = 20, className }: { agent: TodoAgentRef; size?: number; className?: string }) {
  const [from, to] = GRADIENTS[hashString(agent.slug) % GRADIENTS.length]
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white', className)}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.42), background: `linear-gradient(145deg, ${from}, ${to})` }}
    >
      {agentInitials(agent.name)}
    </span>
  )
}

/** Avatar + name, sized for a card footer or a dialog row. */
export function TodoAgentChip({ agent, size = 'sm', onRemove }: { agent: TodoAgentRef; size?: 'sm' | 'md'; onRemove?: () => void }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background pr-2',
        size === 'sm' ? 'h-6 pl-0.5 text-[11px]' : 'h-8 pl-1 text-xs',
      )}
      title={agent.name}
    >
      <TodoAgentAvatar agent={agent} size={size === 'sm' ? 18 : 24} />
      <span className="truncate">{agent.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Unassign ${agent.name}`}
          className="-mr-1 rounded-full px-1 text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      )}
    </span>
  )
}

/** Pick an agent to add to a card. */
export function AssignMenu({ candidates, onPick, trigger }: {
  candidates: TodoAgentRef[]
  onPick: (agent: TodoAgentRef) => void
  /** Replaces the default dashed "Assign agent" pill. */
  trigger?: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed px-2.5 text-xs text-muted-foreground hover:border-border hover:text-foreground"
            data-testid="todo-assign-agent"
          >
            <Plus className="h-3.5 w-3.5" />
            Assign agent
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs">Your agents</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {candidates.length === 0 && <DropdownMenuItem disabled>Everyone is already on it</DropdownMenuItem>}
        {candidates.map((agent) => (
          <DropdownMenuItem key={agent.slug} onSelect={() => onPick(agent)}>
            <span className="truncate">{agent.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function toAgentRef(agent: Pick<ApiAgent, 'slug' | 'name'>): TodoAgentRef {
  return { slug: agent.slug, name: agent.name }
}

/**
 * The real agents on this install, as assignable refs. Falls back to a
 * "New agent" placeholder so the flow still works on an empty install.
 */
export function useAssignableAgents(): TodoAgentRef[] {
  const { data } = useAgents()
  return useMemo(() => {
    const refs = (data ?? []).map(toAgentRef)
    return refs.length > 0 ? refs : [{ slug: 'new-agent', name: 'New agent' }]
  }, [data])
}

/**
 * Stand-in for the routing step: the real thing would match the task to an
 * agent's skills or spin up a fresh one. Here it is a stable pick from the
 * prompt text so the same draft always routes the same way.
 */
export function pickAgentFor(prompt: string, agents: TodoAgentRef[]): TodoAgentRef {
  if (agents.length === 0) return { slug: 'new-agent', name: 'New agent' }
  return agents[hashString(prompt.trim().toLowerCase() || 'empty') % agents.length]
}

export function toTodoAttachments(attachments: Attachment[]): TodoAttachment[] {
  return attachments.map((a) => {
    if (a.type === 'file') return { id: a.id, name: a.file.name, size: a.file.size, kind: 'file' as const }
    if (a.type === 'folder') return { id: a.id, name: a.folderName, size: a.totalSize, kind: 'folder' as const }
    return { id: a.id, name: a.folderName, size: 0, kind: 'folder' as const }
  })
}

/** Short noun for the kind of ask on a Needs Attention card. */
export function attentionKind(card: Pick<TodoCard, 'attentionReason' | 'request'>): string {
  if (card.attentionReason === 'action') return card.request?.type === 'account_reauth' ? 'Reconnect' : 'Permission'
  if (card.attentionReason === 'review') return 'Review'
  return 'Question'
}

export function relativeTime(ts: number): string {
  return formatDistanceToNowStrict(ts, { addSuffix: true })
}

/** The card's context files, or the drop hint when there are none. */
export function TodoAttachmentList({ attachments, onRemove, emptyHint = 'Drop files or folders anywhere in this note' }: {
  attachments: TodoAttachment[]
  onRemove: (id: string) => void
  emptyHint?: string
}) {
  if (attachments.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
        {emptyHint}
      </div>
    )
  }
  // Same chip as the composer's AttachmentPreview (icon tile, name over size,
  // remove on a grey circle); that component needs live File objects, which a
  // stored draft does not keep, so the recipe is repeated here.
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => (
        <div
          key={a.id}
          className="relative flex items-center gap-2 rounded-md border bg-background py-1.5 pl-2 pr-7 text-xs"
          data-testid="todo-attachment"
          data-attachment-name={a.name}
        >
          <FileIconTile filename={a.name} folder={a.kind === 'folder'} />
          <div className="flex min-w-0 flex-col">
            <span className="max-w-[160px] truncate font-medium" title={a.name}>{a.name}</span>
            {a.size > 0 && <span className="text-muted-foreground">{formatFileSize(a.size)}</span>}
          </div>
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            className="absolute right-1 top-1 rounded-full bg-muted p-0.5 text-foreground transition-colors hover:bg-muted-foreground/20"
            aria-label={`Remove ${a.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

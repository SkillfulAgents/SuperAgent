import { Split } from 'lucide-react'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { AppLink } from '@renderer/components/ui/app-link'
import { useSession } from '@renderer/hooks/use-sessions'
import { ThreadDivider } from './thread-divider'

/**
 * Where the fork line goes: the index of the first item written after the
 * copied history (a message, or a compaction, recall, or banner), so equal to
 * the length right after forking. Null when nothing was copied (not a fork,
 * or the copied part is not loaded).
 *
 * The first unflagged item, not the item after the last flagged one: system
 * items that share a slot between two messages are displayed grouped by type,
 * not in transcript order, so a copied banner can render after a compaction
 * that ran in the fork, and a scroll window can even open on that compaction.
 * Stopping at the first new item keeps everything new below the line whichever
 * way a slot is ordered or cut.
 */
export function forkBoundaryIndex(items: readonly ApiMessageOrBoundary[]): number | null {
  if (!items.some((item) => item.forked)) return null
  const firstNew = items.findIndex((item) => !item.forked)
  return firstNew === -1 ? items.length : firstNew
}

interface ForkBoundaryItemProps {
  sessionId: string
  agentSlug: string
}

/** The rule in a forked thread where the copied history ends and the fork begins. */
export function ForkBoundaryItem({ sessionId, agentSlug }: ForkBoundaryItemProps) {
  const { data: session } = useSession(sessionId, agentSlug)
  // Messages can land before the session does; "deleted" is only true of a
  // loaded session that has no source name.
  if (!session) return null
  const sourceId = session.forkedFromSessionId
  const sourceName = session.forkedFromSessionName

  return (
    <ThreadDivider className="py-2" data-testid="fork-boundary">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Split className="h-3 w-3" aria-hidden />
        <span>
          Branched from{' '}
          {sourceId && sourceName ? (
            <AppLink
              to="/agents/$slug/sessions/$sessionId"
              params={{ slug: agentSlug, sessionId: sourceId }}
              className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
              data-testid="fork-boundary-link"
            >
              {sourceName}
            </AppLink>
          ) : (
            'a deleted conversation'
          )}
        </span>
      </div>
    </ThreadDivider>
  )
}

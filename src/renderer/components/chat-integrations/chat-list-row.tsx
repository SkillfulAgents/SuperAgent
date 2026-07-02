import { Loader2 } from 'lucide-react'
import { format } from 'date-fns'
import { Button } from '@renderer/components/ui/button'
import {
  useApproveChatAccess,
  useRevokeChatAccess,
} from '@renderer/hooks/use-chat-integrations'
import { isBrowsable, type ChatRow } from './chat-inbox-model'

const lastActive = (row: ChatRow) =>
  row.lastActivityAt ? format(new Date(row.lastActivityAt), 'MMM d, h:mm a') : null

/** Access action with a per-button spinner while its mutation is in flight. */
function AccessButton({ label, pending, onClick, className, variant = 'ghost' }: {
  label: string
  pending: boolean
  onClick: () => void
  className?: string
  variant?: 'ghost' | 'outline'
}) {
  return (
    <Button
      size="xs"
      variant={variant}
      className={className}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : label}
    </Button>
  )
}

interface ChatListRowProps {
  row: ChatRow
  integrationId: string
  isSelected: boolean
  /** Telegram owner: can approve/deny/revoke. */
  canManageAccess: boolean
  onOpen: (row: ChatRow) => void
}

/**
 * One chat in the conversation inbox. Allowed/ungated chats open their thread on
 * click; not-yet-allowed chats (pending or denied) render the same - a "Blocked"
 * tag with a single Unblock action. Styled like the cron Run History rows.
 */
export function ChatListRow({ row, integrationId, isSelected, canManageAccess, onOpen }: ChatListRowProps) {
  const approve = useApproveChatAccess()
  const revoke = useRevokeChatAccess()

  const browsable = isBrowsable(row)
  // Pending and denied are both "not allowed" - the bot ignores both - so we show
  // them identically as Blocked; the only action is Unblock (Block lives on allowed rows).
  const isBlocked = row.status === 'pending' || row.status === 'denied'
  const accessId = row.accessId

  const open = () => browsable && onOpen(row)

  return (
    <div
      role={browsable ? 'button' : undefined}
      tabIndex={browsable ? 0 : undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (browsable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open()
        }
      }}
      data-testid={`chat-row-${row.externalChatId}`}
      className={[
        'group flex items-center gap-3 px-1 py-3 text-left transition-colors',
        browsable ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
        isSelected ? 'bg-muted/50' : '',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">
            {row.title}
          </span>
          {isBlocked ? (
            <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-600 dark:text-red-400">
              Blocked
            </span>
          ) : row.approvalSource === 'auto_first_contact' && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Auto-allowed
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {lastActive(row) ?? 'No messages yet'}
        </div>
      </div>

      {canManageAccess && accessId && (
        <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {isBlocked && (
            <AccessButton
              label="Unblock"
              pending={approve.isPending}
              onClick={() => approve.mutate({ integrationId, accessId })}
            />
          )}
          {row.status === 'allowed' && (
            <AccessButton
              label="Block"
              pending={revoke.isPending}
              onClick={() => revoke.mutate({ integrationId, accessId })}
              className="text-muted-foreground hover:text-destructive"
            />
          )}
        </div>
      )}
    </div>
  )
}

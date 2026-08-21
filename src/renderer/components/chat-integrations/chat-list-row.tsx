import { formatSessionTimestamp } from '@shared/lib/chat-integrations/utils'
import { AccessActions } from './access-actions'
import { isBrowsable, type ChatRow } from './chat-inbox-model'

const lastActive = (row: ChatRow) =>
  row.lastActivityAt ? formatSessionTimestamp(new Date(row.lastActivityAt)) : null

interface ChatListRowProps {
  row: ChatRow
  integrationId: string
  isSelected: boolean
  /** Telegram owner: can approve/deny/revoke. */
  canManageAccess: boolean
  onOpen: (row: ChatRow) => void
}

/**
 * One chat in the conversation inbox. Allowed/ungated chats open their read-only
 * thread; not-yet-allowed chats (pending or denied) open the same dialog to their
 * chat-request first message. Styled like the cron Run History rows.
 */
export function ChatListRow({ row, integrationId, isSelected, canManageAccess, onOpen }: ChatListRowProps) {
  // Pending and denied are both "not allowed" - the bot ignores both - so we tag
  // them identically as Blocked.
  const isBlocked = row.status === 'pending' || row.status === 'denied'
  // Allowed/ungated chats open their thread; blocked chats have no window but still
  // open the dialog to show their chat request (the first message).
  const openable = isBrowsable(row) || isBlocked

  const open = () => openable && onOpen(row)

  return (
    <div
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={open}
      onKeyDown={(e) => {
        // Only the row itself opens on Enter/Space; a keystroke bubbling up from a
        // child control (the access buttons) must not also open the dialog.
        if (e.target === e.currentTarget && openable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open()
        }
      }}
      data-testid={`chat-row-${row.externalChatId}`}
      className={[
        'group flex items-center gap-3 px-1 py-3 text-left transition-colors',
        openable ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
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
          {/* A blocked chat has no conversation activity worth timestamping; surface
              what it said (the chat request) so the owner can triage from the list. */}
          {isBlocked && row.firstMessagePreview
            ? row.firstMessagePreview
            : (lastActive(row) ?? 'No messages yet')}
        </div>
      </div>

      {canManageAccess && row.accessId && (
        <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <AccessActions row={row} integrationId={integrationId} />
        </div>
      )}
    </div>
  )
}

import { useMemo } from 'react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { SectionHeader } from '@renderer/components/ui/section-header'
import { useChatIntegrationAccess } from '@renderer/hooks/use-chat-integrations'
import { buildChatRows, activeWindow, type ChatRow } from './chat-inbox-model'
import { ChatListRow } from './chat-list-row'
import { ConversationDetail } from './conversation-detail'
import type { ChatIntegration, ChatIntegrationSession } from '@shared/lib/db/schema'

interface ConversationHistorySectionProps {
  integration: ChatIntegration
  sessions: ChatIntegrationSession[] | undefined
  /** The route's `?session=` value (the open window), or null. */
  routeSessionId: string | null
  /** The route's `?newchat=` value (a chat opened to a fresh conversation), or null. */
  routeNewChatId: string | null
  /** Navigate to a window (sets `?session=`) or back to the list (null). */
  onSelectWindow: (sessionId: string | null) => void
  /** Open a chat to a fresh, not-yet-created conversation (sets `?newchat=`). */
  onNewConversation: (externalChatId: string) => void
  agentSlug: string
  providerName: string
  canManageAccess: boolean
}

/**
 * The conversation inbox: a cron-Run-History-style list of chats (left column),
 * each opening its read-only thread in place. For Telegram owners it also folds
 * in access control - pending requests to approve/deny, denied chats greyed - so
 * conversations and the allowlist live in one surface.
 */
export function ConversationHistorySection({
  integration,
  sessions,
  routeSessionId,
  routeNewChatId,
  onSelectWindow,
  onNewConversation,
  agentSlug,
  providerName,
  canManageAccess,
}: ConversationHistorySectionProps) {
  const canAccess = canManageAccess && integration.provider === 'telegram'
  const { data: access } = useChatIntegrationAccess(integration.id, canAccess)

  const rows = useMemo(
    () => buildChatRows(sessions, canAccess ? access : undefined),
    [sessions, access, canAccess],
  )
  // Landing on the page (no `?session=`/`?newchat=`) shows the conversation list; a
  // chat opens only when explicitly selected. A specific window (`?session=`) wins;
  // otherwise `?newchat=` opens a chat to a fresh, not-yet-created conversation.
  const routeValid = !!routeSessionId && (sessions ?? []).some((s) => s.sessionId === routeSessionId)
  const openWindowId = routeValid ? routeSessionId : null
  const openChat = openWindowId
    ? rows.find((r) => r.windows.some((w) => w.sessionId === openWindowId))
    : undefined
  // Blank "new conversation" view for a chat with no window selected.
  const blankChat = !openWindowId && routeNewChatId
    ? rows.find((r) => r.externalChatId === routeNewChatId)
    : undefined
  const detailChat = openChat ?? blankChat

  // Open a chat to its live conversation, or - if it has none (all cleared) - to a
  // fresh blank one.
  const openChatRow = (row: ChatRow) => {
    const live = activeWindow(row)
    if (live) onSelectWindow(live.sessionId)
    // onOpen only fires for browsable rows (latestSessionId != null), so a row with
    // no live window always has a cleared one to reopen as a fresh conversation.
    else onNewConversation(row.externalChatId)
  }
  const backToList = () => onSelectWindow(null)

  return (
    <div className="pb-6">
      <SectionHeader title="Conversations" />

      {rows.length > 0 ? (
        <div className="divide-y divide-border/50">
          {rows.map((row) => (
            <ChatListRow
              key={row.externalChatId}
              row={row}
              integrationId={integration.id}
              isSelected={detailChat?.externalChatId === row.externalChatId}
              canManageAccess={canAccess}
              onOpen={openChatRow}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No conversations yet. Send a message from {providerName} to start.
        </div>
      )}

      {/* Selecting a chat (`?session=`/`?newchat=`) opens its read-only replay in a
          dialog over the list; closing it clears the route back to the list. */}
      <Dialog open={!!detailChat} onOpenChange={(open) => { if (!open) backToList() }}>
        <DialogContent className="max-w-2xl" aria-describedby={undefined}>
          {detailChat && (
            <ConversationDetail
              row={detailChat}
              openWindowId={openWindowId}
              agentSlug={agentSlug}
              providerName={providerName}
              integrationId={integration.id}
              canManageAccess={canAccess}
              onSelectWindow={onSelectWindow}
              onNewConversation={onNewConversation}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { DialogTitle } from '@renderer/components/ui/dialog'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { WorkflowProvider } from '@renderer/context/workflow-context'
import { formatSessionTimestamp } from '@shared/lib/chat-integrations/utils'
import type { ChatRow } from './chat-inbox-model'
import type { ChatIntegrationSession } from '@shared/lib/db/schema'

// The thread hugs its content when short and scrolls internally once it grows past
// this cap - we cap SessionThread's own scroller (data-message-content-area) and
// let it auto-size, so the dialog stays a sensible height.
const CONVERSATION_PANEL_SCROLL = '[&_[data-message-content-area]]:max-h-[65vh] [&_[data-message-content-area]]:!h-auto'

const windowLabel = (w: ChatIntegrationSession) =>
  `${formatSessionTimestamp(new Date(w.updatedAt))}${w.archivedAt ? ' (cleared)' : ''}`

// Switcher value for the fresh, not-yet-created conversation.
const NEW_WINDOW = '__new__'

interface ConversationDetailProps {
  row: ChatRow
  /** The window (claude sessionId) currently shown, or null for a fresh conversation. */
  openWindowId: string | null
  agentSlug: string
  providerName: string
  onSelectWindow: (sessionId: string) => void
  onNewConversation: (externalChatId: string) => void
}

/**
 * Read-only replay of one chat's conversation, shown inside the inbox Dialog
 * (title + window switcher, then the thread). With no window (`openWindowId`
 * null) it shows the chat's fresh, blank conversation - what you land on right
 * after starting a new conversation - with the cleared one in the switcher.
 * The "New conversation" action itself lives in the page's title bar, not here.
 */
export function ConversationDetail({
  row,
  openWindowId,
  agentSlug,
  providerName,
  onSelectWindow,
  onNewConversation,
}: ConversationDetailProps) {
  const blank = openWindowId == null

  // The chat has no live conversation (all windows cleared, or none yet), so the
  // "current" conversation is a fresh one - offer it in the switcher alongside the
  // cleared windows, and always when blank so the Select's value has a match.
  const noActive = !row.windows.some((w) => w.archivedAt == null)
  const switcherOptions = [
    ...(blank || noActive ? [{ value: NEW_WINDOW, label: 'New conversation' }] : []),
    ...row.windows.map((w) => ({ value: w.sessionId, label: windowLabel(w) })),
  ]
  const switcherValue = blank ? NEW_WINDOW : (openWindowId as string)

  return (
    <div>
      {/* pr-8 leaves room for the Dialog's close button in the top-right corner. */}
      <div className="flex items-center justify-between gap-2 pr-8">
        <div className="flex min-w-0 items-baseline gap-2">
          <DialogTitle className="truncate text-sm font-medium">{row.title}</DialogTitle>
          <span className="shrink-0 text-xs text-muted-foreground">Conversation history (read-only)</span>
        </div>

        {switcherOptions.length > 1 && (
          <Select
            value={switcherValue}
            onValueChange={(v) => (v === NEW_WINDOW ? onNewConversation(row.externalChatId) : onSelectWindow(v))}
          >
            <SelectTrigger className="h-8 w-[170px] shrink-0 text-xs" aria-label="Switch conversation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {switcherOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {blank ? (
        <div className="mt-3 flex min-h-[180px] items-center justify-center rounded-xl border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No messages yet. The next message from {row.title} on {providerName} starts a new conversation.
        </div>
      ) : (
        <FilePreviewProvider sessionId={openWindowId as string}>
          {/* MessageList (via SessionThread) reads WorkflowContext, so provide it
              here as the live session view does - scoped to this window's session. */}
          <WorkflowProvider sessionId={openWindowId as string}>
            {/* Read-only mirror cue: a muted, washed panel that reads as "not a live
                chat". The opacity wash only works in light mode (it lightens content
                toward the page); in dark mode it muddies contrast and hides bubbles,
                so we drop it there and lean on the muted panel instead. */}
            <div className={`reader-scrollbar mt-3 overflow-hidden rounded-xl border bg-muted/30 ${CONVERSATION_PANEL_SCROLL}`}>
              <div className="cursor-default opacity-75 dark:opacity-100">
                <SessionThread
                  sessionId={openWindowId as string}
                  agentSlug={agentSlug}
                  footer={null}
                  footerClassName="bg-transparent"
                  readOnly
                />
              </div>
            </div>
          </WorkflowProvider>
        </FilePreviewProvider>
      )}
    </div>
  )
}

import { useRef, useState } from 'react'
import { Copy, ExternalLink, MessageSquarePlus, Square, Trash2, Volume2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { openExternalUrl } from '@renderer/lib/open-external'
import { selectionIn } from '@renderer/components/file-preview/comments/use-comment-box'
import type { SelectionAt } from '@renderer/components/file-preview/comments/kinds/types'
import { useOpenReply } from './use-message-replies'

interface MessageContextMenuProps {
  text: string
  children: React.ReactNode
  onRemove?: () => void
  /** Offered on a reply that can be read aloud: start it, or stop the reading in progress. */
  readAloud?: { active: boolean; onToggle: () => void }
  /** Offered when text in this message is selected: comment on it. */
  canReply?: boolean
}

function webLinkAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const anchor = target.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return null
  return anchor.protocol === 'http:' || anchor.protocol === 'https:' ? anchor.href : null
}

export function MessageContextMenu({ text, children, onRemove, readAloud, canReply = false }: MessageContextMenuProps) {
  const [linkHref, setLinkHref] = useState<string | null>(null)
  const openReply = useOpenReply()
  const [replySelection, setReplySelection] = useState<SelectionAt | null>(null)
  const replyOnClose = useRef(false)

  const handleCopy = async () => {
    try {
      const selection = window.getSelection()?.toString()
      await navigator.clipboard.writeText(selection || text)
    } catch (error) {
      console.error('Failed to copy message:', error)
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          setLinkHref(webLinkAt(event.target))
          setReplySelection(canReply && openReply ? selectionIn(event.currentTarget) : null)
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          if (!replyOnClose.current || !replySelection || !openReply) return
          // The menu hands focus back to the message as it closes; the reply box opens after, so its field keeps focus.
          replyOnClose.current = false
          event.preventDefault()
          openReply(replySelection)
        }}
      >
        {linkHref && (
          <ContextMenuItem onClick={() => void openExternalUrl(linkHref)} data-testid="context-open-link">
            <ExternalLink className="h-4 w-4 mr-2" />
            Open link in new tab
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={handleCopy}>
          <Copy className="h-4 w-4 mr-2" />
          Copy
        </ContextMenuItem>
        {readAloud && (
          <ContextMenuItem onClick={readAloud.onToggle} data-testid="context-read-aloud">
            {readAloud.active ? <Square className="h-4 w-4 mr-2 fill-current" /> : <Volume2 className="h-4 w-4 mr-2" />}
            {readAloud.active ? 'Stop reading' : 'Read aloud'}
          </ContextMenuItem>
        )}
        {replySelection && openReply && (
          <ContextMenuItem onClick={() => { replyOnClose.current = true }} data-testid="context-comment">
            <MessageSquarePlus className="h-4 w-4 mr-2" />
            Comment
          </ContextMenuItem>
        )}
        {onRemove && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Remove from history
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

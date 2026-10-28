import { useState } from 'react'
import { Copy, ExternalLink, Square, Trash2, Volume2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { openExternalUrl } from '@renderer/lib/open-external'

interface MessageContextMenuProps {
  text: string
  children: React.ReactNode
  onRemove?: () => void
  /** Offered on a reply that can be read aloud: start it, or stop the reading in progress. */
  readAloud?: { active: boolean; onToggle: () => void }
}

function webLinkAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const anchor = target.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return null
  return anchor.protocol === 'http:' || anchor.protocol === 'https:' ? anchor.href : null
}

export function MessageContextMenu({ text, children, onRemove, readAloud }: MessageContextMenuProps) {
  const [linkHref, setLinkHref] = useState<string | null>(null)

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
      <ContextMenuTrigger asChild onContextMenu={(event) => setLinkHref(webLinkAt(event.target))}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
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

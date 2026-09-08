
import { Copy, Square, Trash2, Volume2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'

interface MessageContextMenuProps {
  text: string
  children: React.ReactNode
  onRemove?: () => void
  /** Offered on a reply that can be read aloud: start it, or stop the reading in progress. */
  readAloud?: { active: boolean; onToggle: () => void }
}

export function MessageContextMenu({ text, children, onRemove, readAloud }: MessageContextMenuProps) {
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
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
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

import { MessageSquarePlus, RefreshCw } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'

interface DashboardFrameMenuProps {
  /** Where the dashboard was right-clicked, in frame CSS pixels; null when closed. */
  at: { x: number; y: number } | null
  onComment: (at: { x: number; y: number }) => void
  onRefresh: () => void
  onClose: () => void
}

/**
 * The app's menu for a right-click on a dashboard. The frame posts the click
 * (it already kept its own menu from showing), and the menu opens at that
 * spot over the frame.
 *
 * It closes without an exit animation: "Comment here" screenshots the frame
 * next, and the menu must be gone from it.
 */
export function DashboardFrameMenu({ at, onComment, onRefresh, onClose }: DashboardFrameMenuProps) {
  return (
    <DropdownMenu open={at !== null} onOpenChange={(open) => { if (!open) onClose() }} modal={false}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none absolute h-0 w-0"
          style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        className="data-[state=closed]:animate-none"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuItem onSelect={() => { if (at) onComment(at) }}>
          <MessageSquarePlus className="mr-2 h-4 w-4" />
          Comment here…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRefresh}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh dashboard
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

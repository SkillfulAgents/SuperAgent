import { createPortal } from 'react-dom'
import { Cloud } from 'lucide-react'
import { targetIsRemote } from '@renderer/lib/api-target'

/**
 * Marks the whole window while it is driving the cloud workspace.
 *
 * The switcher alone is not enough. Two windows of this app look identical, and
 * one of them is the organization's production Superagent — deleting an agent in
 * the wrong one is a quiet, expensive mistake. So cloud mode gets a persistent
 * frame the eye catches before the hand moves, not a state you have to go and
 * check.
 *
 * `pointer-events-none` throughout: it is a marker, never a target. That also
 * keeps it clear of the window's drag region and the native traffic lights,
 * which it visually overlaps.
 */
export function CloudModeIndicator() {
  if (!targetIsRemote()) return null

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[9998]"
      aria-hidden="true"
      data-testid="cloud-mode-indicator"
    >
      <div className="absolute inset-0 rounded-[inherit] ring-2 ring-inset ring-sky-500/70" />
      <div className="absolute inset-x-0 top-0 flex justify-center">
        <div className="flex items-center gap-1 rounded-b bg-sky-500 px-2 py-0.5 text-[10px] font-medium leading-none text-white shadow">
          <Cloud className="size-2.5" />
          Cloud workspace
        </div>
      </div>
    </div>,
    document.body,
  )
}

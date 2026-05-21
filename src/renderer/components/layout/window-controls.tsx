import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Minus, Square, Copy, X } from 'lucide-react'
import { isElectron, getPlatform } from '../../lib/env'

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false)

  const enabled = isElectron() && getPlatform() === 'win32'

  useEffect(() => {
    if (!enabled) return
    window.electronAPI?.getWindowMaximizedState().then(setIsMaximized)
    window.electronAPI?.onWindowMaximizedChange(setIsMaximized)
    return () => {
      window.electronAPI?.removeWindowMaximizedChange()
    }
  }, [enabled])

  if (!enabled) return null

  return createPortal(
    <div
      className="app-no-drag fixed top-2 right-2 z-[9999] flex h-12 items-center pointer-events-auto"
    >
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => window.electronAPI?.minimizeWindow()}
        className="app-no-drag flex h-12 w-12 items-center justify-center text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        onClick={() => window.electronAPI?.toggleMaximizeWindow()}
        className="app-no-drag flex h-12 w-12 items-center justify-center text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
      >
        {isMaximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => window.electronAPI?.closeWindow()}
        className="app-no-drag flex h-12 w-12 items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white transition-colors cursor-pointer"
      >
        <X className="size-4" />
      </button>
    </div>,
    document.body
  )
}

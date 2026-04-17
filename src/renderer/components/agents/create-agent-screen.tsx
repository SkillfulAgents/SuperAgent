import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { CreateAgentForm } from './create-agent-form'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

interface CreateAgentScreenProps {
  open: boolean
  onClose: () => void
  initialTemplate?: ApiDiscoverableAgent | null
}

// Items finish at 540ms (title: 180ms delay + 360ms); bg finishes at 600ms (350ms delay + 250ms).
const EXIT_DURATION_MS = 600

/**
 * Full-screen agent creation takeover used in the normal (post-onboarding) flow.
 * The onboarding wizard composes CreateAgentForm directly without this chrome.
 */
export function CreateAgentScreen({ open, onClose, initialTemplate }: CreateAgentScreenProps) {
  const isFullScreen = useFullScreen()
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !isFullScreen

  // Keep the screen mounted during the exit animation, then tell the parent we're done.
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
      setMounted(true)
      setExiting(false)
    } else if (mounted && !exiting) {
      setExiting(true)
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null
        setExiting(false)
        setMounted(false)
      }, EXIT_DURATION_MS)
    }
  }, [open, mounted, exiting])

  // Flip from hidden → visible on the first frame after mount.
  useEffect(() => {
    if (!mounted) { setRevealed(false); return }
    const raf = requestAnimationFrame(() => setRevealed(true))
    return () => cancelAnimationFrame(raf)
  }, [mounted])

  const beginClose = useCallback(() => {
    if (exiting) return
    setExiting(true)
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null
      setExiting(false)
      setMounted(false)
      onClose()
    }, EXIT_DURATION_MS)
  }, [exiting, onClose])

  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') beginClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mounted, beginClose])

  if (!mounted) return null

  const itemHidden = exiting || !revealed

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-background overflow-y-auto"
      style={{
        opacity: itemHidden ? 0 : 1,
        // Enter: snap bg in quickly so items stagger on top of a solid background.
        // Exit: wait for items to leave before fading the bg, so the stagger stays visible.
        transition: exiting
          ? 'opacity 250ms ease-in 350ms'
          : 'opacity 200ms ease-out',
      }}
      data-testid="create-agent-screen"
    >
      {isElectron() && <div className="absolute top-0 left-0 right-0 h-12 app-drag-region" />}

      <div
        className="mx-auto w-full max-w-[640px] px-6 py-10"
        style={{ paddingTop: needsTrafficLightPadding ? '64px' : undefined }}
      >
        <div className="space-y-8">
          <div
            className="create-agent-item flex items-center justify-between gap-4"
            data-hidden={itemHidden ? 'true' : 'false'}
            style={{ transitionDelay: exiting ? '180ms' : '0ms' }}
          >
            <h2 className="text-2xl font-normal app-no-drag">Create agent</h2>
            <button
              type="button"
              onClick={beginClose}
              aria-label="Close"
              data-testid="create-agent-close"
              className="app-no-drag inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
            >
              <X className="h-7 w-7" />
            </button>
          </div>
          <CreateAgentForm
            initialTemplate={initialTemplate}
            onAgentCreated={onClose}
            exiting={exiting}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}

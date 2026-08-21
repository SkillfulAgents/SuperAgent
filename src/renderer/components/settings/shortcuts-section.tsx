import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { getPlatform } from '@renderer/lib/env'
import {
  DEFAULT_GLOBAL_DISPATCH_SHORTCUT,
  eventToAccelerator,
  formatAccelerator,
} from '@shared/lib/config/shortcuts'
import { toast } from 'sonner'

// Shared with the General tab's other sections so this box looks native there.
const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

/**
 * The "Shortcuts" section of General settings (Electron-only). Currently just
 * the quick-dispatch launcher's global accelerator: an enable/disable toggle
 * plus a key-recorder. Empty accelerator = disabled.
 */
export function ShortcutsSection() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const platform = getPlatform() ?? ''

  const current = settings?.app?.globalDispatchShortcut ?? DEFAULT_GLOBAL_DISPATCH_SHORTCUT
  const enabled = current !== ''
  const [recording, setRecording] = useState(false)

  // Remember the last enabled accelerator so flipping the toggle back on
  // restores it (the empty-string "disabled" state can't carry it). Falls back
  // to the default when the launcher starts out disabled.
  const lastEnabledRef = useRef(enabled ? current : DEFAULT_GLOBAL_DISPATCH_SHORTCUT)
  if (enabled) lastEnabledRef.current = current

  // Register the accelerator with the main process FIRST (the authoritative
  // gate — it rejects conflicts), then persist it only if registration stuck,
  // so the saved value always matches what's actually bound.
  const applyShortcut = useCallback(
    async (accel: string) => {
      const result = await window.electronAPI?.setGlobalDispatchShortcut?.(accel)
      if (result && !result.success) {
        toast.error('Could not set shortcut', { description: result.error })
        return
      }
      try {
        await updateSettings.mutateAsync({ app: { globalDispatchShortcut: accel } })
        toast.success(accel === '' ? 'Launcher disabled' : 'Shortcut updated')
      } catch {
        toast.error('Failed to save shortcut')
      }
    },
    [updateSettings],
  )

  const handleToggle = useCallback(
    (next: boolean) => {
      if (recording) setRecording(false)
      void applyShortcut(next ? lastEnabledRef.current || DEFAULT_GLOBAL_DISPATCH_SHORTCUT : '')
    },
    [applyShortcut, recording],
  )

  // While recording, capture the next valid combo (Esc cancels).
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return // wait for a real key
      const accel = eventToAccelerator(e, platform)
      if (!accel) return
      setRecording(false)
      void applyShortcut(accel)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, platform, applyShortcut])

  return (
    <div className="space-y-2">
      <h3 className={SECTION_HEADING}>Shortcuts</h3>
      <div className={CARD_CLASS}>
        <div className="py-3 px-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate block">Quick Dispatch Launcher</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                Pop up a floating box from anywhere to dispatch an agent
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {enabled && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-w-[120px] font-mono text-xs"
                    onClick={() => setRecording((v) => !v)}
                    data-testid="dispatch-shortcut-record"
                  >
                    {recording ? 'Press keys…' : formatAccelerator(current, platform)}
                  </Button>
                  {current !== DEFAULT_GLOBAL_DISPATCH_SHORTCUT && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void applyShortcut(DEFAULT_GLOBAL_DISPATCH_SHORTCUT)}
                    >
                      Reset
                    </Button>
                  )}
                </>
              )}
              <Switch
                checked={enabled}
                onCheckedChange={handleToggle}
                aria-label="Enable Quick Dispatch launcher"
                data-testid="dispatch-shortcut-toggle"
              />
            </div>
          </div>
          {recording && (
            <div className="text-[11px] text-muted-foreground mt-2">
              Hold a modifier (⌘/Ctrl/⌥/⇧) and press a key. Esc to cancel.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, AtSign, ChevronDown, Cloud, Loader2, MousePointer2, Paperclip } from 'lucide-react'
import { cn } from '@shared/lib/utils'
import { targetIsRemote } from '@renderer/lib/api-target'
import { offersLauncherComputerUse } from '@renderer/lib/capabilities'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Button } from '@renderer/components/ui/button'
import { readLocalFileAsFile } from '@renderer/lib/read-local-file'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useNewSessionComposer } from '@renderer/hooks/use-new-session-composer'
import { AttachmentPreview } from '@renderer/components/messages/attachment-preview'
import { findCatalogModel } from '@renderer/components/messages/composer-options'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useIsVoiceConfigured } from '@renderer/hooks/use-voice-input'
import { UploadError } from '@renderer/components/ui/upload-error'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { toast } from 'sonner'
import { AgentMenu, AttachMenu, ModelEffortMenu } from './quick-dispatch-menus'
import { launcherHasGlass } from './launcher-glass'
import { QUICK_DISPATCH_GLASS_RADIUS } from '@shared/lib/quick-dispatch-glass'
import { EFFORT_LABELS } from '@renderer/components/messages/effort-slider'
import { SPEED_LABELS } from '@renderer/components/messages/speed-section'
import { ModelTooltip } from '@renderer/components/messages/model-tooltip'
import {
  MarkdownComposerEditor,
  selectAllMarkdownComposer,
} from '@renderer/components/messages/markdown-composer-editor'

type OpenMenu = 'agent' | 'model' | 'attach' | null

// Hard cap on a menu's scrollable height so the window never grows off-screen.
// Window ≈ input + footer + this ≈ 450px, which fits below the launcher's
// top anchor on any common display.
const MENU_MAX_HEIGHT = 300

function activityTime(a: ApiAgent): number {
  return a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0
}

/** The composer's chip for an attached file, by its name. */
function attachmentChip(name: string): HTMLElement | null {
  const chips = document.querySelectorAll<HTMLElement>('[data-testid="attachment-preview"]')
  return Array.from(chips).find((chip) => chip.dataset.attachmentName === name) ?? null
}

/** A borderless, floaty footer trigger that toggles an inline menu. */
function TriggerButton({
  active,
  onClick,
  children,
  testId,
  label,
  pressed,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  testId?: string
  /** For a button that shows only an icon. */
  label?: string
  /** For a toggle: whether it is on. */
  pressed?: boolean
}) {
  // On Liquid Glass: a capsule with a translucent fill instead of an opaque tile.
  const glass = launcherHasGlass()
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        'inline-flex h-[34px] max-w-[200px] items-center gap-1.5 px-2 text-xs font-medium',
        glass
          ? 'rounded-full hover:bg-[rgb(120_120_128/0.16)] dark:hover:bg-white/[0.12]'
          : 'rounded-md hover:bg-accent',
        active && (glass ? 'bg-[rgb(120_120_128/0.16)] dark:bg-white/[0.12]' : 'bg-accent'),
      )}
    >
      {children}
    </button>
  )
}

/**
 * The quick-dispatch launcher composer. Reuses the main app's composer logic —
 * useNewSessionComposer (uploads, voice, paste, mount dialog, model options)
 * — but renders its agent / model·effort / attachment pickers as INLINE,
 * full-width menus that grow the frameless window (Raycast-style) rather than
 * floating popovers, so the frosted panel is always filled. On submit it
 * creates a session via POST /api/agents/:slug/sessions and asks the main
 * process to raise the main window on the new session.
 */
export function QuickDispatch() {
  const { data: agents } = useAgents()
  const agentList = useMemo(() => (Array.isArray(agents) ? agents : []), [agents])
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(undefined)
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  // Whether a file is being dragged over the window (drives the drop overlay).
  const [dropActive, setDropActive] = useState(false)

  // Default to the most-recently-active agent once the list loads.
  useEffect(() => {
    if (selectedSlug || agentList.length === 0) return
    const mostRecent = [...agentList].sort((a, b) => activityTime(b) - activityTime(a))[0]
    setSelectedSlug(mostRecent?.slug)
  }, [agentList, selectedSlug])

  const selectedAgent = agentList.find((a) => a.slug === selectedSlug)
  const agentSlug = selectedSlug ?? ''
  const editorRef = useRef<HTMLDivElement | null>(null)

  // The computer-use toggle: the session may use any app without asking, and
  // a screenshot of the screen is attached. Off again every time the launcher
  // opens (see the reset below), so nothing is captured unless asked for.
  const computerUseOffered = useMemo(() => offersLauncherComputerUse(), [])
  const [computerUseOn, setComputerUseOn] = useState(false)
  // Bumped by every toggle and every reset: a capture that comes back to an
  // older generation was asked for by a toggle since undone.
  const captureGeneration = useRef(0)
  // The screenshot's file name while its chip is attached.
  const [screenshotName, setScreenshotName] = useState<string | null>(null)
  // A screenshot whose chip has rendered but not yet been landed on by the shutter.
  const [landing, setLanding] = useState<string | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const computerUse = useMemo(
    () => (computerUseOn ? { screenshotName: screenshotName ?? undefined } : undefined),
    [computerUseOn, screenshotName],
  )

  const { composer, composerOptions, isDisabled } = useNewSessionComposer({
    agentSlug,
    draftKey: 'quick-dispatch',
    computerUse,
    // Re-adopt defaults when the selected agent changes, then lock them while typing.
    waitForAgentDefaults: true,
    onSessionCreated: ({ agentSlug: dispatchedSlug, session }) => {
      // Hide the launcher and raise the main window on the new session.
      window.electronAPI?.quickDispatchDispatched?.({ agentSlug: dispatchedSlug, sessionId: session.id })
    },
    onError: (error) => {
      toast.error('Failed to dispatch', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    },
  })

  const selectedModel =
    findCatalogModel(composerOptions.model, composerOptions.catalog) ??
    findCatalogModel(composerOptions.defaultModel, composerOptions.catalog) ??
    composerOptions.catalog[0]
  const speedLabel: string | undefined = composerOptions.speed !== 'normal' ? SPEED_LABELS[composerOptions.speed] : undefined
  const modelDetail = `${EFFORT_LABELS[composerOptions.effort]}${speedLabel ? ` · ${speedLabel}` : ''}`

  // Refocus + select the input each time the launcher is re-shown (autoFocus
  // only fires on the first mount; the window is hidden, not destroyed).
  useEffect(() => {
    const unsub = window.electronAPI?.onQuickDispatchShown?.(() => {
      setOpenMenu(null)
      const el = editorRef.current
      if (el) {
        selectAllMarkdownComposer(el)
      }
    })
    return () => unsub?.()
  }, [])

  // Second global-shortcut press while the launcher is already open toggles
  // dictation (main sends `toggle-dictation` instead of hiding). Refs keep the
  // one-time listener reading the latest voice state + message.
  const voiceConfigured = useIsVoiceConfigured()
  const voiceRef = useRef(composer.voiceInput)
  voiceRef.current = composer.voiceInput
  const messageRef = useRef(composer.message)
  messageRef.current = composer.message
  const voiceConfiguredRef = useRef(voiceConfigured)
  voiceConfiguredRef.current = voiceConfigured
  useEffect(() => {
    const unsub = window.electronAPI?.onQuickDispatchToggleDictation?.(() => {
      const vi = voiceRef.current
      if (vi.isRecording || vi.isConnecting) {
        vi.stopRecording()
      } else if (voiceConfiguredRef.current && !vi.isFinalizing) {
        void vi.startRecording(messageRef.current)
      }
    })
    return () => unsub?.()
  }, [])

  // Files dropped on the app's dock icon (macOS `open-file`) open the launcher
  // with that file attached. Main QUEUES the path; the renderer PULLS it — both
  // on mount (catches files queued before this listener existed, i.e. cold
  // launch) and on the `attach-pending` ping (already-open case). Read each path
  // into a File via the same route the recent-files menu uses. Ref keeps the
  // handlers on the latest `addFiles`.
  const addFilesRef = useRef(composer.addFiles)
  addFilesRef.current = composer.addFiles
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    const attachPath = async (filePath: string) => {
      const file = await readLocalFileAsFile(filePath)
      if (file) {
        addFilesRef.current([{ file }])
      }
    }
    const drain = async () => {
      const paths = (await api.quickDispatchDrainAttach?.()) ?? []
      for (const p of paths) await attachPath(p)
    }
    void drain() // cold launch: catch anything queued before mount
    const unsub = api.onQuickDispatchAttachPending?.(() => void drain()) // warm: ping
    return () => unsub?.()
  }, [])

  // The panel is hidden (not destroyed) between uses, so transient state would
  // otherwise linger into the next open. When main reports the hide (Esc, blur,
  // post-dispatch), clear attachments AND stop any in-flight dictation — an
  // active mic mustn't keep recording after the window is dismissed.
  const clearAttachmentsRef = useRef(composer.clearAttachments)
  clearAttachmentsRef.current = composer.clearAttachments
  useEffect(() => {
    const unsub = window.electronAPI?.onQuickDispatchReset?.(() => {
      clearAttachmentsRef.current()
      captureGeneration.current++
      setComputerUseOn(false)
      setScreenshotName(null)
      setLanding(null)
      setCaptureError(null)
      const vi = voiceRef.current
      if (vi.isRecording || vi.isConnecting) void vi.stopRecording()
      vi.clearError()
    })
    return () => unsub?.()
  }, [])

  // A screenshot the person removed from the composer no longer stands for the screen.
  useEffect(() => {
    if (screenshotName && !composer.attachments.some((a) => a.type === 'file' && a.file.name === screenshotName)) {
      setScreenshotName(null)
    }
  }, [composer.attachments, screenshotName])

  const toggleComputerUse = async () => {
    setOpenMenu(null)
    setCaptureError(null)
    const generation = ++captureGeneration.current
    if (computerUseOn) {
      setComputerUseOn(false)
      const shot = composer.attachments.find((a) => a.type === 'file' && a.file.name === screenshotName)
      if (shot) composer.removeAttachment(shot.id)
      setScreenshotName(null)
      return
    }
    setComputerUseOn(true)
    const result = await window.electronAPI?.quickDispatchCaptureScreen?.().catch(() => null)
    // Turned off, or the launcher closed, while the capture ran.
    if (generation !== captureGeneration.current) {
      window.electronAPI?.quickDispatchCaptureTarget?.(null)
      return
    }
    if (!result?.ok) {
      // The toggle stays on: the agent may still use the computer, it just has no picture of it.
      setCaptureError(result?.reason === 'permission'
        ? 'No screenshot: turn on Gamut in System Settings › Privacy & Security › Screen & System Audio Recording.'
        : 'Couldn’t take a screenshot of your screen.')
      return
    }
    composer.addFiles([{ file: new File([result.png], result.name, { type: 'image/png' }) }])
    setScreenshotName(result.name)
    setLanding(result.name)
  }

  // Once the screenshot's chip has rendered: hide it and tell main where it is.
  // The shutter flies the picture onto it, then main says it landed and the
  // chip shows again. A chip that hasn't rendered yet is looked for again on
  // the next attachments change; main gives up waiting on its own.
  const landingRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!landing || landingRef.current === landing) return
    const chip = attachmentChip(landing)
    if (!chip) return
    landingRef.current = landing
    chip.style.transition = 'opacity 150ms ease-out'
    chip.style.opacity = '0'
    const rect = chip.getBoundingClientRect()
    window.electronAPI?.quickDispatchCaptureTarget?.({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  }, [landing, composer.attachments])
  useEffect(() => {
    const unsub = window.electronAPI?.onQuickDispatchCaptureLanded?.(() => {
      const name = landingRef.current
      landingRef.current = null
      setLanding(null)
      const chip = name ? attachmentChip(name) : null
      if (chip) chip.style.opacity = ''
    })
    return () => unsub?.()
  }, [])

  // Esc closes an open menu first, otherwise dismisses the launcher. Let an open
  // Radix dialog/popover (e.g. the mount-choice dialog) consume Esc itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"]')) return
      if (openMenu) setOpenMenu(null)
      else window.electronAPI?.quickDispatchClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openMenu])

  // File drop is handled by root-level React handlers on the panel (see the
  // return below). The panel is NO LONGER a `-webkit-app-region: drag` region:
  // macOS treats drag regions as window chrome and passes file drags THROUGH to
  // the window behind, so a drag region and file-drop are mutually exclusive.
  // (Window dragging is reintroduced separately, via JS, not CSS drag regions.)
  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropActive(true)
  }, [])
  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    // Ignore dragleave fired while crossing between inner elements — only clear
    // when the pointer actually leaves the panel.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false)
  }, [])
  const handlePanelDrop = useCallback(
    (e: React.DragEvent) => {
      setDropActive(false)
      composer.dragHandlers.onDrop(e)
    },
    [composer],
  )

  // Drag-to-move the frameless window from any non-interactive part of the panel.
  // Done in JS (mousedown → IPC setPosition) rather than a `-webkit-app-region:
  // drag` region, because a CSS drag region is inert to file drops — the two are
  // mutually exclusive, and drops win. rAF-throttled so we don't flood IPC.
  const handleWindowDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Never start a window-drag from controls, text fields, or the menus.
    if ((e.target as HTMLElement).closest('button, input, textarea, a, [contenteditable="true"], [data-no-window-drag]')) return
    const startX = e.screenX
    const startY = e.screenY
    window.electronAPI?.quickDispatchDragStart?.()
    let raf = 0
    let pending: { dx: number; dy: number } | null = null
    const flush = () => {
      raf = 0
      if (pending) window.electronAPI?.quickDispatchDragMove?.(pending)
    }
    const onMove = (ev: MouseEvent) => {
      pending = { dx: ev.screenX - startX, dy: ev.screenY - startY }
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const onUp = () => {
      if (raf) cancelAnimationFrame(raf)
      window.electronAPI?.quickDispatchDragEnd?.()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Suppress the main-process blur-to-hide while a native file picker is open
  // (clicking a hidden <input type=file> blurs the window). Cleared when focus
  // returns to the launcher.
  useEffect(() => {
    const onPickerClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target instanceof HTMLInputElement && target.type === 'file') {
        window.electronAPI?.quickDispatchSetModal?.(true)
      }
    }
    const onFocus = () => window.electronAPI?.quickDispatchSetModal?.(false)
    document.addEventListener('click', onPickerClick, true)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('click', onPickerClick, true)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const toggleMenu = (menu: Exclude<OpenMenu, null>) =>
    setOpenMenu((prev) => (prev === menu ? null : menu))

  const handleKeyDown = (e: KeyboardEvent) => {
    // Enter (and ⌘/Ctrl+Enter) dispatches; Shift+Enter inserts a newline.
    // Matches the main app's composer (submit on `Enter && !shiftKey`).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!composer.canSubmit) return
      void composer.handleSubmit(e)
    }
  }

  // The launcher resolves the same target as the main window, so a global-
  // shortcut dispatch can create a session on the organization's Superagent from
  // a panel that otherwise looks exactly like the local one. It needs its own
  // marker: the main window says which Superagent it is driving through the
  // switcher in its title bar, and this panel has no title bar to put one in.
  const cloudMode = targetIsRemote()
  // macOS 26+: the main process draws Liquid Glass behind the window. The card
  // takes the glass's corner radius and drops its hairline ring (the glass lights
  // its own edge); the cloud marker ring stays.
  const glass = launcherHasGlass()
  const glassRadius = glass ? { borderRadius: QUICK_DISPATCH_GLASS_RADIUS } : undefined

  return (
    // The window IS the panel (Raycast-style): one frosted, edge-to-edge rounded
    // surface. bg-transparent lets the native window vibrancy show through. The
    // panel is a real drop target (root-level drag handlers) — NOT a CSS drag
    // region, which would pass file drags through to the window behind.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- onMouseDown here is a pointer-only window-drag gesture (frameless move); it has no meaningful keyboard equivalent and exposes no interactive control.
    <div
      data-testid="quick-dispatch"
      className={cn(
        'relative flex flex-col overflow-hidden bg-transparent',
        !glass && 'rounded-[12px] ring-1 ring-foreground/10',
        cloudMode && 'ring-2 ring-sky-500/70',
      )}
      style={glassRadius}
      onMouseDown={handleWindowDragStart}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      {/* Cloud marker: the panel's whole width, above the input, so it is read
          before anything is typed. Carries no handlers, which also leaves it a
          drag surface for the frameless window. */}
      {cloudMode && (
        <div
          className="flex items-center justify-center gap-1 bg-sky-500 py-0.5 text-[10px] font-medium leading-none text-white"
          data-testid="quick-dispatch-cloud-mode"
        >
          <Cloud className="size-2.5" />
          Cloud workspace
        </div>
      )}
      <MountChoiceDialog
        open={composer.mountDialog.open}
        onChoice={composer.mountDialog.onChoice}
        folderName={composer.mountDialog.folderName}
      />
      {composer.chipDialog}
      <form onSubmit={composer.handleSubmit}>
        {/* Input row — large, borderless, full-width like Raycast's search
            field. File drops are handled at the panel root (any file dragged
            anywhere over the window attaches here). */}
        <div
          className="px-4 pt-3.5 pb-2.5"
          onPaste={composer.handlePaste}
          onFocus={() => setOpenMenu(null)}
        >
          {composer.attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentPreview attachments={composer.attachments} onRemove={composer.removeAttachment} onRetry={composer.retryAttachment} />
            </div>
          )}
          <MarkdownComposerEditor
            value={composer.message}
            onChange={composer.setMessage}
            onKeyDown={handleKeyDown}
            chipContext={composer.chipContext}
            // The launcher grows its own inline menus; a picker would open outside the window.
            pickers={false}
            placeholder={computerUseOn
              ? `What should ${selectedAgent?.name ?? 'the agent'} do on your screen?`
              : selectedAgent ? `Dispatch ${selectedAgent.name}…` : 'Dispatch an agent…'}
            disabled={isDisabled}
            minRows={1}
            autoFocus
            dataTestId="quick-dispatch-input"
            enterKeyHint="send"
            className="max-h-[200px] w-full bg-transparent text-[15px] leading-relaxed outline-none"
            onEditorElement={(element) => { editorRef.current = element }}
          />
        </div>

        {/* Footer toolbar. The pickers are inline menus (below) rather than
            popovers, so the window grows to fit them. */}
        <div className="flex items-center gap-1 px-3 py-2">
          <TriggerButton active={openMenu === 'agent'} onClick={() => toggleMenu('agent')} testId="quick-dispatch-agent-trigger">
            <AtSign className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{selectedAgent?.name ?? 'Select agent'}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </TriggerButton>
          <TriggerButton active={openMenu === 'attach'} onClick={() => toggleMenu('attach')} testId="quick-dispatch-attach-trigger">
            <Paperclip className="h-3.5 w-3.5 shrink-0" />
          </TriggerButton>
          {computerUseOffered && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* TriggerButton does not forward a ref, so the tooltip anchors to this wrapper.
                      Pointing at it (or tabbing to it) gets the shutter ready, so the click answers at once. */}
                  <span
                    className="inline-flex"
                    onPointerEnter={() => { if (!computerUseOn) window.electronAPI?.quickDispatchCapturePrepare?.() }}
                    onFocus={() => { if (!computerUseOn) window.electronAPI?.quickDispatchCapturePrepare?.() }}
                  >
                    <TriggerButton
                      active={computerUseOn}
                      pressed={computerUseOn}
                      onClick={() => void toggleComputerUse()}
                      testId="quick-dispatch-computer-use"
                      label="Use this computer"
                    >
                      <MousePointer2 className={cn('h-3.5 w-3.5 shrink-0', computerUseOn && 'fill-current text-primary')} />
                    </TriggerButton>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-60">
                  {computerUseOn
                    ? 'Computer use is on: the agent can use any app without asking, and sees your screen.'
                    : 'Use this computer: attach a screenshot and let the agent use any app without asking.'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <ModelTooltip line={selectedModel ? `${selectedModel.label} · ${modelDetail}` : undefined} connection={composerOptions.connections?.find(c => c.id === composerOptions.llmProviderId)}>
            {/* TriggerButton does not forward a ref, so the tooltip anchors to this wrapper. */}
            <span className="inline-flex min-w-0">
              <TriggerButton active={openMenu === 'model'} onClick={() => toggleMenu('model')} testId="composer-options-trigger">
                <span className="truncate">
                  {selectedModel?.label}
                  <span className="text-muted-foreground">
                    {selectedModel?.label ? ' · ' : ''}{modelDetail}
                  </span>
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </TriggerButton>
            </span>
          </ModelTooltip>
          <div className="ml-auto flex items-center gap-2">
            <span className="inline-flex">
              <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} glass={glass} />
            </span>
            <Button
              type="submit"
              size="icon"
              className={cn('h-[34px] w-[34px]', glass && 'rounded-full')}
              disabled={!composer.canSubmit}
              data-testid="quick-dispatch-send"
              aria-label="Dispatch agent"
            >
              {isDisabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Inline, full-width menu — grows the window so the frosted area is
            filled by the menu (never an empty frosted gap). pb keeps the list
            off the window's rounded bottom edge. */}
        {openMenu && (
          <div className="pb-3" data-no-window-drag>
            {openMenu === 'agent' && (
              <AgentMenu
                agents={agentList}
                selectedSlug={selectedSlug}
                maxHeight={MENU_MAX_HEIGHT}
                onSelect={(slug) => {
                  setSelectedSlug(slug)
                  setOpenMenu(null)
                }}
              />
            )}
            {openMenu === 'model' && <ModelEffortMenu state={composerOptions} maxHeight={MENU_MAX_HEIGHT} />}
            {openMenu === 'attach' && (
              <AttachMenu
                onFileSelect={(e) => {
                  composer.handleFileSelect(e)
                  setOpenMenu(null)
                }}
                onFolderSelect={(e) => {
                  composer.handleFolderSelect(e)
                  setOpenMenu(null)
                }}
                onRecentFileAttach={(file) => {
                  composer.addFiles([{ file }])
                  setOpenMenu(null)
                }}
              />
            )}
          </div>
        )}

        {(composer.voiceInput.error || composer.uploadError || captureError) && (
          <div className="px-4 pb-2">
            <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} />
            <UploadError error={composer.uploadError} onDismiss={composer.clearUploadError} />
            <UploadError error={captureError} onDismiss={() => setCaptureError(null)} />
          </div>
        )}
      </form>

      {/* Drag-over affordance — a pure visual. The actual drop is caught by the
          panel root's handlers, so this stays `pointer-events-none` and never
          intercepts events. Mounted only while a file is being dragged over. */}
      {dropActive && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-primary/60 bg-background/80',
            !glass && 'rounded-[12px]',
          )}
          style={glassRadius}
          data-testid="quick-dispatch-dropzone"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Paperclip className="h-4 w-4" />
            Drop files to attach
          </div>
        </div>
      )}
    </div>
  )
}

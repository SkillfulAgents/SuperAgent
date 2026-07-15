import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, AtSign, ChevronDown, Loader2, Paperclip } from 'lucide-react'
import { cn } from '@shared/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { apiFetch } from '@renderer/lib/api'
import { uploadFileChunked } from '@renderer/lib/upload'
import { readLocalFileAsFile } from '@renderer/lib/read-local-file'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { AttachmentPreview } from '@renderer/components/messages/attachment-preview'
import { findCatalogModel, useComposerOptions } from '@renderer/components/messages/composer-options'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useIsVoiceConfigured } from '@renderer/hooks/use-voice-input'
import { UploadError } from '@renderer/components/ui/upload-error'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { toast } from 'sonner'
import { AgentMenu, AttachMenu, ModelEffortMenu } from './quick-dispatch-menus'
import { EFFORT_LABELS } from '@renderer/components/messages/effort-slider'

type OpenMenu = 'agent' | 'model' | 'attach' | null

// Hard cap on a menu's scrollable height so the window never grows off-screen.
// Window ≈ input + footer + this ≈ 450px, which fits below the launcher's
// top anchor on any common display.
const MENU_MAX_HEIGHT = 300

function activityTime(a: ApiAgent): number {
  return a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0
}

/** A borderless, floaty footer trigger that toggles an inline menu. */
function TriggerButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-[34px] max-w-[200px] items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-accent',
        active && 'bg-accent',
      )}
    >
      {children}
    </button>
  )
}

/**
 * The quick-dispatch launcher composer. Reuses the main app's composer logic —
 * useMessageComposer (uploads, voice, paste, mount dialog) + useComposerOptions
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
  // An untouched model/effort selection follows the selected agent's defaults:
  // agentKey re-adopts on switch, then adoption locks so background preference
  // edits can't swap the selection while the user types.
  const { data: agentPrefs, isFetched: agentPrefsFetched } = useAgentPreferences(agentSlug)
  const composerOptions = useComposerOptions({
    agentDefaultModel: agentPrefs?.defaultModel,
    agentDefaultEffort: agentPrefs?.defaultEffort,
    agentDefaultSpeed: agentPrefs?.defaultSpeed,
    agentKey: agentSlug,
    agentDefaultsReady: agentPrefsFetched,
  })
  const createSession = useCreateSession()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const selectedModel =
    findCatalogModel(composerOptions.model, composerOptions.catalog) ??
    composerOptions.catalog.find((m) => m.family === 'sonnet' && m.isLatest) ??
    composerOptions.catalog[0]

  const composer = useMessageComposer({
    agentSlug,
    uploadFile: useCallback(
      ({ file }: { file: File }) =>
        uploadFileChunked<{ path: string }>({ url: `/api/agents/${agentSlug}/upload-file`, file }),
      [agentSlug],
    ),
    uploadFolder: useCallback(
      async ({ sourcePath }: { sourcePath: string }) => {
        const res = await apiFetch(`/api/agents/${agentSlug}/upload-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath }),
        })
        if (!res.ok) throw new Error('Failed to upload folder')
        return res.json() as Promise<{ path: string }>
      },
      [agentSlug],
    ),
    onSubmit: useCallback(
      async (content: string) => {
        if (!selectedSlug) return
        try {
          const session = await createSession.mutateAsync({
            agentSlug: selectedSlug,
            message: content,
            ...composerOptions.toRuntimeOptions(),
          })
          // Hand off to the main process: hide the launcher and raise the main
          // window on the brand-new session.
          window.electronAPI?.quickDispatchDispatched?.({
            agentSlug: selectedSlug,
            sessionId: session.id,
          })
        } catch (error) {
          toast.error('Failed to dispatch', {
            description: error instanceof Error ? error.message : 'Please try again.',
          })
          throw error // let useMessageComposer restore the message
        }
      },
      [selectedSlug, createSession, composerOptions],
    ),
    submitDisabled: createSession.isPending || !selectedSlug,
    // Keep the typed message in the (disabled) input while the dispatch is in
    // flight, instead of clearing it up front — seeing your text vanish mid-send
    // is unnerving. It clears once the session is created, or stays on failure.
    keepMessageUntilComplete: true,
    draftKey: 'quick-dispatch',
  })

  // Refocus + select the input each time the launcher is re-shown (autoFocus
  // only fires on the first mount; the window is hidden, not destroyed).
  useEffect(() => {
    const unsub = window.electronAPI?.onQuickDispatchShown?.(() => {
      setOpenMenu(null)
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.select()
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
      const vi = voiceRef.current
      if (vi.isRecording || vi.isConnecting) void vi.stopRecording()
      vi.clearError()
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
    if ((e.target as HTMLElement).closest('button, input, textarea, a, [data-no-window-drag]')) return
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter (and ⌘/Ctrl+Enter) dispatches; Shift+Enter inserts a newline.
    // Matches the main app's composer (submit on `Enter && !shiftKey`).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      composer.handleSubmit(e)
    }
  }

  const isDisabled = createSession.isPending || composer.isUploading || !selectedSlug

  return (
    // The window IS the panel (Raycast-style): one frosted, edge-to-edge rounded
    // surface. bg-transparent lets the native window vibrancy show through. The
    // panel is a real drop target (root-level drag handlers) — NOT a CSS drag
    // region, which would pass file drags through to the window behind.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- onMouseDown here is a pointer-only window-drag gesture (frameless move); it has no meaningful keyboard equivalent and exposes no interactive control.
    <div
      data-testid="quick-dispatch"
      className="relative flex flex-col overflow-hidden rounded-[12px] bg-transparent ring-1 ring-foreground/10"
      onMouseDown={handleWindowDragStart}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      <MountChoiceDialog
        open={composer.mountDialog.open}
        onChoice={composer.mountDialog.onChoice}
        folderName={composer.mountDialog.folderName}
      />
      <form onSubmit={composer.handleSubmit}>
        {/* Input row — large, borderless, full-width like Raycast's search
            field. File drops are handled at the panel root (any file dragged
            anywhere over the window attaches here). */}
        <div className="px-4 pt-3.5 pb-2.5">
          {composer.attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentPreview attachments={composer.attachments} onRemove={composer.removeAttachment} />
            </div>
          )}
          <textarea
            ref={textareaRef}
            dir="auto"
            value={composer.message}
            onChange={(e) => composer.setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={composer.handlePaste}
            onFocus={() => setOpenMenu(null)}
            placeholder={selectedAgent ? `Dispatch ${selectedAgent.name}…` : 'Dispatch an agent…'}
            disabled={isDisabled}
            rows={1}
            autoFocus
            data-testid="quick-dispatch-input"
            className="max-h-[200px] w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/70 disabled:opacity-60"
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
          <TriggerButton active={openMenu === 'model'} onClick={() => toggleMenu('model')} testId="composer-options-trigger">
            {selectedModel && <ModelIcon icon={selectedModel.icon} className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">
              {selectedModel?.label}
              <span className="text-muted-foreground">
                {selectedModel?.label ? ' · ' : ''}{EFFORT_LABELS[composerOptions.effort]}
              </span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </TriggerButton>
          <div className="ml-auto flex items-center gap-2">
            <span className="inline-flex">
              <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
            </span>
            <Button
              type="submit"
              size="icon"
              className="h-[34px] w-[34px]"
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

        {(composer.voiceInput.error || composer.uploadError) && (
          <div className="px-4 pb-2">
            <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} />
            <UploadError error={composer.uploadError} onDismiss={composer.clearUploadError} />
          </div>
        )}
      </form>

      {/* Drag-over affordance — a pure visual. The actual drop is caught by the
          panel root's handlers, so this stays `pointer-events-none` and never
          intercepts events. Mounted only while a file is being dragged over. */}
      {dropActive && (
        <div
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-[12px] border-2 border-dashed border-primary/60 bg-background/80"
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

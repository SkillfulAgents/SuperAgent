import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Archive, ChevronDown, Maximize2, Minimize2, Play, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@shared/lib/utils/cn'
import { deriveTodoTitle, TODO_TITLE_MAX, type TodoAttachment } from '@shared/lib/todos/todo-schema'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { AttachmentPreview, type Attachment, type FileAttachment, type FolderAttachment } from '@renderer/components/messages/attachment-preview'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { uploadFileChunked } from '@renderer/lib/upload'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { folderChoice, type FolderGroup } from '@renderer/lib/file-utils'
import { MarkdownComposerEditor } from '@renderer/components/messages/markdown-composer-editor'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useAttachments } from '@renderer/hooks/use-attachments'
import { useUploadFolder } from '@renderer/hooks/use-messages'
import { useUploadQueue } from '@renderer/hooks/use-upload-queue'
import { useVoiceInput } from '@renderer/hooks/use-voice-input'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { ComposerOptions, useComposerOptions } from '@renderer/components/messages/composer-options'
import { AgentDefaultFooter } from '@renderer/components/messages/agent-default-footer'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import {
  useCreateTodo,
  useDeleteTodo,
  useRemoveTodoAttachment,
  useSaveTodoPointer,
  useSetTodoStatus,
  useStartTodo,
  useStartingTodoIds,
  useUpdateTodo,
  type TodoView,
} from '@renderer/hooks/use-todos'
import { MOD, ShortcutTooltip } from './todo-shortcuts'
import { AgentDropdown } from '@renderer/components/agents/agent-dropdown'
import { useTodoAgents } from './todo-shared'

/** Which draft the dialog shows: a new one (not saved until there is something in it) or a saved one. */
export type TodoDraftTarget = { kind: 'new' } | { kind: 'existing'; todo: TodoView }

interface DraftFields {
  title: string
  description: string
  agentSlug: string | null
  /** Give it to an agent created for it when it starts. */
  newAgent: boolean
  /** What was picked over the agent's defaults. */
  model: string | null
  llmProviderId: string | null
  effort: EffortLevel | null
  speed: SpeedLevel | null
}

/** The model picker's agent identity while "New Agent" is chosen: no agent defaults apply. */
const NEW_AGENT_KEY = '\u0000new-agent'

const SAVE_DELAY_MS = 600
const PICK_AGENT_TO_ATTACH = 'Pick an agent to attach files'
const WAIT_FOR_UPLOADS = 'Wait for uploads to finish to change the agent'

function heldChip(att: TodoAttachment): Attachment {
  if (att.kind === 'mount' && att.hostPath) {
    return { type: 'mount', id: att.id, folderName: att.name, hostPath: att.hostPath }
  }
  return {
    type: 'saved',
    id: att.id,
    name: att.name,
    size: att.size,
    mimeType: att.mimeType,
    kind: att.kind === 'folder' ? 'folder' : 'file',
  }
}

/**
 * A failed save or status change is a failed mutation, which the app's
 * global mutation handler has already toasted; the dialog only stops there.
 */
function failed() {}

const sameFields = (a: DraftFields, b: DraftFields) =>
  a.title === b.title && a.description === b.description && a.agentSlug === b.agentSlug &&
  a.newAgent === b.newAgent && a.model === b.model && a.llmProviderId === b.llmProviderId &&
  a.effort === b.effort && a.speed === b.speed

/** What a save sends for the form. */
const payload = (f: DraftFields) => ({
  title: f.title.trim(),
  description: f.description,
  agentSlug: f.agentSlug,
  newAgent: f.newAgent,
  model: f.model,
  llmProviderId: f.llmProviderId,
  effort: f.effort,
  speed: f.speed,
})

/**
 * The draft dialog: a title, a Markdown description, the agent to give it
 * to (or a new one) and the model to run it on, with Start in the corner. Edits save shortly after typing stops and
 * again on close, so closing always keeps the draft; a new draft is only
 * created once something has been written in it.
 */
export function TodoDraftDialog({ target, onClose }: {
  target: TodoDraftTarget | null
  onClose: () => void
}) {
  // Expanded is a taller, slightly wider box for a long brief. Both states set
  // explicit sizes so the change tweens instead of snapping from `auto`.
  const [expanded, setExpanded] = useState(false)
  const formKey = target?.kind === 'existing' ? target.todo.id : 'new'
  const flushCloseRef = useRef<() => void>(() => onClose())
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && flushCloseRef.current()}>
      <DialogContent
        className={cn(
          // Flex, not the base grid: a grid track sizes to its content, so the
          // body could never shrink to the box and spilled out of it.
          'flex flex-col gap-0 overflow-hidden p-0 transition-[height,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none sm:rounded-2xl',
          expanded ? 'h-[70vh] max-w-4xl' : 'h-[340px] max-w-3xl',
        )}
        hideClose
        onOpenAutoFocus={(e) => {
          // Land in the title, not on the first button.
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-testid="todo-draft-title"]')?.focus()
        }}
        data-testid="todo-draft-dialog"
      >
        {target && (
          <DraftForm
            key={formKey}
            initial={target.kind === 'existing' ? target.todo : null}
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
            onClose={onClose}
            flushCloseRef={flushCloseRef}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DraftForm({ initial, expanded, onToggleExpand, onClose, flushCloseRef }: {
  initial: TodoView | null
  expanded: boolean
  onToggleExpand: () => void
  onClose: () => void
  flushCloseRef: MutableRefObject<() => void>
}) {
  const { bySlug } = useTodoAgents()
  const createTodo = useCreateTodo()
  const updateTodo = useUpdateTodo()
  const deleteTodo = useDeleteTodo()
  const setTodoStatus = useSetTodoStatus()
  const startTodo = useStartTodo()
  // A draft opened from the board is never mid-start (its card doesn't open
  // then), but its start may begin elsewhere while this is open.
  const alreadyStarting = useStartingTodoIds().has(initial?.id ?? '')

  const [fields, setFields] = useState<DraftFields>(() => ({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    agentSlug: initial?.agentSlug ?? null,
    newAgent: initial?.newAgent ?? false,
    model: initial?.model ?? null,
    llmProviderId: initial?.llmProviderId ?? null,
    effort: initial?.effort ?? null,
    speed: initial?.speed ?? null,
  }))
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields

  // What the server has, so a save only sends a change.
  const idRef = useRef<string | null>(initial?.id ?? null)
  const savedRef = useRef<DraftFields | null>(initial ? { ...fields } : null)
  // Saves run one at a time, each comparing against what the one before it
  // actually stored: a save that started while another was in flight would
  // compare against stale state and could skip a change (typing B, then back
  // to A before B's save lands, would leave B on the server).
  const savingRef = useRef<Promise<unknown>>(Promise.resolve())
  const timerRef = useRef<number | null>(null)

  /** Brings the server up to date with the form. Resolves with the draft's id, or null when there is nothing to keep. */
  const save = useCallback((opts?: { createIfEmpty?: boolean }): Promise<string | null> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const saveNow = async (): Promise<string | null> => {
      // Read the form when this save's turn comes, not when it was queued.
      const current = fieldsRef.current
      const id = idRef.current
      if (!id) {
        if (!current.title.trim() && !current.description.trim() && !opts?.createIfEmpty) return null
        const todo = await createTodo.mutateAsync(payload(current))
        idRef.current = todo.id
        savedRef.current = current
        return todo.id
      }
      if (savedRef.current && sameFields(savedRef.current, current)) return id
      await updateTodo.mutateAsync({ id, ...payload(current) })
      savedRef.current = current
      return id
    }
    const run = savingRef.current.then(saveNow, saveNow)
    savingRef.current = run.catch(() => {})
    return run
  // The mutateAsync functions are stable; the mutation objects are not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createTodo.mutateAsync, updateTodo.mutateAsync])

  const change = (patch: Partial<DraftFields>) => {
    // The ref moves now, not on the next render, so a save right after sees the change.
    fieldsRef.current = { ...fieldsRef.current, ...patch }
    setFields(fieldsRef.current)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    if (patch.agentSlug !== undefined) {
      timerRef.current = null
      // The server copies the files over or refuses. Refused, the old agent is still the draft's.
      void save().catch(() => {
        const saved = savedRef.current
        if (saved) {
          fieldsRef.current = { ...fieldsRef.current, agentSlug: saved.agentSlug }
          setFields(fieldsRef.current)
        }
        failed()
      })
      return
    }
    timerRef.current = window.setTimeout(() => void save().catch(failed), SAVE_DELAY_MS)
  }

  // Leaving saves what is left unsaved, however the dialog closes.
  const saveRef = useRef(save)
  saveRef.current = save
  const flushedRef = useRef(false)
  const closingRef = useRef(false)
  useEffect(() => () => { if (!flushedRef.current) void saveRef.current().catch(failed) }, [])

  const savePointer = useSaveTodoPointer()
  const uploadFolder = useUploadFolder()
  const removeHeld = useRemoveTodoAttachment()
  const enqueueRef = useRef<(item: FileAttachment | FolderAttachment) => void>(() => {})
  const [pendingFolders, setPendingFolders] = useState<FolderGroup[]>([])
  const files = useAttachments({
    initialAttachments: (initial?.attachments ?? []).map(heldChip),
    onFoldersReceived: (folders) => receiveFolders(folders),
    onAttachmentsAdded: (added) => {
      for (const item of added) if (item.type === 'file' || item.type === 'folder') enqueueRef.current(item)
    },
  })
  const attachmentsRef = useRef<Attachment[]>(files.attachments)
  attachmentsRef.current = files.attachments
  const ensureDraft = async () => {
    if (!fieldsRef.current.agentSlug) throw new Error('Pick an agent')
    if (!idRef.current) await saveRef.current({ createIfEmpty: true })
    const id = idRef.current
    if (!id) throw new Error('Draft is not saved')
    return id
  }
  const queue = useUploadQueue({
    agentSlug: fields.agentSlug ?? '',
    attachmentsRef,
    updateAttachment: files.updateAttachment,
    removeAttachment: files.removeAttachment,
    clearAttachments: files.clearAttachments,
    uploadFile: async ({ file, attachmentId, onProgress, signal, stallMs }) => {
      const slug = fieldsRef.current.agentSlug
      if (!slug) throw new Error('Pick an agent')
      await ensureDraft()
      const uploaded = await uploadFileChunked<{ path: string }>({
        url: `/api/agents/${slug}/upload-file`,
        file,
        onProgress,
        signal,
        stallMs,
      })
      const id = await ensureDraft()
      await savePointer.mutateAsync({
        id,
        pointer: { id: attachmentId, name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', path: uploaded.path },
      })
      return { path: uploaded.path }
    },
    uploadFolder: async ({ sourcePath, attachmentId }) => {
      const slug = fieldsRef.current.agentSlug
      if (!slug) throw new Error('Pick an agent')
      await ensureDraft()
      const uploaded = await uploadFolder.mutateAsync({ agentSlug: slug, sourcePath })
      const id = await ensureDraft()
      await savePointer.mutateAsync({
        id,
        pointer: { id: attachmentId, name: uploaded.folderName, size: 0, mimeType: 'inode/directory', path: uploaded.path, kind: 'folder' },
      })
      return { path: uploaded.path }
    },
  })
  enqueueRef.current = queue.enqueue

  const extraHolds = useRef<Promise<unknown>>(Promise.resolve())
  const trackHold = (work: () => Promise<unknown>) => {
    const run = extraHolds.current.catch(() => {}).then(work)
    extraHolds.current = run
    return run
  }
  const finishHolds = async () => {
    const queued = await queue.retryAndWait()
    await extraHolds.current.catch(() => {})
    return queued
  }

  const receiveFolders = (folders: FolderGroup[]) => {
    if (canUseHostFeatures()) setPendingFolders(folders)
    else files.addFolders(folders)
  }

  const chooseFolder = (choice: 'upload' | 'mount' | 'cancel') => {
    if (choice === 'cancel') {
      setPendingFolders([])
      return
    }
    const pending = pendingFolders
    const split = folderChoice(choice, pending)
    if (choice === 'upload') {
      setPendingFolders([])
      if (split.upload.length) files.addFolders(split.upload)
      return
    }
    void trackHold(async () => {
      if (split.upload.length) files.addFolders(split.upload)
      if (!split.mount.length) {
        setPendingFolders([])
        return
      }
      if (!idRef.current) await saveRef.current({ createIfEmpty: true })
      const id = idRef.current
      if (!id) throw new Error('Draft is not saved')
      for (const folder of split.mount) {
        const attId = crypto.randomUUID()
        await savePointer.mutateAsync({
          id,
          pointer: { id: attId, name: folder.folderName, hostPath: folder.hostPath, kind: 'mount', size: 0, mimeType: 'inode/mount' },
        })
        files.addMounts([{ id: attId, folderName: folder.folderName, hostPath: folder.hostPath }])
        setPendingFolders((current) => current.filter((item) => item.folderPath !== folder.hostPath))
      }
    }).catch(failed)
  }

  const removeChip = (chipId: string) => {
    const chip = attachmentsRef.current.find((item) => item.id === chipId)
    const id = idRef.current
    // The chip stays when the server delete fails.
    void (async () => {
      if (id && chip) await removeHeld.mutateAsync({ id, attId: chip.id })
      queue.remove(chipId)
    })().catch(failed)
  }

  const pasteFiles = (event: React.ClipboardEvent) => {
    const pasted: File[] = []
    for (const item of event.clipboardData?.items ?? []) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) pasted.push(file)
    }
    if (pasted.length === 0) return
    event.preventDefault()
    if (!fieldsRef.current.agentSlug) {
      toast.error(PICK_AGENT_TO_ATTACH)
      return
    }
    files.addFiles(pasted.map((file) => ({ file })))
  }

  // With no agent the drop is still claimed: unclaimed, the browser opens the file in place of the app.
  const refuseFileDrop = {
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault()
    },
    onDrop: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      toast.error(PICK_AGENT_TO_ATTACH)
    },
  }

  // Dictation writes straight into the description, like typing does.
  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => change({ description: text }),
      // `change` only touches refs and setters.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []),
  })

  const agent = fields.agentSlug ? bySlug.get(fields.agentSlug) : undefined
  const hasAgent = !!agent || fields.newAgent
  const written = !!(fields.title.trim() || fields.description.trim() || files.attachments.length)
  const canStart = hasAgent && !alreadyStarting && written

  // Model, effort and speed follow the chosen agent's defaults, as in the
  // composer, until the person picks; a pick is kept with the draft.
  const { data: agentPrefs, isFetched: agentPrefsFetched } = useAgentPreferences(fields.agentSlug ?? '')
  const composerOptions = useComposerOptions({
    initialModel: initial?.model ?? undefined,
    initialLlmProviderId: initial?.model ? initial.llmProviderId ?? undefined : undefined,
    initialEffort: initial?.effort ?? undefined,
    initialSpeed: initial?.speed ?? undefined,
    agentDefaultModel: agentPrefs?.defaultModel,
    agentDefaultLlmProviderId: agentPrefs?.defaultLlmProviderId,
    agentDefaultEffort: agentPrefs?.defaultEffort,
    agentDefaultSpeed: agentPrefs?.defaultSpeed,
    agentKey: fields.newAgent ? NEW_AGENT_KEY : fields.agentSlug ?? '',
    agentDefaultsReady: !fields.agentSlug || agentPrefsFetched,
  })
  const picked = composerOptions.toRuntimeOptions()
  const pickedModel = picked.model ?? null
  const pickedLlmProviderId = picked.model ? picked.llmProviderId ?? null : null
  const pickedEffort = picked.effort ?? null
  const pickedSpeed = picked.speed ?? null
  useEffect(() => {
    const current = fieldsRef.current
    if (current.model === pickedModel && current.llmProviderId === pickedLlmProviderId &&
      current.effort === pickedEffort && current.speed === pickedSpeed) return
    change({ model: pickedModel, llmProviderId: pickedLlmProviderId, effort: pickedEffort, speed: pickedSpeed })
  // `change` only touches refs and setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedModel, pickedLlmProviderId, pickedEffort, pickedSpeed])
  // An upload still running lands in the agent it started with.
  const uploading = files.attachments.some((item) => (item.type === 'file' || item.type === 'folder') && (item.upload?.status === 'queued' || item.upload?.status === 'uploading'))
  const agentPicker = (
    <AgentDropdown
      value={fields.agentSlug}
      onValueChange={(slug) => change({ agentSlug: slug, newAgent: false })}
      onSelectNew={() => change({ agentSlug: null, newAgent: true })}
      newSelected={fields.newAgent}
      disabled={alreadyStarting || uploading}
      testId="todo-agent"
      trigger={
        agent ? (
          <Button variant="outline" size="sm" className="h-[34px] gap-1.5 text-xs" data-testid="todo-assign-agent">
            <span className="max-w-[12rem] truncate">{agent.name}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        ) : fields.newAgent ? (
          <Button variant="outline" size="sm" className="h-[34px] gap-1.5 text-xs" data-testid="todo-assign-agent">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            New Agent
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="h-[34px] text-muted-foreground" data-testid="todo-assign-agent">
            <Plus className="h-3.5 w-3.5" />
            Assign agent
          </Button>
        )
      }
    />
  )

  /** Ends any dictation, so its tail lands in what is saved or started. */
  const finishDictation = async () => {
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      const text = await voiceInput.stopRecording()
      if (text) change({ description: text })
    }
  }

  const start = async () => {
    if (!canStart || closingRef.current) return
    closingRef.current = true
    await finishDictation()
    try {
      // A new agent has no default of its own to fall back on: start it on
      // the model the picker shows.
      if (fieldsRef.current.newAgent && !fieldsRef.current.model) {
        const model = composerOptions.model ?? composerOptions.defaultModel
        if (model) change({ model, llmProviderId: composerOptions.llmProviderId ?? null })
      }
      const id = await save({ createIfEmpty: files.attachments.length > 0 })
      if (!id) {
        closingRef.current = false
        return
      }
      const held = await finishHolds()
      await save()
      if (!held.ok) {
        closingRef.current = false
        return
      }
      startTodo.mutate({ id, ...fieldsRef.current })
      flushedRef.current = true
      onClose()
    } catch {
      closingRef.current = false
      failed()
    }
  }
  // ⌘↩ starts from either the title or the description.
  const startOnModEnter = (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void start()
    }
  }

  const remove = () => {
    const id = idRef.current
    flushedRef.current = true
    // Nothing to save any more: drop the pending write before the unmount flush.
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    savedRef.current = fieldsRef.current
    if (id) deleteTodo.mutate(id)
    onClose()
  }

  // Edits save as they are typed; this saves now, waits for holds, and closes.
  // A new draft with nothing in it is deleted, as before.
  const saveAndClose = async () => {
    flushedRef.current = true
    await finishDictation()
    try {
      if (closingRef.current) return
      closingRef.current = true
      const id = await save()
      if (id) await queue.waitIdle()
      if (id) await extraHolds.current.catch(() => {})
      if (id) await save()
      const text = fieldsRef.current.title.trim() || fieldsRef.current.description.trim()
      const held = attachmentsRef.current.some((item) => item.type === 'saved' || item.type === 'folder' || item.type === 'mount' || (item.type === 'file' && (!!item.upload?.path || !!queue.pathFor(item.id))))
      if (!initial && id && !text && !held) {
        idRef.current = null
        deleteTodo.mutate(id)
      }
      onClose()
    } catch {
      closingRef.current = false
      failed()
    }
  }
  flushCloseRef.current = () => { void saveAndClose() }

  // Saves what was typed, then archives: the draft can come back from Archived.
  const archive = async () => {
    flushedRef.current = true
    try {
      if (closingRef.current) return
      closingRef.current = true
      const id = await save()
      if (id) {
        await queue.waitIdle()
        await save()
        setTodoStatus.mutate({ id, status: 'archived' })
      }
      onClose()
    } catch {
      closingRef.current = false
      failed()
    }
  }

  return (
    <div
      className={cn('relative flex min-h-0 flex-1 flex-col rounded-2xl', fields.agentSlug && files.isDragOver && 'ring-2 ring-primary')}
      onPaste={pasteFiles}
      {...(fields.agentSlug ? files.dragHandlers : refuseFileDrop)}
    >
      <MountChoiceDialog
        open={pendingFolders.length > 0}
        onChoice={(choice) => { void chooseFolder(choice) }}
        folderName={pendingFolders.length === 1 ? pendingFolders[0].folderName : undefined}
      />
      {/* Title row: the title is the header; controls sit on its right. */}
      <div className="flex items-start gap-3 px-5 pt-5">
        <DialogTitle asChild>
          <input
            value={fields.title}
            onChange={(e) => change({ title: e.target.value })}
            onKeyDown={startOnModEnter}
            // Unnamed, the card shows a title taken from the description.
            placeholder={deriveTodoTitle(fields.description) || 'Task title'}
            maxLength={TODO_TITLE_MAX}
            aria-label="Task title"
            className="min-w-0 flex-1 bg-transparent text-2xl font-medium leading-tight tracking-tight placeholder:text-muted-foreground/60 focus:outline-none"
            data-testid="todo-draft-title"
          />
        </DialogTitle>
        <DialogDescription className="sr-only">Write the task, pick an agent, and start it when it is ready.</DialogDescription>

        <div className="-mr-1.5 -mt-1 flex shrink-0 items-center gap-0.5">
          {initial && (
            <ShortcutTooltip label="Archive draft">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                aria-label="Archive draft"
                onClick={() => void archive()}
                disabled={alreadyStarting}
                data-testid="todo-draft-archive"
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            </ShortcutTooltip>
          )}
          {initial && (
            <ShortcutTooltip label="Delete draft">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                aria-label="Delete draft"
                onClick={remove}
                data-testid="todo-draft-delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </ShortcutTooltip>
          )}
          <ShortcutTooltip label={expanded ? 'Shrink' : 'Expand'}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label={expanded ? 'Shrink' : 'Expand'}
              onClick={onToggleExpand}
              data-testid="todo-draft-expand"
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          </ShortcutTooltip>
          <ShortcutTooltip label="Close" keys={['Esc']}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label="Close"
              onClick={() => flushCloseRef.current()}
              data-testid="todo-draft-close"
            >
              <X className="h-4 w-4" />
            </Button>
          </ShortcutTooltip>
        </div>
      </div>

      {/* Description */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <div className="todo-draft-editor">
          <MarkdownComposerEditor
            value={fields.description}
            onChange={(description) => change({ description })}
            onKeyDown={startOnModEnter}
            placeholder="Describe what you want to get done. Paste links for context."
            minRows={expanded ? 12 : 3}
            className="mt-5 text-[15px] leading-7"
            dataTestId="todo-draft-editor"
          />
        </div>
      </div>

      {files.attachments.length > 0 && (
        <div className="px-4 pb-1">
          <AttachmentPreview attachments={files.attachments} onRemove={removeChip} onRetry={queue.retry} />
        </div>
      )}

      {/* Footer: attach, the agent and its model on the left; dictate and start on the right. */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {fields.agentSlug ? (
            <AttachmentPicker
              onFileSelect={files.handleFileSelect}
              onFolderSelect={files.handleFolderSelect}
              onRecentFileAttach={(file) => files.addFiles([{ file }])}
              disabled={alreadyStarting}
              buttonClassName="h-[34px] w-[34px]"
            />
          ) : (
            <ShortcutTooltip label={PICK_AGENT_TO_ATTACH}>
              {/* A span keeps the tooltip working while the button is disabled. */}
              <span data-testid="todo-attach-needs-agent">
                <AttachmentPicker onFileSelect={() => {}} onFolderSelect={() => {}} disabled buttonClassName="h-[34px] w-[34px]" />
              </span>
            </ShortcutTooltip>
          )}
          {uploading && !alreadyStarting ? (
            <ShortcutTooltip label={WAIT_FOR_UPLOADS}>
              {/* A span keeps the tooltip working while the picker is disabled. */}
              <span data-testid="todo-agent-uploading">{agentPicker}</span>
            </ShortcutTooltip>
          ) : agentPicker}
          {hasAgent && (
            <ComposerOptions
              state={composerOptions}
              // A new agent has no defaults yet to compare with or set.
              footer={fields.agentSlug ? <AgentDefaultFooter agentSlug={fields.agentSlug} state={composerOptions} /> : undefined}
            />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <VoiceInputButton voiceInput={voiceInput} message={fields.description} />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => void saveAndClose()}
            disabled={!written || alreadyStarting}
            data-testid="todo-draft-save"
          >
            Save draft
          </Button>
          <ShortcutTooltip label={hasAgent ? 'Start' : 'Pick an agent to start'} keys={hasAgent ? [MOD, 'Enter'] : undefined}>
            {/* A span keeps the tooltip working while the button is disabled. */}
            <span>
              <Button
                size="icon"
                className="h-8 w-8"
                onClick={() => void start()}
                disabled={!canStart}
                aria-label="Start"
                aria-keyshortcuts="Meta+Enter"
                data-testid="todo-draft-start"
              >
                {/* Button sizes every icon to 16px, hence the `!`. */}
                <Play className="!h-3.5 !w-3.5 fill-current" />
              </Button>
            </span>
          </ShortcutTooltip>
        </div>
      </div>
      <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} className="px-5 pb-3" />
    </div>
  )
}

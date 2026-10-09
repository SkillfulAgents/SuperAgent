import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Archive, ChevronDown, Maximize2, Minimize2, Play, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { deriveTodoTitle, TODO_TITLE_MAX, type TodoAttachment } from '@shared/lib/todos/todo-schema'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { AttachmentPreview, attachmentStatus, type Attachment, type FileAttachment, type FolderAttachment } from '@renderer/components/messages/attachment-preview'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { uploadFileChunked } from '@renderer/lib/upload'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { filesFromClipboard, folderChoice, getItemsFromDataTransfer, type DataTransferResult, type FolderGroup } from '@renderer/lib/file-utils'
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
const REMOVE_FILES_TO_CHANGE_AGENT = 'Remove attached files to change the agent'

/** What the chips keep on the draft: stored ones, mounts, and finished uploads. An unfinished or failed upload is not kept. */
export function keptAttachments(
  chips: Attachment[],
  stored: TodoAttachment[],
  finishedPath: (id: string) => { path: string } | undefined,
): TodoAttachment[] {
  return chips.flatMap((chip): TodoAttachment[] => {
    if (chip.type === 'saved') return stored.filter((att) => att.id === chip.id)
    if (chip.type === 'mount') {
      return [{ id: chip.id, kind: 'mount', name: chip.folderName, size: 0, mimeType: 'inode/mount', hostPath: chip.hostPath }]
    }
    const path = chip.error ? undefined : chip.upload?.path ?? finishedPath(chip.id)?.path
    if (!path) return []
    return chip.type === 'file'
      ? [{ id: chip.id, kind: 'file', name: chip.file.name, size: chip.file.size, mimeType: chip.file.type || 'application/octet-stream', path }]
      : [{ id: chip.id, kind: 'folder', name: chip.folderName, size: chip.totalSize, mimeType: 'inode/directory', path }]
  })
}

const sameAttachments = (a: TodoAttachment[], b: TodoAttachment[]) =>
  a.length === b.length && a.every((att, i) => att.id === b[i].id)

/** Takes what the ref holds and leaves it empty, so a second taker gets nothing. */
export function takeAll<T>(ref: { current: T[] }): T[] {
  const taken = ref.current
  ref.current = []
  return taken
}

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
  // Closed, the form is gone: close no longer reaches its state.
  if (!target) flushCloseRef.current = () => onClose()
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
  // The chips are the attachment list; this reads it when a save's turn comes.
  const savedAttachmentsRef = useRef<TodoAttachment[]>(initial?.attachments ?? [])
  const keptRef = useRef<() => TodoAttachment[]>(() => [])

  /** Brings the server up to date with the form. Resolves with the draft's id, or null when there is nothing to keep. */
  const save = useCallback((): Promise<string | null> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const saveNow = async (): Promise<string | null> => {
      // Read the form when this save's turn comes, not when it was queued.
      const current = fieldsRef.current
      const attachments = keptRef.current()
      let id = idRef.current
      if (!id) {
        // Nothing written yet, a draft is created under its first attachment's name.
        const title = current.title.trim() || (attachments[0]?.name.slice(0, TODO_TITLE_MAX) ?? '')
        if (!title && !current.description.trim()) return null
        id = (await createTodo.mutateAsync({ ...payload(current), title })).id
        idRef.current = id
        savedRef.current = current
      }
      const before = savedRef.current
      const attachmentsChanged = !sameAttachments(savedAttachmentsRef.current, attachments)
      if (before && sameFields(before, current) && !attachmentsChanged) return id
      const { title, agentSlug, newAgent, ...rest } = payload(current)
      await updateTodo.mutateAsync({
        id,
        ...rest,
        // The title and agent go only when changed: a blank form keeps the title a draft was created under,
        // and an untouched agent is not a change of agent.
        ...(current.title !== before?.title ? { title } : {}),
        ...(current.agentSlug !== before?.agentSlug || current.newAgent !== before?.newAgent ? { agentSlug, newAgent } : {}),
        ...(attachmentsChanged ? { attachments } : {}),
      })
      savedRef.current = current
      savedAttachmentsRef.current = attachments
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
      // Refused (something is attached), the old agent is still the draft's.
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
  // Close and archive wait for uploads already moving. Shown, so the dialog does not look stuck.
  const [finishing, setFinishing] = useState(false)
  useEffect(() => () => {
    if (!flushedRef.current) void saveRef.current().then((id) => dropIfEmptyRef.current(id)).catch(failed)
  }, [])

  const uploadFolder = useUploadFolder()
  const enqueueRef = useRef<(item: FileAttachment | FolderAttachment) => void>(() => {})
  const [pendingFolders, setPendingFolders] = useState<FolderGroup[]>([])
  // Read on choice, so a second click finds nothing left to mount.
  const pendingFoldersRef = useRef<FolderGroup[]>([])
  const files = useAttachments({
    initialAttachments: (initial?.attachments ?? []).map(heldChip),
    onFoldersReceived: (folders) => receiveFolders(folders),
    onAttachmentsAdded: (added) => {
      for (const item of added) if (item.type === 'file' || item.type === 'folder') enqueueRef.current(item)
    },
  })
  const attachmentsRef = useRef<Attachment[]>(files.attachments)
  attachmentsRef.current = files.attachments
  // Uploads go to the agent's workspace through chat's routes. Attaching needs an agent, so it is set here.
  const agentFor = () => {
    const slug = fieldsRef.current.agentSlug
    if (!slug) throw new Error('Pick an agent')
    return slug
  }
  const queue = useUploadQueue({
    agentSlug: fields.agentSlug ?? '',
    attachmentsRef,
    updateAttachment: files.updateAttachment,
    removeAttachment: files.removeAttachment,
    clearAttachments: files.clearAttachments,
    uploadFile: ({ file, onProgress, signal, stallMs }) =>
      uploadFileChunked<{ path: string }>({ url: `/api/agents/${agentFor()}/upload-file`, file, onProgress, signal, stallMs }),
    uploadFolder: ({ sourcePath }) => uploadFolder.mutateAsync({ agentSlug: agentFor(), sourcePath }),
  })
  enqueueRef.current = queue.enqueue
  keptRef.current = () => keptAttachments(attachmentsRef.current, initial?.attachments ?? [], queue.pathFor)

  // A finished upload, a new mount, or a removal saves the list.
  const keptIds = keptAttachments(files.attachments, initial?.attachments ?? [], queue.pathFor).map((att) => att.id).join()
  useEffect(() => {
    void save().catch(failed)
  }, [keptIds, save])

  // While close, archive, or Start waits, a moving or failed upload is what it waits on.
  const uploadsPending = files.attachments.some((item) => {
    const status = attachmentStatus(item)
    return status === 'queued' || status === 'uploading' || status === 'error'
  })

  const receiveFolders = (folders: FolderGroup[]) => {
    if (!canUseHostFeatures()) {
      files.addFolders(folders)
      return
    }
    pendingFoldersRef.current = folders
    setPendingFolders(folders)
  }

  const chooseFolder = (choice: 'upload' | 'mount' | 'cancel') => {
    const pending = takeAll(pendingFoldersRef)
    setPendingFolders([])
    if (choice === 'cancel' || pending.length === 0) return
    const split = folderChoice(choice, pending)
    if (split.upload.length) files.addFolders(split.upload)
    files.addMounts(split.mount)
  }

  const pasteFiles = (event: React.ClipboardEvent) => {
    if (closingRef.current) return
    const pasted = filesFromClipboard(event.clipboardData)
    if (pasted.length === 0) return
    event.preventDefault()
    if (!fieldsRef.current.agentSlug) {
      setAskAgent({ held: { files: pasted.map((file) => ({ file })), folders: [] } })
      return
    }
    files.addFiles(pasted.map((file) => ({ file })))
  }

  // No agent yet: hold what was dropped, ask for the agent, then attach it.
  // The drop is claimed either way, or the browser opens the file in place of the app.
  const holdFileDrop = {
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault()
    },
    onDrop: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      if (closingRef.current) return
      void getItemsFromDataTransfer(event.dataTransfer).then((held) => {
        if (held.files.length || held.folders.length) setAskAgent({ held })
      })
    },
  }

  // What waits for the agent: dropped or pasted items, or (from the paperclip) the attach menu.
  const [askAgent, setAskAgent] = useState<{ held: DataTransferResult | null } | null>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  // Attach once the picked agent has rendered, so the uploads go to it.
  useEffect(() => {
    if (!askAgent || !fields.agentSlug) return
    setAskAgent(null)
    if (askAgent.held) files.addItems(askAgent.held)
    else setAttachMenuOpen(true)
  // `files.addItems` is stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAgent, fields.agentSlug])

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
  const canStart = hasAgent && !alreadyStarting && written && !finishing

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
  // Attachments live in the agent's workspace, so the agent is fixed while there are any.
  const agentLocked = files.attachments.length > 0
  const agentPicker = (
    <AgentDropdown
      value={fields.agentSlug}
      onValueChange={(slug) => change({ agentSlug: slug, newAgent: false })}
      onSelectNew={() => change({ agentSlug: null, newAgent: true })}
      newSelected={fields.newAgent}
      disabled={alreadyStarting || agentLocked}
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
      setFinishing(true)
      const uploaded = await queue.retryAndWait()
      const id = await save()
      if (!id || !uploaded.ok) {
        closingRef.current = false
        setFinishing(false)
        return
      }
      startTodo.mutate({ id, ...fieldsRef.current })
      flushedRef.current = true
      onClose()
    } catch {
      closingRef.current = false
      setFinishing(false)
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

  // A new draft left with nothing written and nothing attached is deleted, however the dialog closes.
  const dropIfEmpty = (id: string | null) => {
    const text = fieldsRef.current.title.trim() || fieldsRef.current.description.trim()
    if (initial || !id || text || keptRef.current().length > 0) return
    idRef.current = null
    deleteTodo.mutate(id)
  }
  const dropIfEmptyRef = useRef(dropIfEmpty)
  dropIfEmptyRef.current = dropIfEmpty

  // Edits save as they are typed; this waits for uploads already moving, saves, and closes.
  // A new draft with nothing in it is deleted, as before.
  const saveAndClose = async () => {
    await finishDictation()
    try {
      if (closingRef.current) return
      closingRef.current = true
      setFinishing(true)
      await queue.waitIdle()
      const id = await save()
      dropIfEmpty(id)
      flushedRef.current = true
      onClose()
    } catch {
      closingRef.current = false
      setFinishing(false)
      failed()
    }
  }
  flushCloseRef.current = () => { void saveAndClose() }

  // Saves what was typed, then archives: the draft can come back from Archived.
  const archive = async () => {
    try {
      if (closingRef.current) return
      closingRef.current = true
      setFinishing(true)
      await queue.waitIdle()
      const id = await save()
      if (id) await setTodoStatus.mutateAsync({ id, status: 'archived' })
      flushedRef.current = true
      onClose()
    } catch {
      closingRef.current = false
      setFinishing(false)
      failed()
    }
  }

  // With no agent the paperclip looks off, and opening it asks for the agent first.
  const attachPicker = (
    <AttachmentPicker
      onFileSelect={files.handleFileSelect}
      onFolderSelect={files.handleFolderSelect}
      onRecentFileAttach={(file) => files.addFiles([{ file }])}
      disabled={alreadyStarting || finishing}
      buttonClassName={cn('h-[34px] w-[34px]', !fields.agentSlug && 'text-muted-foreground/50')}
      open={attachMenuOpen && !!fields.agentSlug}
      onOpenChange={(open) => {
        if (open && !fieldsRef.current.agentSlug) setAskAgent({ held: null })
        else setAttachMenuOpen(open)
      }}
    />
  )

  return (
    <div
      className={cn('relative flex min-h-0 flex-1 flex-col rounded-2xl', fields.agentSlug && files.isDragOver && 'ring-2 ring-primary')}
      onPaste={pasteFiles}
      {...(finishing ? holdFileDrop : fields.agentSlug ? files.dragHandlers : holdFileDrop)}
    >
      <MountChoiceDialog
        open={pendingFolders.length > 0}
        onChoice={(choice) => { void chooseFolder(choice) }}
        folderName={pendingFolders.length === 1 ? pendingFolders[0].folderName : undefined}
      />
      <Dialog open={askAgent !== null && !fields.agentSlug} onOpenChange={(open) => { if (!open) setAskAgent(null) }}>
        <DialogContent className="max-w-sm" data-testid="todo-pick-agent-to-attach">
          <DialogHeader>
            <DialogTitle className="font-medium">{PICK_AGENT_TO_ATTACH}</DialogTitle>
            <DialogDescription>Files are uploaded to that agent&apos;s workspace.</DialogDescription>
          </DialogHeader>
          {/* The draft's own picker, shown in place. No New Agent row: a new agent has no workspace yet. */}
          <AgentDropdown value={null} onValueChange={(slug) => change({ agentSlug: slug, newAgent: false })} inline testId="todo-attach-agent" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAskAgent(null)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
                disabled={finishing}
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
          <AttachmentPreview attachments={files.attachments} onRemove={(id) => { if (!closingRef.current) queue.remove(id) }} onRetry={queue.retry} />
        </div>
      )}

      {/* Footer: attach, the agent and its model on the left; dictate and start on the right. */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {fields.agentSlug ? attachPicker : (
            <ShortcutTooltip label={PICK_AGENT_TO_ATTACH}>
              <span data-testid="todo-attach-needs-agent">{attachPicker}</span>
            </ShortcutTooltip>
          )}
          {agentLocked && !alreadyStarting ? (
            <ShortcutTooltip label={REMOVE_FILES_TO_CHANGE_AGENT}>
              {/* A span keeps the tooltip working while the picker is disabled. */}
              <span data-testid="todo-agent-locked">{agentPicker}</span>
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
            disabled={!written || alreadyStarting || finishing}
            data-testid="todo-draft-save"
          >
            {finishing && uploadsPending ? 'Finishing uploads…' : 'Save draft'}
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

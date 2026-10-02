import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ChevronDown, Maximize2, Minimize2, Play, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { deriveTodoTitle, TODO_TITLE_MAX } from '@shared/lib/todos/todo-schema'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { MarkdownComposerEditor } from '@renderer/components/messages/markdown-composer-editor'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useVoiceInput } from '@renderer/hooks/use-voice-input'
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
import { AgentPicker, useTodoAgents } from './todo-shared'

/** Which draft the dialog shows: a new one (not saved until there is something in it) or a saved one. */
export type TodoDraftTarget = { kind: 'new' } | { kind: 'existing'; todo: TodoView }

interface DraftFields {
  title: string
  description: string
  agentSlug: string | null
}

const SAVE_DELAY_MS = 600

/**
 * A failed save or status change is a failed mutation, which the app's
 * global mutation handler has already toasted; the dialog only stops there.
 */
function failed() {}

const sameFields = (a: DraftFields, b: DraftFields) =>
  a.title === b.title && a.description === b.description && a.agentSlug === b.agentSlug

/**
 * The draft dialog: a title, a Markdown description and the agent to give it
 * to, with Start in the corner. Edits save shortly after typing stops and
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
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
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
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DraftForm({ initial, expanded, onToggleExpand, onClose }: {
  initial: TodoView | null
  expanded: boolean
  onToggleExpand: () => void
  onClose: () => void
}) {
  const { agents, bySlug } = useTodoAgents()
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
  const save = useCallback((): Promise<string | null> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const saveNow = async (): Promise<string | null> => {
      // Read the form when this save's turn comes, not when it was queued.
      const current = fieldsRef.current
      const id = idRef.current
      if (!id) {
        if (!current.title.trim() && !current.description.trim()) return null
        const todo = await createTodo.mutateAsync({ title: current.title.trim(), description: current.description, agentSlug: current.agentSlug })
        idRef.current = todo.id
        savedRef.current = current
        return todo.id
      }
      if (savedRef.current && sameFields(savedRef.current, current)) return id
      await updateTodo.mutateAsync({ id, title: current.title.trim(), description: current.description, agentSlug: current.agentSlug })
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
    timerRef.current = window.setTimeout(() => void save().catch(failed), SAVE_DELAY_MS)
  }

  // Leaving saves what is left unsaved, however the dialog closes.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => () => { void saveRef.current().catch(failed) }, [])

  // Dictation writes straight into the description, like typing does.
  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => change({ description: text }),
      // `change` only touches refs and setters.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []),
  })

  const agent = fields.agentSlug ? bySlug.get(fields.agentSlug) : undefined
  const canStart = !!agent && !alreadyStarting && !!(fields.title.trim() || fields.description.trim())

  const start = async () => {
    if (!canStart) return
    // Finish any dictation first so its tail lands in the brief that starts.
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      const text = await voiceInput.stopRecording()
      if (text) change({ description: text })
    }
    try {
      const id = await save()
      if (!id) return
      startTodo.mutate({ id, agentSlug: fieldsRef.current.agentSlug })
      onClose()
    } catch {
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
    // Nothing to save any more: drop the pending write before the unmount flush.
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    savedRef.current = fieldsRef.current
    if (id) deleteTodo.mutate(id)
    onClose()
  }

  // Saves what was typed, then archives: the draft can come back from Archived.
  const archive = async () => {
    try {
      const id = await save()
      if (id) setTodoStatus.mutate({ id, status: 'archived' })
      onClose()
    } catch {
      failed()
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col rounded-2xl">
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
              onClick={onClose}
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

      {/* Footer: the agent on the left; dictate and start on the right. */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <AgentPicker
          agents={agents}
          selected={fields.agentSlug}
          onPick={(picked) => change({ agentSlug: picked.slug })}
          trigger={
            agent ? (
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" data-testid="todo-assign-agent">
                <span className="max-w-[12rem] truncate">{agent.name}</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="h-8 text-muted-foreground" data-testid="todo-assign-agent">
                <Plus className="h-3.5 w-3.5" />
                Assign agent
              </Button>
            )
          }
        />
        <div className="flex items-center gap-1.5">
          <VoiceInputButton voiceInput={voiceInput} message={fields.description} />
          <ShortcutTooltip label={agent ? 'Start' : 'Pick an agent to start'} keys={agent ? [MOD, 'Enter'] : undefined}>
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

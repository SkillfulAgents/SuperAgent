import { useCallback, useEffect, useState } from 'react'
import { Maximize2, Minimize2, Paperclip, Play, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { MarkdownComposerEditor } from '@renderer/components/messages/markdown-composer-editor'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useAttachments } from '@renderer/hooks/use-attachments'
import { useVoiceInput } from '@renderer/hooks/use-voice-input'
import type { TodoCard } from './todo-schema'
import { getTodoCard, todoActions, useTodoCard } from './todo-store'
import { MOD, ShortcutTooltip } from './todo-shortcuts'
import {
  AssignMenu,
  TodoAgentChip,
  TodoAttachmentList,
  pickAgentFor,
  toTodoAttachments,
  useAssignableAgents,
} from './todo-shared'

/**
 * The draft dialog: a title, a Markdown description, context files and the
 * agents to hand it to, with Start in the corner. Everything saves as it is
 * typed, so closing always keeps the draft; an untouched new draft is thrown
 * away by the board on close. Started work opens its session page instead.
 */
export function TodoDraftDialog({ cardId, isNew, onClose }: {
  cardId: string | null
  /** Just created from New draft: offers Save as Draft rather than Delete. */
  isNew?: boolean
  onClose: () => void
}) {
  const card = useTodoCard(cardId)
  // Expanded is a taller, slightly wider box for a long brief. Both states set
  // explicit sizes so the change tweens instead of snapping from `auto`.
  const [expanded, setExpanded] = useState(false)
  const isDraft = card?.column === 'drafts'
  return (
    <Dialog open={isDraft} onOpenChange={(open) => !open && onClose()}>
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
        {card && isDraft && (
          <DraftForm key={card.id} card={card} isNew={!!isNew} expanded={expanded} onToggleExpand={() => setExpanded((v) => !v)} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DraftForm({ card, isNew, expanded, onToggleExpand, onClose }: {
  card: TodoCard
  isNew: boolean
  expanded: boolean
  onToggleExpand: () => void
  onClose: () => void
}) {
  const agents = useAssignableAgents()
  const unassigned = agents.filter((a) => !card.agents.some((c) => c.slug === a.slug))
  const hasContent = card.prompt.trim().length > 0 || !card.titleIsGenerated

  // The attachments hook is only a courier here: whatever is dropped or picked
  // goes straight onto the card, which keeps the record.
  const attachments = useAttachments()
  const { attachments: pending, clearAttachments } = attachments
  useEffect(() => {
    if (pending.length === 0) return
    todoActions.addAttachments(card.id, toTodoAttachments(pending))
    clearAttachments()
  }, [pending, clearAttachments, card.id])

  // Dictation writes straight into the description, like typing does.
  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => todoActions.setPrompt(card.id, text), [card.id]),
  })

  const start = async () => {
    // Finish any dictation first so its tail lands in the brief that starts.
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      const text = await voiceInput.stopRecording()
      if (text) todoActions.setPrompt(card.id, text)
    }
    const prompt = getTodoCard(card.id)?.prompt ?? card.prompt
    todoActions.start(card.id, pickAgentFor(prompt, agents))
    onClose()
  }
  // ⌘↩ starts from either the title or the description.
  const startOnModEnter = (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void start()
    }
  }

  return (
    <div
      {...attachments.dragHandlers}
      className={cn('relative flex min-h-0 flex-1 flex-col rounded-2xl', attachments.isDragOver && 'ring-2 ring-inset ring-primary')}
    >
      {attachments.isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/80 text-sm text-muted-foreground">
          Drop to add context
        </div>
      )}

      {/* Title row: the title is the header; controls sit on its right. */}
      <div className="flex items-start gap-3 px-5 pt-5">
        <DialogTitle asChild>
          <input
            // A generated name stays a placeholder until there is a prompt to name.
            value={card.titleIsGenerated && !card.prompt.trim() ? '' : card.title}
            onChange={(e) => todoActions.setTitle(card.id, e.target.value)}
            onKeyDown={startOnModEnter}
            placeholder={isNew ? 'Task title' : 'Untitled task'}
            aria-label="Task title"
            className="min-w-0 flex-1 bg-transparent text-2xl font-medium leading-tight tracking-tight placeholder:text-muted-foreground/60 focus:outline-none"
            data-testid="todo-draft-title"
          />
        </DialogTitle>
        <DialogDescription className="sr-only">Write the task, add context, and start it when it is ready.</DialogDescription>

        <div className="-mr-1.5 -mt-1 flex shrink-0 items-center gap-0.5">
          {/* A new draft offers Save as Draft once there is something to keep;
              a saved one offers Delete. Closing saves changes either way. */}
          {isNew && hasContent && (
            <Button variant="outline" size="sm" className="mr-1 h-7" onClick={onClose} data-testid="todo-draft-save">
              Save as Draft
            </Button>
          )}
          {!isNew && (
            <ShortcutTooltip label="Delete draft">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                aria-label="Delete draft"
                onClick={() => {
                  todoActions.remove(card.id)
                  onClose()
                }}
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
            value={card.prompt}
            onChange={(value) => todoActions.setPrompt(card.id, value)}
            onKeyDown={startOnModEnter}
            placeholder="Describe what you want to get done. Paste links, drop files to give more helpful context."
            minRows={expanded ? 12 : 3}
            className="mt-5 text-[15px] leading-7"
            dataTestId="todo-draft-editor"
          />
        </div>
      </div>

      {/* Attachments, above the footer, once there are some */}
      {card.attachments.length > 0 && (
        <section className="shrink-0 px-5 pb-4" aria-label="Attachments">
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Attachments</h3>
          <TodoAttachmentList attachments={card.attachments} onRemove={(id) => todoActions.removeAttachment(card.id, id)} />
        </section>
      )}

      {/* Footer: attach and assign on the left; dictate and start on the right. */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <label
            className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
            title="Attach files"
          >
            <input type="file" multiple className="hidden" onChange={attachments.handleFileSelect} />
            <Paperclip className="h-3.5 w-3.5" />
            <span className="sr-only">Attach files</span>
          </label>
          {card.agents.map((agent) => (
            <TodoAgentChip key={agent.slug} agent={agent} size="md" onRemove={() => todoActions.unassignAgent(card.id, agent.slug)} />
          ))}
          <AssignMenu
            candidates={unassigned}
            onPick={(agent) => todoActions.assignAgent(card.id, agent)}
            trigger={
              card.agents.length > 0 ? (
                <Button variant="outline" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="Assign another agent" title="Assign another agent" data-testid="todo-assign-agent">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button variant="outline" size="sm" className="h-8 text-muted-foreground" data-testid="todo-assign-agent">
                  <Plus className="h-3.5 w-3.5" />
                  Assign Agent
                </Button>
              )
            }
          />
        </div>
        <div className="flex items-center gap-1.5">
          <VoiceInputButton voiceInput={voiceInput} message={card.prompt} />
          <ShortcutTooltip label="Start" keys={[MOD, 'Enter']}>
            <Button size="icon" className="h-8 w-8" onClick={() => void start()} aria-label="Start" aria-keyshortcuts="Meta+Enter" data-testid="todo-draft-start">
              {/* Button sizes every icon to 16px, hence the `!`. */}
              <Play className="!h-3.5 !w-3.5 fill-current" />
            </Button>
          </ShortcutTooltip>
        </div>
      </div>
      <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} className="px-5 pb-3" />
    </div>
  )
}

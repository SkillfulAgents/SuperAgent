import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { isComposing, isSubmitEnter } from '@renderer/lib/enter-key'
import { useCommentMic } from './use-comment-mic'
import { describeAnchor } from './anchor'
import type { CommentAnchor } from './kinds'

/** What the box and the bar call each note: a comment on a file, a reply to an agent message. */
export type CommentNoun = 'comment' | 'reply'

interface CommentOverlayViewProps {
  /** Shown above the text field: what the note is on. */
  label: string
  /** Where the box opens, in its positioned parent's coordinates. */
  rect: DOMRect
  onAdd: (text: string) => void
  onClose: () => void
  noun?: CommentNoun
  /** The editor. Otherwise a "Comment" chip, which calls `onEdit`. */
  autoEdit?: boolean
  /** Start the mic as the editor opens, when voice input is set up. */
  autoListen?: boolean
  /** The "Comment" chip was clicked. */
  onEdit?: () => void
}

interface CommentOverlayProps extends Omit<CommentOverlayViewProps, 'label' | 'onAdd' | 'noun'> {
  anchor: CommentAnchor
  filePath: string
  agentSlug: string
}

/** A comment box on a file: adds to the file-preview comments. */
export function CommentOverlay({ anchor, filePath, agentSlug, ...props }: CommentOverlayProps) {
  const { addComment } = useFilePreview()
  return (
    <CommentOverlayView
      {...props}
      label={describeAnchor(anchor)}
      onAdd={(text) => addComment({ filePath, agentSlug, text, anchor })}
    />
  )
}

export function CommentOverlayView({ label, rect, onAdd, onClose, onEdit, noun = 'comment', autoEdit = false, autoListen = false }: CommentOverlayViewProps) {
  const [commentText, setCommentText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { voiceInput, listening, voiceModeOn } = useCommentMic(setCommentText, autoListen)
  const canAdd = !voiceInput.isFinalizing && (!!commentText.trim() || voiceInput.isRecording)

  useEffect(() => {
    if (autoEdit && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [autoEdit])

  // Slide the overlay left, before it paints, so it ends 8px inside the pane that clips it.
  // Re-runs when the editor opens or its anchor moves.
  const overlayRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    let pane = overlay?.parentElement
    while (pane && getComputedStyle(pane).overflowX === 'visible') pane = pane.parentElement
    if (!overlay || !pane) return
    overlay.style.marginLeft = ''
    const right = pane.getBoundingClientRect().left + pane.clientWidth - 8
    overlay.style.marginLeft = `${Math.min(0, right - overlay.getBoundingClientRect().right)}px`
  }, [autoEdit, rect.x])

  const handleAdd = async () => {
    if (!canAdd) return
    const text = listening ? (await voiceInput.stopRecording()) || commentText : commentText
    if (!textareaRef.current || !text.trim()) return
    onAdd(text.trim())
    setCommentText('')
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e.nativeEvent)) return
    if (isSubmitEnter(e.nativeEvent)) {
      e.preventDefault()
      void handleAdd()
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      onClose()
    }
  }

  if (!autoEdit) {
    return (
      <div
        ref={overlayRef}
        data-comment-overlay
        className="absolute z-30"
        style={{ left: rect.x, top: rect.y + 4 }}
      >
        <button
          onClick={onEdit}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-primary text-primary-foreground shadow-md hover:bg-primary/90 transition-colors"
        >
          <MessageSquarePlus className="h-3 w-3" />
          Comment
        </button>
      </div>
    )
  }

  return (
    <div
      ref={overlayRef}
      data-comment-overlay
      className="absolute z-30 w-64"
      style={{ left: rect.x, top: rect.y + 4 }}
    >
      <div className="rounded-lg border border-border bg-popover p-2 shadow-lg space-y-2">
        <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5 truncate">
          {label}
        </div>
        <textarea
          ref={textareaRef}
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Add your ${noun}...`}
          className="w-full text-xs rounded border border-border bg-background p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          rows={3}
        />
        <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} />
        <div className="flex justify-end gap-1">
          <VoiceInputButton voiceInput={voiceInput} message={commentText} disabled={voiceModeOn} size="xs" />
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 text-xs"
            onClick={() => void handleAdd()}
            disabled={!canAdd}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}

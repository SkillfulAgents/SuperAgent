import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { isComposing, isSubmitEnter } from '@renderer/lib/enter-key'
import type { TextSelectionInfo } from './use-text-selection'
import { useCommentMic } from './use-comment-mic'
import { describeAnchor, selectionToAnchor } from './anchor'

interface CommentOverlayProps {
  selection: TextSelectionInfo
  filePath: string
  agentSlug: string
  onClose: () => void
  /** Skip the intermediate "Comment" button and open the editor immediately. */
  autoEdit?: boolean
  /** Start the mic as the editor opens, when voice input is set up. */
  autoListen?: boolean
}

export function CommentOverlay({ selection, filePath, agentSlug, onClose, autoEdit = false, autoListen = false }: CommentOverlayProps) {
  const [isEditing, setIsEditing] = useState(autoEdit)
  const [commentText, setCommentText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { addComment } = useFilePreview()
  const { voiceInput, listening, voiceModeOn } = useCommentMic(setCommentText, autoListen)
  const canAdd = !voiceInput.isFinalizing && (!!commentText.trim() || voiceInput.isRecording)

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isEditing])

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
  }, [isEditing, selection.rect.x])

  const handleAdd = async () => {
    if (!canAdd) return
    const text = listening ? (await voiceInput.stopRecording()) || commentText : commentText
    if (!textareaRef.current || !text.trim()) return
    addComment({
      filePath,
      agentSlug,
      text: text.trim(),
      anchor: selectionToAnchor(selection),
    })
    setCommentText('')
    setIsEditing(false)
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

  if (!isEditing) {
    return (
      <div
        ref={overlayRef}
        data-comment-overlay
        className="absolute z-30"
        style={{ left: selection.rect.x, top: selection.rect.y + 4 }}
      >
        <button
          onClick={() => setIsEditing(true)}
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
      style={{ left: selection.rect.x, top: selection.rect.y + 4 }}
    >
      <div className="rounded-lg border border-border bg-popover p-2 shadow-lg space-y-2">
        <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5 line-clamp-2">
          {describeAnchor(selectionToAnchor(selection))}
        </div>
        <textarea
          ref={textareaRef}
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add your comment..."
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

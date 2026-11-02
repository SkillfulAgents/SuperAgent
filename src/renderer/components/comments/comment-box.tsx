import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { isComposing, isSubmitEnter } from '@renderer/lib/enter-key'
import { cn } from '@shared/lib/utils/cn'
import { useCommentMic } from './use-comment-mic'

export interface CommentBoxProps {
  /** One line naming what the comment is on. */
  label: ReactNode
  /** Gets the trimmed text. */
  onSubmit: (text: string) => void
  onCancel: () => void
  autoFocus?: boolean
  /** Start the mic as the box opens, when voice input is set up. */
  autoListen?: boolean
  className?: string
}

/**
 * The comment editor, apart from where it sits and what a submitted comment
 * does: a text field with dictation, Enter to submit and Escape to cancel. The
 * file viewer's box places it and adds the comment to the file's list.
 */
export function CommentBox({ label, onSubmit, onCancel, autoFocus = false, autoListen = false, className }: CommentBoxProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { voiceInput, listening, voiceModeOn } = useCommentMic(setText, autoListen)
  const canSubmit = !voiceInput.isFinalizing && (!!text.trim() || voiceInput.isRecording)

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  const handleSubmit = async () => {
    if (!canSubmit) return
    const said = listening ? (await voiceInput.stopRecording()) || text : text
    if (!textareaRef.current || !said.trim()) return
    onSubmit(said.trim())
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e.nativeEvent)) return
    if (isSubmitEnter(e.nativeEvent)) {
      e.preventDefault()
      void handleSubmit()
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className={cn('rounded-lg border border-border bg-popover p-2 shadow-lg space-y-2', className)}>
      <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5 truncate">
        {label}
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add your comment..."
        className="w-full text-xs rounded border border-border bg-background p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        rows={3}
      />
      <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} />
      <div className="flex justify-end gap-1">
        <VoiceInputButton voiceInput={voiceInput} message={text} disabled={voiceModeOn} size="xs" />
        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-6 text-xs"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
        >
          Add
        </Button>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { isComposing, isSubmitEnter } from '@renderer/lib/enter-key'
import { cn } from '@shared/lib/utils/cn'
import { useCommentMic } from './use-comment-mic'

export interface CommentBoxProps {
  /** One line naming what the comment is on. */
  label: ReactNode
  /** Gets the trimmed text, and whether the mic wrote some of it. */
  onSubmit: (text: string, meta: { dictated: boolean }) => void
  onCancel: () => void
  submitLabel?: string
  placeholder?: string
  autoFocus?: boolean
  /** Start the mic as the box opens, when voice input is set up. */
  autoListen?: boolean
  /** The comment is on its way: the box holds still and says so. */
  busy?: boolean
  busyLabel?: string
  error?: string | null
  /** `glow` is the dashboard's comment mode skin. */
  variant?: 'default' | 'glow'
  className?: string
}

/**
 * The comment editor shared by every surface that takes a comment: the file
 * viewer's box and the dashboard's comment mode. A text field with dictation,
 * Enter to submit and Escape to cancel. Where it sits and what a submitted
 * comment does are the caller's.
 */
export function CommentBox({
  label,
  onSubmit,
  onCancel,
  submitLabel = 'Add',
  placeholder = 'Add your comment...',
  autoFocus = false,
  autoListen = false,
  busy = false,
  busyLabel,
  error,
  variant = 'default',
  className,
}: CommentBoxProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { voiceInput, listening, voiceModeOn } = useCommentMic(setText, autoListen)
  const dictated = useRef(false)
  useEffect(() => {
    if (listening) dictated.current = true
  }, [listening])
  const canSubmit = !busy && !voiceInput.isFinalizing && (!!text.trim() || voiceInput.isRecording)

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  const handleSubmit = async () => {
    if (!canSubmit) return
    const said = listening ? (await voiceInput.stopRecording()) || text : text
    if (!textareaRef.current || !said.trim()) return
    onSubmit(said.trim(), { dictated: dictated.current })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e.nativeEvent)) return
    if (isSubmitEnter(e.nativeEvent)) {
      e.preventDefault()
      void handleSubmit()
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      if (!busy) onCancel()
    }
  }

  const glow = variant === 'glow'
  return (
    <div
      className={cn(
        'rounded-lg border p-2 space-y-2',
        glow
          ? 'comment-glow-box border-sky-400/70 bg-popover'
          : 'border-border bg-popover shadow-lg',
        className,
      )}
    >
      <div
        className={cn(
          'text-xs rounded p-1.5 truncate',
          glow ? 'bg-sky-400/10 text-sky-700 dark:text-sky-300' : 'text-muted-foreground bg-muted/50',
        )}
      >
        {label}
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        readOnly={busy}
        className={cn(
          'w-full text-xs rounded border bg-background p-2 resize-none focus:outline-none focus:ring-1',
          glow ? 'border-sky-400/40 focus:ring-sky-400' : 'border-border focus:ring-primary',
        )}
        rows={3}
      />
      <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} />
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-1">
        <VoiceInputButton voiceInput={voiceInput} message={text} disabled={voiceModeOn || busy} size="xs" />
        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          className={cn('h-6 text-xs', glow && 'bg-sky-500 text-white hover:bg-sky-500/90')}
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
        >
          {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          {busy && busyLabel ? busyLabel : submitLabel}
        </Button>
      </div>
    </div>
  )
}

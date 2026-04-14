import type { ChangeEventHandler, ClipboardEventHandler, FocusEventHandler, KeyboardEventHandler, ReactNode, Ref } from 'react'
import { cn } from '@shared/lib/utils'
import { AttachmentPreview, type Attachment } from './attachment-preview'

interface ChatComposerBoxProps {
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  textareaRef?: Ref<HTMLTextAreaElement>
  value: string
  onChange: ChangeEventHandler<HTMLTextAreaElement>
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>
  onFocus?: FocusEventHandler<HTMLTextAreaElement>
  onBlur?: FocusEventHandler<HTMLTextAreaElement>
  placeholder: string
  disabled?: boolean
  rows?: number
  autoFocus?: boolean
  dataTestId?: string
  leftActions?: ReactNode
  rightActions?: ReactNode
  footer?: ReactNode
  className?: string
  textareaClassName?: string
}

export function ChatComposerBox({
  attachments,
  onRemoveAttachment,
  textareaRef,
  value,
  onChange,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  placeholder,
  disabled,
  rows = 2,
  autoFocus,
  dataTestId,
  leftActions,
  rightActions,
  footer,
  className,
  textareaClassName,
}: ChatComposerBoxProps) {
  return (
    <div className={cn(
      'mx-auto w-full rounded-2xl border border-border/60 bg-background/95 px-3 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80',
      className
    )}>
      <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />
      <div className={attachments.length > 0 ? 'mt-2' : ''}>
        <textarea
          ref={textareaRef}
          dir="auto"
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          autoFocus={autoFocus}
          data-testid={dataTestId}
          className={cn(
            'w-full resize-none rounded-md bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 min-h-[60px] max-h-[200px] overflow-y-auto',
            textareaClassName
          )}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">{leftActions}</div>
        <div className="flex items-center gap-2">{rightActions}</div>
      </div>
      {footer}
    </div>
  )
}

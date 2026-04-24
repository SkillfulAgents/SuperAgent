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
  topRightActions?: ReactNode
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
  topRightActions,
  footer,
  className,
  textareaClassName,
}: ChatComposerBoxProps) {
  return (
    <div className={cn(
      'group relative mx-auto w-full rounded-2xl border border-border/60 bg-background/95 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80',
      className
    )}>
      {topRightActions && (
        <div className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{topRightActions}</div>
      )}
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
            'w-full resize-none rounded-md bg-background pl-1 pr-4 py-0 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 max-h-[200px] overflow-y-auto',
            textareaClassName
          )}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">{leftActions}</div>
        <div className="flex items-center gap-2">{rightActions}</div>
      </div>
      {footer}
    </div>
  )
}

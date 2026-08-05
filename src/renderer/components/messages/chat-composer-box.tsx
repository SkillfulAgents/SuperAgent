import { useCallback, useRef } from 'react'
import type {
  ClipboardEventHandler,
  FocusEventHandler,
  MutableRefObject,
  ReactNode,
  Ref,
} from 'react'
import { cn } from '@shared/lib/utils'
import { AttachmentPreview, type Attachment } from './attachment-preview'
import { SecretDetectionPrompt } from './secret-detection-prompt'
import type { PotentialSecret, SecuredSecret } from '@renderer/lib/secret-detection'
import { MarkdownComposerEditor } from './markdown-composer-editor'

const EMPTY_POTENTIAL_SECRETS: PotentialSecret[] = []
const EMPTY_SECURED_SECRETS: SecuredSecret[] = []

interface SecureSecretsProps {
  agentSlug: string
  potentialSecrets?: PotentialSecret[]
  securedSecrets?: SecuredSecret[]
  onDismiss: (candidate: PotentialSecret) => void
  onSecure: (candidate: PotentialSecret, secret: { key: string; envVar: string }) => void
  onRemove: (secrets: SecuredSecret[]) => void
}

interface ChatComposerBoxProps {
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  textareaRef?: Ref<HTMLDivElement>
  value: string
  onChange: (value: string) => void
  onKeyDown?: (event: KeyboardEvent) => void
  onPaste?: ClipboardEventHandler<HTMLDivElement>
  onFocus?: FocusEventHandler<HTMLDivElement>
  onBlur?: FocusEventHandler<HTMLDivElement>
  placeholder: string
  disabled?: boolean
  rows?: number
  autoFocus?: boolean
  enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send'
  dataTestId?: string
  leftActions?: ReactNode
  rightActions?: ReactNode
  topRightActions?: ReactNode
  footer?: ReactNode
  className?: string
  textareaClassName?: string
  secureSecrets?: SecureSecretsProps
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
  enterKeyHint,
  dataTestId,
  leftActions,
  rightActions,
  topRightActions,
  footer,
  className,
  textareaClassName,
  secureSecrets,
}: ChatComposerBoxProps) {
  const internalEditorRef = useRef<HTMLDivElement | null>(null)
  const setEditorRef = useCallback((node: HTMLDivElement | null) => {
    internalEditorRef.current = node
    if (typeof textareaRef === 'function') {
      textareaRef(node)
    } else if (textareaRef) {
      (textareaRef as MutableRefObject<HTMLDivElement | null>).current = node
    }
  }, [textareaRef])

  const potentialSecrets = secureSecrets?.potentialSecrets ?? EMPTY_POTENTIAL_SECRETS
  const securedSecrets = secureSecrets?.securedSecrets ?? EMPTY_SECURED_SECRETS

  return (
    <div className={cn(
      'group relative mx-auto w-full rounded-2xl border border-border/60 bg-background/95 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80',
      className
    )}>
      {topRightActions && (
        <div className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100">{topRightActions}</div>
      )}
      <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />
      <div
        className={cn('relative', attachments.length > 0 && 'mt-2')}
        onPaste={onPaste}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <MarkdownComposerEditor
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          dataTestId={dataTestId}
          minRows={rows}
          enterKeyHint={enterKeyHint}
          className={cn('max-h-[200px]', textareaClassName)}
          potentialSecrets={potentialSecrets}
          securedSecrets={securedSecrets}
          onRemoveSecuredSecrets={secureSecrets?.onRemove}
          onEditorElement={setEditorRef}
        />
      </div>
      {secureSecrets && potentialSecrets[0] && (
        <SecretDetectionPrompt
          agentSlug={secureSecrets.agentSlug}
          candidate={potentialSecrets[0]}
          onDismiss={secureSecrets.onDismiss}
          onSecure={secureSecrets.onSecure}
        />
      )}
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">{leftActions}</div>
        <div className="flex items-center gap-2">{rightActions}</div>
      </div>
      {footer}
    </div>
  )
}

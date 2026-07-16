import { useCallback, useRef } from 'react'
import type {
  ChangeEventHandler,
  ClipboardEventHandler,
  FocusEventHandler,
  KeyboardEventHandler,
  MutableRefObject,
  ReactNode,
  Ref,
} from 'react'
import { cn } from '@shared/lib/utils'
import { AttachmentPreview, type Attachment } from './attachment-preview'
import { SecretDetectionPrompt } from './secret-detection-prompt'
import type { PotentialSecret, SecuredSecret } from '@renderer/lib/secret-detection'

const EMPTY_POTENTIAL_SECRETS: PotentialSecret[] = []
const EMPTY_SECURED_SECRETS: SecuredSecret[] = []

interface SecureSecretsProps {
  agentSlug: string
  potentialSecrets?: PotentialSecret[]
  securedSecrets?: SecuredSecret[]
  onDismiss: (candidate: PotentialSecret) => void
  onSecure: (candidate: PotentialSecret, secret: { key: string; envVar: string }) => void
  onRemove: (secrets: SecuredSecret[], range: { start: number; end: number }) => void
}

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

interface Decoration {
  id: string
  kind: 'potential' | 'secured'
  start: number
  end: number
  secret?: SecuredSecret
}

function findDecorations(
  value: string,
  potentialSecrets: PotentialSecret[],
  securedSecrets: SecuredSecret[]
): Decoration[] {
  const decorations: Decoration[] = potentialSecrets
    .filter((candidate) => value.slice(candidate.start, candidate.end) === candidate.value)
    .map((candidate) => ({
      id: candidate.id,
      kind: 'potential' as const,
      start: candidate.start,
      end: candidate.end,
    }))

  const occupied = decorations.map(({ start, end }) => ({ start, end }))
  for (const secret of securedSecrets) {
    let searchFrom = 0
    let start = value.indexOf(secret.displayText, searchFrom)
    while (start !== -1 && occupied.some((range) => start < range.end && start + secret.displayText.length > range.start)) {
      searchFrom = start + secret.displayText.length
      start = value.indexOf(secret.displayText, searchFrom)
    }
    if (start === -1) continue
    const end = start + secret.displayText.length
    decorations.push({ id: secret.id, kind: 'secured', start, end, secret })
    occupied.push({ start, end })
  }

  return decorations.sort((a, b) => a.start - b.start)
}

function DecoratedText({
  value,
  potentialSecrets,
  securedSecrets,
}: {
  value: string
  potentialSecrets: PotentialSecret[]
  securedSecrets: SecuredSecret[]
}) {
  const decorations = findDecorations(value, potentialSecrets, securedSecrets)
  const content: ReactNode[] = []
  let cursor = 0

  for (const decoration of decorations) {
    if (decoration.start > cursor) {
      content.push(<span key={`text-${cursor}`}>{value.slice(cursor, decoration.start)}</span>)
    }
    content.push(
      <span
        key={decoration.id}
        data-testid={decoration.kind === 'potential' ? 'potential-secret' : 'secured-secret'}
        className={cn(
          'rounded-[3px] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]',
          decoration.kind === 'potential'
            ? 'outline outline-1 outline-dotted outline-amber-500/90'
            : 'bg-amber-500/10 outline outline-1 outline-amber-500/70'
        )}
      >
        {value.slice(decoration.start, decoration.end)}
      </span>
    )
    cursor = decoration.end
  }
  if (cursor < value.length) content.push(<span key={`text-${cursor}`}>{value.slice(cursor)}</span>)

  return <>{content}</>
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
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    internalTextareaRef.current = node
    if (typeof textareaRef === 'function') {
      textareaRef(node)
    } else if (textareaRef) {
      (textareaRef as MutableRefObject<HTMLTextAreaElement | null>).current = node
    }
  }, [textareaRef])

  const potentialSecrets = secureSecrets?.potentialSecrets ?? EMPTY_POTENTIAL_SECRETS
  const securedSecrets = secureSecrets?.securedSecrets ?? EMPTY_SECURED_SECRETS
  const hasDecorations = potentialSecrets.length > 0 || securedSecrets.length > 0
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback((event) => {
    const isDeleteKey = event.key === 'Backspace' || event.key === 'Delete'
    if (secureSecrets && isDeleteKey && !event.nativeEvent.isComposing) {
      const { selectionStart, selectionEnd } = event.currentTarget
      const securedDecorations = findDecorations(value, potentialSecrets, securedSecrets)
        .filter((decoration) => decoration.kind === 'secured' && decoration.secret)
      const affected = securedDecorations.filter((decoration) => {
        if (selectionStart !== selectionEnd) {
          return decoration.start < selectionEnd && decoration.end > selectionStart
        }
        return event.key === 'Backspace'
          ? decoration.start < selectionStart && decoration.end >= selectionStart
          : decoration.start <= selectionStart && decoration.end > selectionStart
      })

      if (affected.length > 0) {
        event.preventDefault()
        const range = {
          start: Math.min(selectionStart, ...affected.map((decoration) => decoration.start)),
          end: Math.max(selectionEnd, ...affected.map((decoration) => decoration.end)),
        }
        secureSecrets.onRemove(
          affected.flatMap((decoration) => decoration.secret ? [decoration.secret] : []),
          range
        )
        requestAnimationFrame(() => {
          internalTextareaRef.current?.setSelectionRange(range.start, range.start)
        })
        return
      }
    }

    onKeyDown?.(event)
  }, [onKeyDown, potentialSecrets, secureSecrets, securedSecrets, value])

  return (
    <div className={cn(
      'group relative mx-auto w-full rounded-2xl border border-border/60 bg-background/95 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80',
      className
    )}>
      {topRightActions && (
        <div className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100">{topRightActions}</div>
      )}
      <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />
      <div className={cn('relative', attachments.length > 0 && 'mt-2')}>
        {hasDecorations && (
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md pl-1 pr-4 py-0 text-sm leading-5 text-transparent',
              textareaClassName
            )}
          >
            <DecoratedText
              value={value}
              potentialSecrets={potentialSecrets}
              securedSecrets={securedSecrets}
            />
          </div>
        )}
        <textarea
          ref={setTextareaRef}
          dir="auto"
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          onFocus={onFocus}
          onBlur={onBlur}
          onScroll={(event) => {
            if (mirrorRef.current) {
              mirrorRef.current.scrollTop = event.currentTarget.scrollTop
              mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          enterKeyHint={enterKeyHint}
          autoFocus={autoFocus}
          data-testid={dataTestId}
          className={cn(
            'relative w-full resize-none rounded-md bg-transparent pl-1 pr-4 py-0 text-sm leading-5 placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 max-h-[200px] overflow-y-auto [field-sizing:content]',
            textareaClassName
          )}
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

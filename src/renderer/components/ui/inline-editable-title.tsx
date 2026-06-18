import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@shared/lib/utils/cn'

type HeadingLevel = 'h1' | 'h2'

interface InlineEditableTitleProps {
  value: string
  canEdit: boolean
  isSaving: boolean
  onSave: (value: string) => void | Promise<void>
  onError?: (error: unknown) => void
  displayClassName?: string
  inputClassName?: string
  editContainerClassName?: string
  saveButtonClassName?: string
  readOnlyAs?: HeadingLevel
  ariaLabel?: string
  saveAriaLabel?: string
  displayTestId?: string
  inputTestId?: string
  saveButtonTestId?: string
}

export function InlineEditableTitle({
  value,
  canEdit,
  isSaving,
  onSave,
  onError,
  displayClassName,
  inputClassName,
  editContainerClassName,
  saveButtonClassName,
  readOnlyAs = 'h1',
  ariaLabel = 'Edit title',
  saveAriaLabel = 'Save title',
  displayTestId,
  inputTestId,
  saveButtonTestId,
}: InlineEditableTitleProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (!isEditing) setDraft(value)
  }, [isEditing, value])

  const cancel = () => {
    setDraft(value)
    setIsEditing(false)
  }

  const save = async () => {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === value) {
      cancel()
      return
    }

    try {
      await onSave(trimmed)
      setIsEditing(false)
    } catch (error) {
      onError?.(error)
    }
  }

  if (canEdit && isEditing) {
    return (
      <div className={cn('flex items-center gap-2 flex-1 min-w-0', editContainerClassName)}>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          autoFocus
          disabled={isSaving}
          className={inputClassName}
          data-testid={inputTestId}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn('shrink-0', saveButtonClassName)}
          onClick={() => { void save() }}
          disabled={isSaving}
          aria-label={saveAriaLabel}
          data-testid={saveButtonTestId}
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
        </Button>
      </div>
    )
  }

  if (canEdit) {
    return (
      <button
        type="button"
        className={cn('truncate text-left cursor-pointer hover:opacity-80', displayClassName)}
        onClick={() => setIsEditing(true)}
        aria-label={ariaLabel}
        data-testid={displayTestId}
      >
        {value}
      </button>
    )
  }

  if (readOnlyAs === 'h2') {
    return (
      <h2 className={cn('truncate', displayClassName)} data-testid={displayTestId}>
        {value}
      </h2>
    )
  }

  return (
    <h1 className={cn('truncate', displayClassName)} data-testid={displayTestId}>
      {value}
    </h1>
  )
}

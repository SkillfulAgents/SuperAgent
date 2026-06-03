import { cn } from '@shared/lib/utils/cn'

interface RequestErrorProps {
  message: string | null
  className?: string
  /**
   * Visual treatment. `default` is the standalone red banner; `compact` is the
   * tight, borderless destructive style used inline at the bottom of settings forms.
   */
  variant?: 'default' | 'compact'
}

const VARIANT_CLASSES: Record<NonNullable<RequestErrorProps['variant']>, string> = {
  default: '',
  compact: 'mt-0 bg-destructive/10 px-2 text-destructive dark:bg-destructive/10 dark:text-destructive',
}

export function RequestError({ message, className, variant = 'default' }: RequestErrorProps) {
  if (!message) return null

  return (
    <div
      className={cn(
        'mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      Error: {message}
    </div>
  )
}

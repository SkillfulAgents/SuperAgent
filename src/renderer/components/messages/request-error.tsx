import { cn } from '@shared/lib/utils/cn'

interface RequestErrorProps {
  message: string | null
  className?: string
}

export function RequestError({ message, className }: RequestErrorProps) {
  if (!message) return null

  return (
    <div
      className={cn(
        'mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300',
        className,
      )}
    >
      Error: {message}
    </div>
  )
}

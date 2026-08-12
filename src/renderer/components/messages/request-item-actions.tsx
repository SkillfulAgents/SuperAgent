import { createContext, useContext, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { RequestError } from './request-error'

export const RequestItemErrorContext = createContext<string | null>(null)

interface RequestItemActionsProps {
  children: ReactNode
  className?: string
  /** Plain end-aligned row (no sticky footer / full-width divider). */
  inline?: boolean
}

export function RequestItemActions({ children, className, inline }: RequestItemActionsProps) {
  const error = useContext(RequestItemErrorContext)

  if (inline) {
    return (
      <div
        className={cn('flex justify-end gap-2 pt-4', className)}
        data-request-item-actions="inline"
      >
        {children}
      </div>
    )
  }

  return (
    <div
      className="shrink-0 flex flex-col gap-2 border-t border-border bg-background p-4"
      data-request-item-actions="footer"
    >
      <div className={cn('flex justify-end gap-2', className)}>{children}</div>
      {error ? <RequestError message={error} className="mt-0" /> : null}
    </div>
  )
}

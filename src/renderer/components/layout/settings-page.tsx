import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils/cn'

interface SettingsPageContainerProps {
  children: ReactNode
  className?: string
}

/**
 * Shared page frame for settings-style pages (Agent Connections, and upcoming
 * sibling pages). Centers content at 720px, adds vertical rhythm, and scrolls
 * independently of the app shell.
 */
export function SettingsPageContainer({ children, className }: SettingsPageContainerProps) {
  return (
    <div className="flex-1 overflow-auto">
      <div className={cn('mx-auto w-full max-w-[720px] px-6 pt-10 pb-6 space-y-10', className)}>
        {children}
      </div>
    </div>
  )
}

interface PageTitleProps {
  title: string
  back?: { onClick: () => void; label?: string; testId?: string }
  actions?: ReactNode
}

/**
 * Page heading with optional back button and right-aligned actions.
 */
export function PageTitle({ title, back, actions }: PageTitleProps) {
  return (
    <div>
      {back && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 mb-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={back.onClick}
          data-testid={back.testId}
        >
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          {back.label ?? 'Back'}
        </Button>
      )}
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-xl font-medium">{title}</h2>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </div>
  )
}

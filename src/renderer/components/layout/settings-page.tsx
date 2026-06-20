import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils/cn'

interface SettingsPageContainerProps {
  children: ReactNode
  className?: string
  /** Use a wider, less padded frame for content like tables. */
  fullScreen?: boolean
  /** Drop the 720px cap and fill the full inset width (sub-views lay out their own width). */
  fullWidth?: boolean
}

/**
 * Shared page frame for settings-style pages (Agent Connections, and upcoming
 * sibling pages). Centers content at 720px, adds vertical rhythm, and scrolls
 * independently of the app shell.
 */
export function SettingsPageContainer({ children, className, fullScreen, fullWidth }: SettingsPageContainerProps) {
  return (
    <div className="flex-1 overflow-auto">
      <div
        className={cn(
          'mx-auto w-full px-6 pt-10 pb-6 space-y-10',
          fullWidth ? 'max-w-none' : 'max-w-[720px]',
          fullScreen && 'max-w-5xl pt-4 space-y-6',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

interface PageTitleProps {
  title: ReactNode
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
        {typeof title === 'string' ? (
          <h2 className="text-xl font-medium">{title}</h2>
        ) : (
          <div className="min-w-0 flex-1">{title}</div>
        )}
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </div>
  )
}

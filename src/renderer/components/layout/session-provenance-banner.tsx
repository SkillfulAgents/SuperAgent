import { ChevronLeft, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface SessionProvenanceBannerProps {
  icon: LucideIcon
  text: ReactNode
  /** Omit to render the sentence with no back button (e.g. the target is gone). */
  back?: { label: string; onClick: () => void; testId?: string }
  testId?: string
}

/** One-line provenance strip above the chat column. Callers own copy, icon, and navigation. */
export function SessionProvenanceBanner({
  icon: Icon,
  text,
  back,
  testId,
}: SessionProvenanceBannerProps) {
  return (
    <div className="shrink-0 border-b bg-background px-4 py-2" data-testid={testId}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {back && (
          <>
            <button
              onClick={back.onClick}
              className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
              data-testid={back.testId}
            >
              <ChevronLeft className="h-3 w-3" />
              {back.label}
            </button>
            <span className="mx-1 text-border">|</span>
          </>
        )}
        <Icon className="h-3 w-3 shrink-0" />
        <span>{text}</span>
      </div>
    </div>
  )
}

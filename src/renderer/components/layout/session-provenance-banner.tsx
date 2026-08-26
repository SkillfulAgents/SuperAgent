import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'

interface SessionProvenanceBannerProps {
  icon: ReactNode
  text: ReactNode
  backLabel: string
  /** Omit to render the sentence with no back button (e.g. the target is gone). */
  onBack?: () => void
  testId?: string
  backButtonTestId?: string
}

/** One-line provenance strip above the chat column. Callers own copy, icon, and navigation. */
export function SessionProvenanceBanner({
  icon,
  text,
  backLabel,
  onBack,
  testId,
  backButtonTestId,
}: SessionProvenanceBannerProps) {
  return (
    <div className="shrink-0 border-b bg-background px-4 py-2" data-testid={testId}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {onBack && (
          <>
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
              data-testid={backButtonTestId}
            >
              <ChevronLeft className="h-3 w-3" />
              {backLabel}
            </button>
            <span className="mx-1 text-border">|</span>
          </>
        )}
        {icon}
        <span>{text}</span>
      </div>
    </div>
  )
}

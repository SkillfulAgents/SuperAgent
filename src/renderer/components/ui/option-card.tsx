import type { ReactNode } from 'react'

export interface OptionCardProps {
  title: string
  description: ReactNode
  icon: ReactNode
  buttonLabel: string
  onClick: () => void
  className?: string
}

export function OptionCard({ title, description, icon, buttonLabel, onClick, className }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${title} — ${buttonLabel}`}
      className={`w-full text-left rounded-lg border p-5 flex items-center justify-between gap-4 cursor-pointer opacity-60 hover:opacity-100 focus-visible:opacity-100 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-all ${className ?? ''}`}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <span className="inline-flex items-center gap-2 shrink-0 text-sm text-muted-foreground">
        {icon}
        {buttonLabel}
      </span>
    </button>
  )
}

import type { ReactNode } from 'react'

export interface OptionCardProps {
  title: string
  icon: ReactNode
  onClick: () => void
  className?: string
}

export function OptionCard({ title, icon, onClick, className }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className={`text-left rounded-xl bg-muted px-4 py-2 flex items-center gap-2 cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors text-foreground ${className ?? ''}`}
    >
      {icon}
      <span className="text-xs font-medium">{title}</span>
    </button>
  )
}

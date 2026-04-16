import type { ReactNode } from 'react'

// TODO: migrate home-crons, home-skills, home-volumes, home-bookmarks rows to use HomeRow.
// home-crons currently uses a <button> outer which nests buttons (invalid HTML + breaks Radix focus).

interface HomeRowProps {
  onActivate: () => void
  children: ReactNode
  actions?: ReactNode
}

export function HomeRow({ onActivate, children, actions }: HomeRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="group relative py-3 px-4 hover:bg-muted/50 transition-colors cursor-pointer"
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate()
        }
      }}
    >
      {children}
      {actions && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  )
}

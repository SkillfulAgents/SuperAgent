import type { LucideIcon } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

export interface TrayDef {
  id: string
  icon: LucideIcon
  label: string
  available: boolean
  badge?: number
  content: React.ReactNode
}

interface TrayTabStripProps {
  trays: TrayDef[]
  selectedTrayId: string
  onSelect: (id: string) => void
}

export function TrayTabStrip({ trays, selectedTrayId, onSelect }: TrayTabStripProps) {
  const availableTrays = trays.filter(t => t.available)
  if (availableTrays.length < 2) return null

  return (
    <div className="flex flex-col items-center gap-2 py-3 px-1 border-l border-border/40 shrink-0 bg-muted/20 w-10">
      {availableTrays.map(tray => {
        const Icon = tray.icon
        const isActive = tray.id === selectedTrayId
        return (
          <button
            key={tray.id}
            onClick={() => onSelect(tray.id)}
            title={tray.label}
            className={cn(
              'relative flex flex-col items-center gap-1 py-1.5 px-1 rounded-md transition-colors w-full',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span
              className="text-[9px] font-medium leading-none whitespace-nowrap"
              style={{ writingMode: 'vertical-rl' }}
            >
              {tray.label}
            </span>
            {tray.badge != null && tray.badge > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-primary text-primary-foreground text-[9px] font-medium flex items-center justify-center px-0.5">
                {tray.badge > 9 ? '9+' : tray.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

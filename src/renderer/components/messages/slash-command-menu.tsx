
import { useRef, useEffect } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { SlashCommandInfo } from '@shared/lib/container/types'

interface SlashCommandMenuProps {
  commands: SlashCommandInfo[]
  selectedIndex: number
  onSelect: (name: string) => void
  visible: boolean
  filter: string
}

function HighlightedName({ name, filter }: { name: string; filter: string }) {
  if (!filter) {
    return <>{name}</>
  }
  const idx = name.toLowerCase().indexOf(filter.toLowerCase())
  if (idx === -1) {
    return <>{name}</>
  }
  return (
    <>
      {name.slice(0, idx)}
      <span className="font-bold">{name.slice(idx, idx + filter.length)}</span>
      {name.slice(idx + filter.length)}
    </>
  )
}

export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  visible,
  filter,
}: SlashCommandMenuProps) {
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!visible || commands.length === 0) return null

  return (
    <div
      className="absolute bottom-full left-0 right-0 max-h-48 overflow-y-auto border-t bg-popover text-popover-foreground shadow-md z-50"
      role="listbox"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          ref={(el) => { if (el) itemRefs.current.set(i, el) }}
          role="option"
          aria-selected={i === selectedIndex}
          className={cn(
            'w-full text-left px-3 py-1.5 text-sm cursor-pointer flex items-baseline gap-3',
            'hover:bg-accent hover:text-accent-foreground',
            i === selectedIndex && 'bg-accent text-accent-foreground'
          )}
          onMouseDown={(e) => {
            e.preventDefault() // Prevent textarea blur
            onSelect(cmd.name)
          }}
        >
          <span className="font-mono shrink-0">
            /<HighlightedName name={cmd.name} filter={filter} />
            {cmd.argumentHint && (
              <span className="text-muted-foreground"> {cmd.argumentHint}</span>
            )}
          </span>
          {cmd.description && (
            <span className="text-muted-foreground truncate">{cmd.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}

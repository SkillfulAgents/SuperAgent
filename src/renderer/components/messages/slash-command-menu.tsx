import { useRef, useEffect, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { SlashCommandInfo } from '@shared/lib/container/types'

export interface ComposerMenuItem {
  key: string
  primary: ReactNode
  secondary?: ReactNode
  leading?: ReactNode
}

interface ComposerMenuProps {
  items: ComposerMenuItem[]
  selectedIndex: number
  onSelect: (key: string) => void
  visible: boolean
  testId: string
  header?: ReactNode
}

export function ComposerMenu({ items, selectedIndex, onSelect, visible, testId, header }: ComposerMenuProps) {
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!visible || (items.length === 0 && !header)) return null

  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-1.5 w-[min(26.25rem,100%)] max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      role="listbox"
      data-testid={testId}
    >
      {header ? (
        <div className={items.length > 0 ? 'mb-0.5 border-b border-border pb-0.5' : undefined}>
          {header}
        </div>
      ) : null}
      {items.map((item, i) => (
        <button
          key={item.key}
          ref={(el) => { if (el) itemRefs.current.set(i, el) }}
          role="option"
          aria-selected={i === selectedIndex}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-[7px] text-left text-sm',
            'hover:bg-accent hover:text-accent-foreground',
            i === selectedIndex && 'bg-accent text-accent-foreground'
          )}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(item.key)
          }}
        >
          {item.leading}
          <span className="flex min-w-0 flex-1 flex-col items-start gap-px leading-tight">
            <span className="w-full truncate">{item.primary}</span>
            {item.secondary ? (
              <span className="w-full truncate text-xs text-muted-foreground">{item.secondary}</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  )
}

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
      <span className="font-medium">{name.slice(idx, idx + filter.length)}</span>
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
  const items = commands.map((cmd) => ({
    key: cmd.name,
    leading: (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted font-mono text-2xs font-semibold text-muted-foreground">
        /
      </span>
    ),
    primary: (
      <span className="font-mono text-[13px]">
        <HighlightedName name={cmd.name} filter={filter} />
        {cmd.argumentHint && <span className="text-muted-foreground"> {cmd.argumentHint}</span>}
      </span>
    ),
    secondary: cmd.description,
  }))
  return (
    <ComposerMenu
      items={items}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      visible={visible}
      testId="slash-command-menu"
    />
  )
}

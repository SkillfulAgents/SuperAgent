import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Braces, ChevronDown, Code, Italic, List, ListOrdered, Strikethrough, TextQuote } from 'lucide-react'
import { cn } from '@shared/lib/utils'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { MOD, ShortcutTooltip } from '@renderer/components/todo/todo-shortcuts'

export interface FormatStatus {
  active: string[]
  enabled: string[]
}

interface ToolbarFormat {
  name: string
  label: string
  shortcut?: string
}

const ICONS: Record<string, ReactNode> = {
  bold: <span className="text-[15px] font-bold leading-none">B</span>,
  italic: <Italic className="h-4 w-4" />,
  strike: <Strikethrough className="h-4 w-4" />,
  code: <Code className="h-4 w-4" />,
  bulletList: <List className="h-4 w-4" />,
  orderedList: <ListOrdered className="h-4 w-4" />,
  quote: <TextQuote className="h-4 w-4" />,
  codeBlock: <Braces className="h-4 w-4" />,
}
const GROUPS = [['bold', 'italic', 'strike', 'code'], ['bulletList', 'orderedList', 'quote', 'codeBlock']]
const HEADINGS = ['heading1', 'heading2', 'heading3']
const KEY_CAPS: Record<string, string> = MOD === '⌘' ? { Mod: MOD, Shift: '⇧', Alt: '⌥' } : { Mod: MOD, Shift: 'Shift', Alt: 'Alt' }

const keyCaps = (shortcut?: string) => shortcut?.split('-').map((key) => KEY_CAPS[key] ?? key.toUpperCase())
const keyLabel = (shortcut?: string) => keyCaps(shortcut)?.join(MOD === '⌘' ? '' : '+')

// Open: the row wipes out from the left and the buttons follow one by one. Closed: the reverse, quicker.
const ROW_MOTION = 'group/toolbar transition-[clip-path] duration-300 ease-out [clip-path:inset(0_0_0_0)] data-[state=closed]:pointer-events-none data-[state=closed]:duration-200 data-[state=closed]:ease-in data-[state=closed]:[clip-path:inset(0_100%_0_0)] motion-reduce:transition-none'
const ITEM_MOTION = 'flex shrink-0 transition-[opacity,transform] duration-200 ease-out [transition-delay:calc(var(--i)*20ms)] group-data-[state=closed]/toolbar:-translate-x-3 group-data-[state=closed]/toolbar:opacity-0 group-data-[state=closed]/toolbar:[transition-delay:calc(var(--reverse-i)*12ms)] motion-reduce:transition-none'
const BUTTON_ORDER = GROUPS.flat()
const itemOrder = (i: number) => ({ '--i': i, '--reverse-i': BUTTON_ORDER.length - i }) as CSSProperties

/** The formatting buttons above a composer's text, each lit while its format applies at the cursor. */
export function FormattingToolbar({ formats, status, disabled, className, normalTextShortcut, onFormat, onNormalText, onMenuClose }: {
  formats: ToolbarFormat[]
  status: FormatStatus
  disabled: boolean
  className?: string
  normalTextShortcut: string
  onFormat: (name: string) => void
  onNormalText: () => void
  onMenuClose: () => void
}) {
  const byName = new Map(formats.map((format) => [format.name, format]))
  const heading = HEADINGS.find((name) => status.active.includes(name))
  const [open, toggleOpen] = useFormattingToolbar()
  return (
    // Every button, Aa included, stays out of the Tab order, so Tab and dialog focus land on the text.
    <div className={cn('flex items-center gap-1 pb-1', className)}>
      <ShortcutTooltip label={open ? 'Hide formatting' : 'Show formatting'} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          tabIndex={-1}
          aria-label={open ? 'Hide formatting' : 'Show formatting'}
          aria-pressed={open}
          className="h-7 w-7 shrink-0 text-[13px] font-semibold text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
          onClick={toggleOpen}
          data-testid="formatting-toggle"
        >
          Aa
        </Button>
      </ShortcutTooltip>
      {/* Stays mounted while hidden, so hiding animates too. */}
      <div role="group" aria-label="Formatting" aria-hidden={!open} data-state={open ? 'open' : 'closed'} className={cn('flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', ROW_MOTION)}>
        <span className={ITEM_MOTION} style={itemOrder(0)}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" tabIndex={-1} disabled={disabled} className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" data-testid="formatting-text-style">
                {heading ? byName.get(heading)?.label : 'Text'}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            {/* Focus goes back to the text, not to the menu's trigger. */}
            <DropdownMenuContent align="start" className="min-w-40" onCloseAutoFocus={(event) => { event.preventDefault(); onMenuClose() }}>
              <DropdownMenuRadioGroup value={heading ?? 'text'}>
                <DropdownMenuRadioItem value="text" disabled={disabled} onSelect={() => { if (status.enabled.includes('text')) onNormalText() }}>
                  Text
                  <DropdownMenuShortcut>{keyLabel(normalTextShortcut)}</DropdownMenuShortcut>
                </DropdownMenuRadioItem>
                {HEADINGS.map((name) => (
                  <DropdownMenuRadioItem key={name} value={name} disabled={disabled || !status.enabled.includes(name)} onSelect={() => { if (name !== heading) onFormat(name) }}>
                    {byName.get(name)?.label}
                    <DropdownMenuShortcut>{keyLabel(byName.get(name)?.shortcut)}</DropdownMenuShortcut>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        {GROUPS.map((group) => (
          <div key={group[0]} className="flex shrink-0 items-center gap-0.5 border-l border-border/60 pl-0.5 ml-0.5">
            {group.map((name) => {
              const format = byName.get(name)
              if (!format) return null
              return (
                <ShortcutTooltip key={name} label={format.label} keys={keyCaps(format.shortcut)} side="top">
                  {/* The span is the tooltip's trigger, so a disabled button still shows its tooltip. */}
                  <span className={ITEM_MOTION} style={itemOrder(BUTTON_ORDER.indexOf(name) + 1)}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      tabIndex={-1}
                      aria-label={format.label}
                      aria-pressed={status.active.includes(name)}
                      disabled={disabled || !status.enabled.includes(name)}
                      className="h-7 w-7 text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onFormat(name)}
                    >
                      {ICONS[name]}
                    </Button>
                  </span>
                </ShortcutTooltip>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

const STORAGE_KEY = 'composer.formattingToolbar'
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const readStored = () => localStorage.getItem(STORAGE_KEY)

/** Whether the formatting toolbar shows. One choice per device, shared by every editor that offers it, shown until hidden. */
function useFormattingToolbar(): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, readStored) !== '0'
  const toggleOpen = () => {
    localStorage.setItem(STORAGE_KEY, open ? '0' : '1')
    listeners.forEach((listener) => listener())
  }
  return [open, toggleOpen]
}

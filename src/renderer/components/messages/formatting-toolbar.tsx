import { useSyncExternalStore, type ReactNode } from 'react'
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
import { VoiceToggleButton } from './voice-mode-controls'

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
  return (
    // Buttons stay out of the Tab order; each action's key is in its tooltip.
    <div role="group" aria-label="Formatting" className={cn('flex items-center gap-0.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" tabIndex={-1} disabled={disabled} className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" data-testid="formatting-text-style">
            {heading ? byName.get(heading)?.label : 'Text'}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        {/* Focus goes back to the text, not to the menu's trigger. */}
        <DropdownMenuContent align="start" onCloseAutoFocus={(event) => { event.preventDefault(); onMenuClose() }}>
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
      {GROUPS.map((group) => (
        <div key={group[0]} className="flex shrink-0 items-center gap-0.5 border-l border-border/60 pl-0.5 ml-0.5">
          {group.map((name) => {
            const format = byName.get(name)
            if (!format) return null
            return (
              <ShortcutTooltip key={name} label={format.label} keys={keyCaps(format.shortcut)} side="top">
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
              </ShortcutTooltip>
            )
          })}
        </div>
      ))}
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

/** Whether the formatting toolbar shows. One choice per device, shared by every composer that offers it; unset means `defaultOpen`. */
export function useFormattingToolbar(defaultOpen = true): [boolean, () => void] {
  const stored = useSyncExternalStore(subscribe, readStored)
  const open = stored === null ? defaultOpen : stored === '1'
  const toggleOpen = () => {
    localStorage.setItem(STORAGE_KEY, open ? '0' : '1')
    listeners.forEach((listener) => listener())
  }
  return [open, toggleOpen]
}

/** The Aa button that shows and hides the formatting toolbar. */
export function FormattingToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <VoiceToggleButton label={open ? 'Hide formatting' : 'Show formatting'} pressed={open} onClick={onToggle} testId="formatting-toggle" className="shrink-0 text-[13px] font-semibold aria-pressed:bg-muted">
      Aa
    </VoiceToggleButton>
  )
}

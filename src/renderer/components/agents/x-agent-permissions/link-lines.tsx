import { useRef, useState, type ReactNode } from 'react'
import { Ban, CircleCheckBig, Hand, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuLabel, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/components/ui/context-menu'
import { cn } from '@shared/lib/utils/cn'
import { endClick, possessive, isOn, lineWords, menuChoice, menuWrite, middleClick, showsEnd, type LinkAction, type LinkChange, type LinkChoice, type LinkDirection, type LinkEnd, type LinkLine } from './link-ends'

const END_TITLE: Record<LinkEnd, string> = {
  allowed: 'Allowed. Click to ask first instead',
  ask: 'Asks first. Click to allow',
  blocked: 'Blocked. Click to change',
}

type Side = 'left' | 'right'

const CHOICES: { value: LinkChoice; label: string; icon: typeof Ban }[] = [
  { value: 'allow', label: 'Allow', icon: CircleCheckBig },
  { value: 'ask', label: 'Ask first', icon: Hand },
  { value: 'block', label: 'Block', icon: Ban },
]

/** A small arrowhead pointing out of the line on its side, at the agent drawn there. */
function Arrowhead({ side }: { side: Side }) {
  return (
    <svg viewBox="0 0 8 8" className="h-2 w-2" aria-hidden="true">
      <path d={side === 'left' ? 'M8,0 L0,4 L8,8 Z' : 'M0,0 L8,4 L0,8 Z'} fill="currentColor" />
    </svg>
  )
}

function Line({
  action,
  line,
  self,
  other,
  first,
  selfSide,
  disabled,
  clickable,
  choices,
  fromEveryAgent,
  onToggle,
}: {
  action: LinkAction
  line: LinkLine
  self: string
  other: string
  first: LinkDirection
  selfSide: Side
  disabled: boolean
  /** Plain clicks change ends. Off where only the menu may (team mode's "every agent" row). */
  clickable: boolean
  choices: LinkChoice[]
  /** Ends the "Every agent" row set, which turning that row off undoes. */
  fromEveryAgent: LinkDirection[]
  onToggle: (changes: LinkChange[]) => void
}) {
  const [previewing, setPreviewing] = useState(false)
  const on = isOn(line.out) || isOn(line.in)
  const words = lineWords(action, line, self, other)
  const middle = disabled || !clickable ? [] : middleClick(line, first)
  const stroke = on ? 'border-solid border-foreground/70' : 'border-dashed border-border'
  // An arrowhead points at the agent that is acted on: `out` at the other agent, `in` at this one.
  const sideOf = (direction: LinkDirection): Side => (direction === 'in') === (selfSide === 'right') ? 'right' : 'left'
  const [leftDir, rightDir]: LinkDirection[] = selfSide === 'right' ? ['out', 'in'] : ['in', 'out']

  const end = (direction: LinkDirection) => {
    const state = line[direction]
    if (!showsEnd(line, direction, first)) return <span />
    if (state === 'blocked') {
      // A block never turns on from a plain toggle, so clicking the ✕ opens this direction's choices instead.
      const blocked = action === 'read'
        ? (direction === 'out' ? `${self} can’t read ${possessive(other)} chats and files` : `${other} can’t read ${possessive(self)} chats and files`)
        : (direction === 'out' ? `${self} can’t message ${other}` : `${other} can’t message ${self}`)
      return (
        <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <button type="button" className="flex h-6 items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring enabled:cursor-pointer" data-testid={`link-end-${action}-${direction}`}>
                <X className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                <span className="sr-only">{blocked}</span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 text-xs" data-testid={`link-blocked-tip-${action}-${direction}`}>
            <p className="font-medium">{blocked}</p>
            <p className="text-muted-foreground">{fromEveryAgent.includes(direction) ? 'Set by the Every agent row. Turning that row off lifts it.' : 'Set on this row.'}</p>
            <p className="text-muted-foreground">Click to change it.</p>
          </TooltipContent>
        </Tooltip>
          <DropdownMenuContent className="w-60" data-testid={`link-block-menu-${action}-${direction}`}>
            <DropdownMenuLabel className="text-xs">{question(direction)}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value="block" onValueChange={(value) => onToggle([{ direction, write: menuWrite(value as LinkChoice) }])}>
              {CHOICES.filter((c) => choices.includes(c.value)).map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value} className="text-xs" data-testid={`link-block-menu-${action}-${direction}-${value}`}>
                  <Icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />{label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
    const write = disabled || !clickable ? null : endClick(state)
    // While the middle is hovered, the ends it would change show their next state.
    const change = previewing ? middle.find((c) => c.direction === direction) : undefined
    const lit = change ? change.write === 'allow' : isOn(state)
    const setByRow = fromEveryAgent.includes(direction)
    const button = (
      <button
        type="button"
        disabled={!write}
        aria-label={`${describe(direction)}: ${END_TITLE[state]}`}
        aria-pressed={isOn(state)}
        onClick={() => write && onToggle([{ direction, write }])}
        className={cn(
          'flex h-6 items-center justify-center rounded-control transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          write && 'cursor-pointer',
          lit ? 'opacity-100' : direction === first ? 'opacity-40 hover:opacity-70' : 'opacity-25 hover:opacity-60',
        )}
        data-testid={`link-end-${action}-${direction}`}
      >
        <Arrowhead side={sideOf(direction)} />
      </button>
    )
    // A tooltip only when it says something the line doesn't: whose accounts a message runs with, and whether the
    // Every agent row set this end.
    const receiver = direction === 'out' ? other : self
    const accounts = action === 'message' ? `Messages run with ${possessive(receiver)} connected accounts.` : null
    if (!write || (!setByRow && !accounts)) return button
    // What the click will do, in words, and whether the Every agent row set it.
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs" data-testid={`link-end-tip-${action}-${direction}`}>
          {accounts && <p>{accounts}</p>}
          {setByRow && <p className="text-muted-foreground">Set by the Every agent row. Turning that row off undoes this.</p>}
        </TooltipContent>
      </Tooltip>
    )
  }

  // A menu heading asks the question its choices answer, so it never reads as the current state.
  const question = (direction: LinkDirection) => action === 'read'
    ? (direction === 'out' ? `Can ${self} read ${possessive(other)} chats and files?` : `Can ${other} read ${possessive(self)} chats and files?`)
    : (direction === 'out' ? `Can ${self} message ${other}?` : `Can ${other} message ${self}?`)
  const describe = (direction: LinkDirection) => action === 'read'
    ? (direction === 'out' ? `${self} can read ${possessive(other)} chats` : `${other} can read ${possessive(self)} chats`)
    : (direction === 'out' ? `${self} can message ${other}` : `${other} can message ${self}`)

  const fromRow = (['out', 'in'] as const).some((d) => isOn(line[d]) && fromEveryAgent.includes(d))
  // The middle's tooltip opens only when it adds something: the words are cut off, or the Every agent row set the link.
  const wordsRef = useRef<HTMLSpanElement>(null)
  const [tipOpen, setTipOpen] = useState(false)
  const cutOff = () => !!wordsRef.current && wordsRef.current.scrollWidth > wordsRef.current.clientWidth
  const middleButton = (
      <button
        type="button"
        disabled={middle.length === 0}
        onClick={() => onToggle(middle)}
        onMouseEnter={() => setPreviewing(true)}
        onMouseLeave={() => setPreviewing(false)}
        onFocus={() => setPreviewing(true)}
        onBlur={() => setPreviewing(false)}
        aria-label={middle.length > 0 ? `${middle.some((c) => c.write === 'allow') ? 'Turn on' : 'Turn off'}: ${words}` : words}
        className={cn('flex h-full min-w-0 items-center gap-1.5 rounded-control focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', middle.length > 0 && 'cursor-pointer', !on && 'opacity-60')}
        data-testid={`link-middle-${action}`}
      >
        <span className={cn('flex-1 border-t-2', stroke)} />
        <span ref={wordsRef} className="truncate text-[11px] leading-none">{words}</span>
        <span className={cn('flex-1 border-t-2', stroke)} />
      </button>
  )
  const grid = (
    <div className="grid h-6 grid-cols-[1.25rem_1fr_1.25rem] items-center" data-testid={`link-line-${action}`}>
      {end(leftDir)}
      {/* The full sentence, which a long agent name can cut off, and where an Every agent link came from. */}
      <Tooltip open={tipOpen} onOpenChange={(open) => setTipOpen(open && (fromRow || cutOff()))}>
        <TooltipTrigger asChild>{middleButton}</TooltipTrigger>
        <TooltipContent className="max-w-72 text-xs" data-testid={`link-middle-tip-${action}`}>
          {cutOff() && <p>{words}</p>}
          {fromRow && <p className="text-muted-foreground">Set by the Every agent row. Turning that row off undoes this.</p>}
        </TooltipContent>
      </Tooltip>
      {end(rightDir)}
    </div>
  )
  if (disabled) return grid

  // Right-click is where blocking lives, so a plain click never blocks by accident. Both directions are listed,
  // including one hidden while the line is off.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{grid}</ContextMenuTrigger>
      <ContextMenuContent className="w-60" data-testid={`link-menu-${action}`}>
        {([first, first === 'out' ? 'in' : 'out'] as LinkDirection[]).map((direction, i) => {
          const state = line[direction]
          return (
            <div key={direction}>
              {i > 0 && <ContextMenuSeparator />}
              <ContextMenuLabel className="text-xs">{question(direction)}</ContextMenuLabel>
              <ContextMenuRadioGroup value={menuChoice(state)} onValueChange={(value) => onToggle([{ direction, write: menuWrite(value as LinkChoice) }])}>
                {CHOICES.filter((c) => choices.includes(c.value)).map(({ value, label, icon: Icon }) => (
                  <ContextMenuRadioItem key={value} value={value} className="text-xs" data-testid={`link-menu-${action}-${direction}-${value}`}>
                    <Icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />{label}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </div>
          )
        })}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * The two links between this agent and another, one line per action: read above, message below. The left
 * arrowhead points at the other agent (this agent does it), the right one at this
 * agent (the other agent does it). Solid means allowed, faint means it asks first,
 * ✕ means blocked. `first` is the end shown more strongly before you hover.
 */
export function LinkLines({
  self,
  message,
  read,
  first = { message: 'out', read: 'out' },
  disabled = false,
  selfMark,
  stretch = false,
  selfSide = 'right',
  other = 'the agent',
  clickable = true,
  choices = ['allow', 'ask', 'block'],
  fromEveryAgent = [],
  onToggle,
  className,
}: {
  self: string
  /** How the lines name the other side: its name. Never "it". */
  other?: string
  /** This agent's avatar, drawn once at the right end, so both right-hand arrowheads point at something. */
  selfMark?: ReactNode
  /** Which side this agent is drawn on. Arrowheads always point at the agent on their side. */
  selfSide?: Side
  /** Fill the space the host gives it, instead of a fixed width. */
  stretch?: boolean
  message: LinkLine
  read: LinkLine
  first?: Record<LinkAction, LinkDirection>
  disabled?: boolean
  /** Plain clicks change ends. False leaves only the right-click menu. */
  clickable?: boolean
  /** What the right-click menu offers. */
  choices?: LinkChoice[]
  /** `read-out`-style keys for ends the "Every agent" row set. */
  fromEveryAgent?: string[]
  onToggle: (action: LinkAction, changes: LinkChange[]) => void
  className?: string
}) {
  const ends = (action: LinkAction) => (['out', 'in'] as const).filter((d) => fromEveryAgent.includes(`${action}-${d}`))
  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn('flex items-center gap-1.5', disabled && 'opacity-50', className)} data-testid="link-lines">
        <div className={cn('space-y-0.5', stretch ? 'min-w-0 flex-1' : 'w-56 sm:w-80')}>
          <Line action="read" line={read} self={self} other={other} first={first.read} selfSide={selfSide} disabled={disabled} clickable={clickable} choices={choices} fromEveryAgent={ends('read')} onToggle={(changes) => onToggle('read', changes)} />
          <Line action="message" line={message} self={self} other={other} first={first.message} selfSide={selfSide} disabled={disabled} clickable={clickable} choices={choices} fromEveryAgent={ends('message')} onToggle={(changes) => onToggle('message', changes)} />
        </div>
        {selfMark && <span className="shrink-0" title={self}>{selfMark}</span>}
      </div>
    </TooltipProvider>
  )
}

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import { Button } from '@renderer/components/ui/button'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useAgents } from '@renderer/hooks/use-agents'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { buildFolderSections, type AgentFolder } from '@renderer/lib/agent-folders'

export interface AgentDropdownSection {
  folder: AgentFolder
  agents: ApiAgent[]
}

/**
 * The agents to offer, as the sidebar shows them: in its order, grouped by
 * its folders, with empty folders left out. A search keeps the agents whose
 * name contains it, ignoring case, and the folders that still have any.
 */
export function agentDropdownSections(
  agents: ApiAgent[],
  settings: {
    agentOrder?: string[]
    agentFolders?: AgentFolder[]
    agentFolderAssignments?: Record<string, string>
    agentListOrder?: string[]
  } | undefined,
  query = '',
): AgentDropdownSection[] {
  const needle = query.trim().toLowerCase()
  return buildFolderSections(
    applyAgentOrder(agents, settings?.agentOrder),
    settings?.agentFolders,
    settings?.agentFolderAssignments,
    settings?.agentListOrder,
  )
    .map(({ folder, agents: inFolder }) => ({
      folder,
      agents: needle ? inFolder.filter((a) => a.name.toLowerCase().includes(needle)) : inFolder,
    }))
    .filter((section) => section.agents.length > 0)
}

export interface AgentDropdownProps {
  /** The selected agent's slug. */
  value: string | null
  onValueChange: (slug: string, agent: ApiAgent) => void
  /** Narrows the agents offered (e.g. to ones the person can run). */
  filter?: (agent: ApiAgent) => boolean
  /**
   * The button that opens it. Defaults to an outline button with the
   * selected agent's name, or `placeholder`.
   */
  trigger?: ReactNode
  placeholder?: string
  disabled?: boolean
  align?: 'start' | 'center' | 'end'
  /** Classes for the default trigger. */
  className?: string
  /** Test id prefix: `${testId}-search`, `${testId}-option-${slug}`. */
  testId?: string
}

/**
 * Pick an agent: a searchable list in the sidebar's order, with its folders
 * as sections when there is more than one. Arrow keys move through the
 * matches and Enter picks one.
 */
export function AgentDropdown({
  value,
  onValueChange,
  filter,
  trigger,
  placeholder = 'Select agent',
  disabled,
  align = 'start',
  className,
  testId = 'agent-dropdown',
}: AgentDropdownProps) {
  const { data: allAgents } = useAgents()
  const { data: settings } = useUserSettings()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  const agents = useMemo(() => (allAgents ?? []).filter((a) => !filter || filter(a)), [allAgents, filter])
  const selected = agents.find((a) => a.slug === value)
  // Folders show as sections only when there is more than one to tell apart.
  const sectioned = useMemo(() => agentDropdownSections(agents, settings).length > 1, [agents, settings])
  const sections = useMemo(() => agentDropdownSections(agents, settings, query), [agents, settings, query])
  const options = useMemo(() => sections.flatMap((s) => s.agents), [sections])

  // A new search starts at the first match.
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active=true]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const pick = (agent: ApiAgent) => {
    onValueChange(agent.slug, agent)
    close()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + options.length) % options.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const agent = options[active]
      if (agent) pick(agent)
    }
  }

  let index = -1
  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} modal>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger ?? (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            className={cn('h-8 justify-between gap-1.5 font-normal', !selected && 'text-muted-foreground', className)}
            data-testid={testId}
          >
            <span className="truncate">{selected ? selected.name : placeholder}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 overflow-hidden p-0" onWheel={(e) => e.stopPropagation()}>
        <div className="flex items-center border-b px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={options[active] ? `${listId}-${options[active].slug}` : undefined}
            aria-label="Search agents"
            placeholder="Search agents..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-testid={`${testId}-search`}
            autoFocus
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Agents" className="max-h-72 overflow-y-auto overscroll-contain p-1">
          {options.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {agents.length === 0 ? 'No agents yet.' : 'No agents found.'}
            </div>
          )}
          {sections.map(({ folder, agents: inSection }) => (
            <div key={folder.id} role="group" aria-label={sectioned ? folder.name : undefined}>
              {sectioned && (
                <div className="truncate px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground" aria-hidden="true">
                  {folder.name}
                </div>
              )}
              {inSection.map((agent) => {
                index += 1
                const i = index
                const isSelected = agent.slug === value
                return (
                  <div
                    key={agent.slug}
                    id={`${listId}-${agent.slug}`}
                    role="option"
                    aria-selected={isSelected}
                    data-active={i === active}
                    // Focus stays in the search box (aria-activedescendant);
                    // an option is focusable only by pointer.
                    tabIndex={-1}
                    onMouseMove={() => setActive(i)}
                    onClick={() => pick(agent)}
                    onKeyDown={(e) => { if (e.key === 'Enter') pick(agent) }}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                      i === active && 'bg-accent text-accent-foreground',
                    )}
                    data-testid={`${testId}-option-${agent.slug}`}
                  >
                    <Check className={cn('h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">
                      <HighlightMatch text={agent.name} query={query.trim()} />
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

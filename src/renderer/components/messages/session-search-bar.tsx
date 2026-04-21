import { ChevronUp, ChevronDown, Search } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { SessionSearch } from '@renderer/hooks/use-session-search'

interface Props {
  search: SessionSearch
}

export function SessionSearchBar({ search }: Props) {
  if (!search.open) return null

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) search.prev()
      else search.next()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      search.close()
    }
  }

  const hasQuery = search.query.length > 0
  const counter = hasQuery
    ? search.totalMatches === 0
      ? 'No matches'
      : `${search.currentIndex + 1} of ${search.totalMatches} ${search.totalMatches === 1 ? 'match' : 'matches'}`
    : ''

  const disabled = search.totalMatches === 0

  return (
    <div className="shrink-0 flex items-center gap-1.5 border-b bg-background px-3 py-0.5">
      <div className="flex-1" />
      <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring w-[420px] max-w-full">
        <Search className="h-3 w-3 ml-2 text-muted-foreground shrink-0" />
        <input
          ref={search.inputRef}
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in session"
          className="h-6 flex-1 min-w-0 bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground"
          autoFocus
          data-testid="session-search-input"
        />
        {counter && (
          <span
            className="text-[11px] text-muted-foreground shrink-0 px-1 tabular-nums whitespace-nowrap"
            data-testid="session-search-counter"
          >
            {counter}
          </span>
        )}
        <div className="flex items-center border-l border-border shrink-0">
          <button
            type="button"
            onClick={search.prev}
            disabled={disabled}
            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            aria-label="Previous match"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={search.next}
            disabled={disabled}
            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            aria-label="Next match"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>
      <Button
        variant="ghost"
        onClick={search.close}
        className="h-6 px-2 text-[11px]"
      >
        Done
      </Button>
    </div>
  )
}

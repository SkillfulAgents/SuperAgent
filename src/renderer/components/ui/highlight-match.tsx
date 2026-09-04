import { cn } from '@shared/lib/utils/cn'

/** Highlights the first occurrence of `query` within `text`. */
export function HighlightMatch({
  text,
  query,
  highlightClassName,
}: {
  text: string
  query: string
  highlightClassName?: string
}) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <span>
      {text.slice(0, idx)}
      <span className={cn('rounded-sm bg-yellow-200 dark:bg-yellow-800', highlightClassName)}>
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </span>
  )
}

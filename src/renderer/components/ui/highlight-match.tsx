/** Highlights the first occurrence of `query` within `text`. */
export function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <span>
      {text.slice(0, idx)}
      <span className="bg-yellow-200 dark:bg-yellow-800 rounded-sm">
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </span>
  )
}

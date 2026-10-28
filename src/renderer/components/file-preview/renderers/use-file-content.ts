import { useQuery } from '@tanstack/react-query'

/**
 * Hard cap on how much text we pull into the renderer. Measured in UTF-16 code
 * units (string length), which is what the previous inline fetches used.
 */
export const MAX_CONTENT_CHARS = 5_000_000

export interface FileContent {
  text: string
  /** True when the file exceeded MAX_CONTENT_CHARS and `text` is a prefix. */
  truncated: boolean
}

/**
 * Shared loader for text-like file previews. Text and CSV renderers both key on
 * ['file-content', url] (the CSV raw toggle reuses TextRenderer for the same
 * URL), so they must agree on the cached shape — hence a single hook rather than
 * inline useQuery calls. The truncation marker is returned as a flag instead of
 * being appended to the text, so callers can render a banner without polluting
 * parsed content.
 */
export function useFileContent(url: string) {
  return useQuery<FileContent>({
    queryKey: ['file-content', url],
    queryFn: async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to load file: ${res.status}`)
      const text = await res.text()
      if (text.length > MAX_CONTENT_CHARS) {
        return { text: text.slice(0, MAX_CONTENT_CHARS), truncated: true }
      }
      return { text, truncated: false }
    },
    staleTime: 30_000,
  })
}

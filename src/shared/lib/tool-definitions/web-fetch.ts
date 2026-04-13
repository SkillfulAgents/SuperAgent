export interface WebFetchInput {
  url?: string
}

function parseInput(input: unknown): WebFetchInput {
  return typeof input === 'object' && input !== null ? (input as WebFetchInput) : {}
}

function getSummary(input: unknown): string | null {
  const { url } = parseInput(input)
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '')
  } catch {
    return url.length > 60 ? url.slice(0, 57) + '...' : url
  }
}

export const webFetchDef = { displayName: 'Web Fetch', iconName: 'ExternalLink', parseInput, getSummary } as const

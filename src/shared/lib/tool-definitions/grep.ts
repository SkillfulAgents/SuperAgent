// TODO(delete): Grep was dropped from the Claude Agent SDK default toolset on
// 2026-06-09 (SDK 0.3.170), so this renderer no longer fires for new sessions.
// Kept only so old transcripts still render; safe to remove in a few months.
export interface GrepInput {
  pattern?: string
  path?: string
}

function parseInput(input: unknown): GrepInput {
  return typeof input === 'object' && input !== null ? (input as GrepInput) : {}
}

function getSummary(input: unknown): string | null {
  const { pattern, path } = parseInput(input)
  if (!pattern) return null
  const parts = [`/${pattern}/`]
  if (path) parts.push(`in ${path}`)
  return parts.join(' ')
}

export const grepDef = { displayName: 'Grep', parseInput, getSummary } as const

// TODO(delete): Glob was dropped from the Claude Agent SDK default toolset on
// 2026-06-09 (SDK 0.3.170), so this renderer no longer fires for new sessions.
// Kept only so old transcripts still render; safe to remove in a few months.
export interface GlobInput {
  pattern?: string
  path?: string
}

function parseInput(input: unknown): GlobInput {
  return typeof input === 'object' && input !== null ? (input as GlobInput) : {}
}

function getSummary(input: unknown): string | null {
  return parseInput(input).pattern ?? null
}

export const globDef = { displayName: 'Glob', iconName: 'FolderSearch', parseInput, getSummary } as const

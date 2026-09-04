import { toWorkspaceRelativePath } from '@shared/lib/utils/workspace-path'

export interface WriteInput {
  file_path?: string
  content?: string
}

function parseInput(input: unknown): WriteInput {
  return typeof input === 'object' && input !== null ? (input as WriteInput) : {}
}

function getSummary(input: unknown): string | null {
  const { file_path } = parseInput(input)
  // Read's summary and this one are the same question. This copy replaced the
  // prefix anywhere in the string rather than only at the start, and left a
  // trailing slash on, so the two tools named the same path differently.
  return file_path ? toWorkspaceRelativePath(file_path) : null
}

export const writeDef = { displayName: 'Write', parseInput, getSummary } as const

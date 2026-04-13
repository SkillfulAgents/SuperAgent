export interface ReadInput {
  file_path?: string
  offset?: number
  limit?: number
}

function parseInput(input: unknown): ReadInput {
  return typeof input === 'object' && input !== null ? (input as ReadInput) : {}
}

export function getDisplayPath(filePath: string): string {
  if (filePath.startsWith('/workspace/')) {
    return filePath.replace('/workspace/', '')
  }
  return filePath
}

function getSummary(input: unknown): string | null {
  const { file_path } = parseInput(input)
  return file_path ? getDisplayPath(file_path) : null
}

export const readDef = { displayName: 'Read', iconName: 'FileText', parseInput, getSummary } as const

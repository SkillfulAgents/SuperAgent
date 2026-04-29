export interface WriteInput {
  file_path?: string
  content?: string
}

function parseInput(input: unknown): WriteInput {
  return typeof input === 'object' && input !== null ? (input as WriteInput) : {}
}

function getDisplayPath(filePath: string): string {
  if (filePath.startsWith('/workspace/')) {
    return filePath.replace('/workspace/', '')
  }
  return filePath
}

function getSummary(input: unknown): string | null {
  const { file_path } = parseInput(input)
  return file_path ? getDisplayPath(file_path) : null
}

export const writeDef = { displayName: 'Write', iconName: 'FilePlus', parseInput, getSummary } as const

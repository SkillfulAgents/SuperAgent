export interface DeliverFileInput {
  filePath?: string
  description?: string
}

function parseInput(input: unknown): DeliverFileInput {
  return typeof input === 'object' && input !== null ? (input as DeliverFileInput) : {}
}

export function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function getSummary(input: unknown): string | null {
  const { filePath } = parseInput(input)
  return filePath ? getFilename(filePath) : null
}

export const deliverFileDef = { displayName: 'Deliver File', iconName: 'Download', parseInput, getSummary } as const

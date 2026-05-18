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

function getSummary(_input: unknown): string | null {
  return null
}

export const deliverFileDef = { displayName: 'Deliver File', iconName: 'Download', parseInput, getSummary } as const

export interface MonitorInput {
  description?: string
  /** A shell command: each stdout line is an event. */
  command?: string
  /** A WebSocket to open instead: each text frame is an event. */
  ws?: { url?: string; protocols?: string[] }
  timeout_ms?: number
}

function parseInput(input: unknown): MonitorInput {
  return typeof input === 'object' && input !== null ? (input as MonitorInput) : {}
}

function getSummary(input: unknown): string | null {
  const { description, command, ws } = parseInput(input)
  if (typeof description === 'string' && description) return description
  if (typeof ws?.url === 'string' && ws.url) return ws.url
  if (typeof command === 'string' && command) {
    const firstLine = command.split('\n')[0]
    return firstLine.length > 50 ? `$ ${firstLine.slice(0, 47)}...` : `$ ${firstLine}`
  }
  return null
}

export const monitorDef = { displayName: 'Monitor', parseInput, getSummary } as const

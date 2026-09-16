export const AGENT_MEMORY_DIR = '.claude/projects/-workspace/memory'
export const MAX_MEMORY_BYTES = 1024 * 1024

export class MemoryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 422) {
    super(message)
  }
}


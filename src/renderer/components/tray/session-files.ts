import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { collectDeliveries } from '@renderer/components/messages/delivered-files'
import { parseUserMessageParts } from '@shared/lib/utils/user-message-parts'

export interface SessionFile {
  filePath: string
  /** The agent's note on a delivered file. */
  description?: string
  /** The person uploaded it (the agent may have changed it since). */
  uploaded?: boolean
}

/** The tools that write a file, and the input field holding its path. */
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * The files of a session: the ones the person uploaded, and the ones the agent
 * delivered, wrote or edited, most recent first, each path once at its latest
 * touch. A delivery's note is kept, and an upload stays marked as one.
 */
export function collectSessionFiles(messages: ApiMessageOrBoundary[] | undefined): SessionFile[] {
  if (!messages) return []
  const notes = new Map(collectDeliveries(messages).map(file => [file.filePath, file.description]))
  const latest: string[] = []
  const uploaded = new Set<string>()
  const touch = (path: string) => {
    const at = latest.indexOf(path)
    if (at >= 0) latest.splice(at, 1)
    latest.push(path)
  }
  for (const message of messages) {
    if (message.type === 'user') {
      for (const path of parseUserMessageParts(message.content.text).attachedFiles) {
        uploaded.add(path)
        touch(path)
      }
      continue
    }
    if (message.type !== 'assistant') continue
    for (const call of message.toolCalls) {
      let path: string | undefined
      if (call.isError) continue
      if (call.name === 'mcp__user-input__deliver_file') {
        const value = (call.input as { filePath?: unknown } | undefined)?.filePath
        path = typeof value === 'string' && value ? value : undefined
      } else if (WRITE_TOOLS[call.name]) {
        const value = (call.input as Record<string, unknown> | undefined)?.[WRITE_TOOLS[call.name]]
        path = typeof value === 'string' && value ? value : undefined
      }
      if (path) touch(path)
    }
  }
  return latest.reverse().map(filePath => ({
    filePath,
    description: notes.get(filePath),
    ...(uploaded.has(filePath) ? { uploaded: true } : {}),
  }))
}

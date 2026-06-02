import { useEffect, useRef } from 'react'
import { useMessageStream } from './use-message-stream'
import { useFilePreview } from '@renderer/context/file-preview-context'

export function useFileDeliveryWatcher(
  sessionId: string | null,
  agentSlug: string | null
) {
  const { streamingToolUses } = useMessageStream(sessionId, agentSlug)
  const { openFile } = useFilePreview()
  const seenToolIdsRef = useRef(new Set<string>())
  const mountedRef = useRef(false)

  // Mark as mounted after initial render to avoid opening files from pre-existing streams
  useEffect(() => {
    const timer = setTimeout(() => {
      mountedRef.current = true
    }, 1000)
    return () => clearTimeout(timer)
  }, [sessionId])

  // Reset seen IDs when session changes
  useEffect(() => {
    seenToolIdsRef.current = new Set()
    mountedRef.current = false
    const timer = setTimeout(() => {
      mountedRef.current = true
    }, 1000)
    return () => clearTimeout(timer)
  }, [sessionId])

  useEffect(() => {
    if (!mountedRef.current || !agentSlug) return

    for (const tool of streamingToolUses) {
      if (
        tool.ready &&
        tool.name === 'mcp__user-input__deliver_file' &&
        !seenToolIdsRef.current.has(tool.id)
      ) {
        seenToolIdsRef.current.add(tool.id)
        try {
          const input = JSON.parse(tool.partialInput) as { filePath?: string; description?: string }
          if (input.filePath) {
            openFile(input.filePath, agentSlug, input.description)
          }
        } catch {
          // partial JSON, ignore
        }
      }
    }
  }, [streamingToolUses, agentSlug, openFile])
}

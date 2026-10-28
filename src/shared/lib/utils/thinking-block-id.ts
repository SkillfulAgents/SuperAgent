/**
 * Stable identity shared by the live SSE path and the persisted JSONL path.
 * Claude message ids are stable across both representations; the content
 * index distinguishes multiple thinking blocks within one assistant message.
 */
export function makeThinkingBlockId(
  messageId: string | null | undefined,
  blockIndex: number | null | undefined,
): string | undefined {
  if (!messageId || typeof blockIndex !== 'number' || !Number.isInteger(blockIndex) || blockIndex < 0) {
    return undefined
  }
  return `${messageId}:${blockIndex}`
}

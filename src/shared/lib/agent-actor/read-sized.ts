import type { ByteRange, OpenFile } from './types'

/**
 * A whole file's size and its bytes from one open file, the stream bounded
 * to that size: the byte count always matches what is streamed, even while
 * the file grows. With `range`, the stream is that inclusive slice, cut at
 * the size; `size` stays the whole file's. The open is released when the
 * stream ends or is cancelled.
 */
export async function readSized(opening: Promise<OpenFile>, range?: ByteRange): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> {
  const file = await opening
  try {
    const size = await file.size()
    const start = range ? Math.max(0, range.start) : 0
    const end = range ? Math.min(range.end, size - 1) : size - 1
    if (size === 0 || start > end) {
      await file.close()
      return { size, stream: new ReadableStream({ start: (controller) => controller.close() }) }
    }
    return { size, stream: file.stream({ start, end }) }
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
}

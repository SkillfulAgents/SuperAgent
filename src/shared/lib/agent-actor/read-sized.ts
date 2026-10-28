import type { OpenFile } from './types'

/**
 * A whole file's size and its bytes from one open file, the stream bounded
 * to that size: the byte count always matches what is streamed, even while
 * the file grows. The open is released when the stream ends or is cancelled.
 */
export async function readSized(opening: Promise<OpenFile>): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> {
  const file = await opening
  try {
    const size = await file.size()
    if (size === 0) {
      await file.close()
      return { size, stream: new ReadableStream({ start: (controller) => controller.close() }) }
    }
    return { size, stream: file.stream({ start: 0, end: size - 1 }) }
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
}

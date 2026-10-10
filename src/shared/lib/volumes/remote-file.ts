import type { ByteRange } from '@shared/lib/agent-actor/types'
import type { VolumeFile } from './base-mountable-volume'
import { VolumeError } from './volume-error'

/** A file of a known size whose bytes come from `download`, a fetch of one byte range. The
 * download starts before WebDAV sends headers, so an upstream failure keeps its status. The
 * stream honors the range even when upstream ignores it, and fails rather than serve a cut or
 * mismatched file. */
export function rangedVolumeFile(size: number, download: (range: ByteRange) => Promise<Response>): VolumeFile {
  let used = false
  return {
    size,
    close: async () => { used = true },
    stream: async range => {
      if (used) throw new Error('Volume file has already been consumed')
      used = true
      const start = range?.start ?? 0
      const end = range?.end ?? size - 1
      let remaining = Math.max(0, end - start + 1)
      const response = remaining ? await download({ start, end }) : null
      if (response?.status === 206 && response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
        await response.body?.cancel()
        throw new VolumeError('File download returned an unexpected byte range', 503)
      }
      let skip = response?.status === 206 ? 0 : start
      const reader = response?.body?.getReader()
      if (remaining && !reader) throw new Error('File download returned no content')
      return new ReadableStream<Uint8Array>({
        pull: async controller => {
          if (!remaining) { controller.close(); return }
          while (reader) {
            const { value, done } = await reader.read()
            if (done) throw new Error('File download ended early')
            const skipped = Math.min(skip, value.length)
            skip -= skipped
            const available = value.subarray(skipped)
            const bytes = available.subarray(0, remaining)
            if (!bytes.length) continue
            // A range reaching the end must find no further bytes, or the file is longer than listed.
            // Check before the last bytes go out, so a reader never sees a complete-looking cut file.
            if (end === size - 1 && bytes.length === remaining && (available.length > remaining || !(await reader.read()).done)) {
              throw new Error('File download returned more than its listed size')
            }
            remaining -= bytes.length
            controller.enqueue(bytes)
            if (!remaining) {
              await reader.cancel()
              controller.close()
            }
            return
          }
        },
        cancel: async () => { await reader?.cancel() },
      })
    },
  }
}


import type { IncomingMessage, Server } from 'node:http'

const control = Symbol.for('gamut.streaming-upload-timeout')
type UploadRequest = IncomingMessage & { [control]?: () => void }

/** Node's five-minute request deadline also counts time spent backpressured by
 * a cloud upload. Keep that deadline for ordinary requests; only an authorized
 * volume PUT can replace it with an inactivity deadline. Header limits remain
 * Node's own. The symbol survives dev-server module reloads. */
export function configureUploadTimeouts(server: Server, timeoutMs = 300_000): void {
  server.requestTimeout = 0
  server.prependListener('request', (request: UploadRequest, response) => {
    let timer: ReturnType<typeof setTimeout>
    let streaming = false
    const cleanup = () => {
      clearTimeout(timer)
      request.socket.off('data', activity)
      delete request[control]
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!request.complete) {
          if (!response.headersSent) response.writeHead(408).end()
          request.destroy()
        }
        cleanup()
      }, timeoutMs)
      timer.unref()
    }
    const activity = () => { if (streaming) arm() }
    request[control] = () => {
      streaming = true
      // Observe socket traffic, not request data: a request 'data' listener
      // would switch it to flowing mode before the upload has a reader.
      request.socket.on('data', activity)
      arm()
    }
    request.once('end', cleanup)
    request.once('close', cleanup)
    response.once('finish', () => { if (request.complete) cleanup() })
    arm()
  })
}

/** Call after authenticating the agent and resolving its volume attachment. */
export function allowStreamingUpload(incoming: IncomingMessage | undefined): void {
  ;(incoming as UploadRequest | undefined)?.[control]?.()
}

import WebSocket from 'ws'
import { z } from 'zod'

const cdpVersionSchema = z.object({ webSocketDebuggerUrl: z.string().min(1) })

/**
 * Ask Chrome to quit via CDP `Browser.close`. Unlike SIGTERM, this runs
 * Chrome's normal shutdown, which flushes cookies written in the last ~30s
 * to disk. Resolves true once Chrome accepted the command, false when its
 * CDP endpoint could not be reached.
 */
export async function requestChromeClose(cdpHttpUrl: string, timeoutMs = 2000): Promise<boolean> {
  let webSocketDebuggerUrl: string
  try {
    const response = await fetch(`${cdpHttpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    webSocketDebuggerUrl = cdpVersionSchema.parse(await response.json()).webSocketDebuggerUrl
  } catch {
    return false
  }

  return new Promise<boolean>((resolve) => {
    let sent = false
    const ws = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: timeoutMs })
    const timer = setTimeout(() => {
      ws.terminate()
      resolve(false)
    }, timeoutMs)
    const finish = (accepted: boolean) => {
      clearTimeout(timer)
      resolve(accepted)
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      sent = true
    })
    ws.on('message', (raw) => {
      try {
        if (JSON.parse(raw.toString()).id === 1) finish(true)
      } catch { /* not our reply */ }
    })
    // Chrome may drop the socket while exiting instead of replying.
    ws.on('close', () => finish(sent))
    ws.on('error', () => finish(false))
  })
}

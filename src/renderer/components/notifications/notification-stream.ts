import { useEffect } from 'react'
import { useUser } from '@renderer/context/user-context'
import { getApiBaseUrl } from '@renderer/lib/env'

export interface PreopenedNotificationStream {
  es: EventSource
  requestedAt: number
  frames: MessageEvent[]
}

let held: (PreopenedNotificationStream & { release: () => void }) | null = null

export function preopenNotificationStream(): void {
  if (held) return
  const es = new EventSource(`${getApiBaseUrl()}/api/notifications/stream`)
  const stream = { es, requestedAt: Date.now(), frames: [] as MessageEvent[], release: () => {} }
  const keepFrame = (event: MessageEvent) => { stream.frames.push(event) }
  // The browser asks again after an error, so the next connect counts from here.
  const noteRetry = () => { stream.requestedAt = Date.now() }
  es.addEventListener('message', keepFrame)
  es.addEventListener('error', noteRetry)
  stream.release = () => {
    es.removeEventListener('message', keepFrame)
    es.removeEventListener('error', noteRetry)
  }
  held = stream
}

/** Hands the stream opened at sign-in, with the frames it received so far, to its one reader. */
export function takePreopenedNotificationStream(): PreopenedNotificationStream | null {
  const stream = held
  held = null
  if (!stream) return null
  stream.release()
  if (stream.es.readyState === EventSource.CLOSED) return null
  return stream
}

export function closePreopenedNotificationStream(): void {
  held?.release()
  held?.es.close()
  held = null
}

// A deep link mounts the router, and the handler that reads this stream, only
// after the route's code loads, about a second after the startup reads. Opened
// here, the stream starts with those reads, so its `connected` refetch can skip
// them (needsRefetchOnConnect).
export function PreopenNotificationStream(): null {
  const { authGeneration } = useUser()
  useEffect(() => {
    preopenNotificationStream()
    return closePreopenedNotificationStream
  }, [authGeneration])
  return null
}

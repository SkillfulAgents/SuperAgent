export const STREAM_RECONNECT_MS = 1_000

export function watchStreamLiveness(
  es: EventTarget & { readyState: number },
  onDead: () => void,
): () => void {
  let disposed = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    es.removeEventListener('error', onError)
  }

  const onError = () => {
    if (disposed) return
    if (es.readyState !== EventSource.CLOSED) return
    dispose()
    onDead()
  }

  es.addEventListener('error', onError)
  return dispose
}

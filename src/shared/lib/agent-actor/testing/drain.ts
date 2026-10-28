/**
 * Hand each value of `stream` to `onValue` as it is read, the way the app
 * reads a session's events; returns the cancel. Values arrive a few
 * microtasks after they are sent: `drained()` waits them out.
 */
export function drain<T>(stream: ReadableStream<T>, onValue: (value: T) => void): () => void {
  const reader = stream.getReader()
  void (async () => {
    for (let next = await reader.read(); !next.done; next = await reader.read()) onValue(next.value)
  })()
  return () => void reader.cancel()
}

/** Until what was sent so far has been read. */
export function drained(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

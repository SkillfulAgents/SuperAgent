/** Bound waiting for headers and each body chunk, without limiting a healthy stream's lifetime. */
export async function fetchWithIdleTimeout(
  request: (input: string, init: RequestInit) => Promise<Response>,
  input: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const abort = new AbortController()
  const signal = init.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    timer = setTimeout(() => abort.abort(new DOMException('Speech synthesis stopped responding.', 'TimeoutError')), timeoutMs)
  }
  const clear = () => clearTimeout(timer)
  arm()
  let response: Response
  try { response = await request(input, { ...init, signal }) } finally { clear() }
  if (!response.body) return response
  const reader = response.body.getReader()
  let ended = false
  let output: ReadableStreamDefaultController<Uint8Array>
  const cleanup = () => { ended = true; clear(); signal.removeEventListener('abort', onAbort) }
  const onAbort = () => {
    if (ended) return
    cleanup()
    output.error(signal.reason)
    void reader.cancel(signal.reason).catch(() => {})
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    },
    async pull(controller) {
      if (ended) return
      arm()
      try {
        const { done, value } = await reader.read()
        clear()
        if (ended) return
        if (done) { cleanup(); reader.releaseLock(); controller.close() }
        else controller.enqueue(value)
      } catch (error) {
        if (!ended) { cleanup(); controller.error(error); void reader.cancel(error).catch(() => {}) }
      }
    },
    async cancel(reason) {
      cleanup()
      abort.abort(reason)
      await reader.cancel(reason).catch(() => {})
    },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

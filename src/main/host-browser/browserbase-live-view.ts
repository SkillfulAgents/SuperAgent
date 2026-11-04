// Browserbase signs live-view sockets with a `t` token, so page URLs must come
// from the `/debug` response; a URL built from session and page IDs is rejected.
export function pageWsUrlFromDebuggerUrl(debuggerUrl: string | undefined): string | null {
  if (!debuggerUrl) return null
  try {
    const wss = new URL(debuggerUrl).searchParams.get('wss')
    return wss ? `wss://${wss}` : null
  } catch {
    return null
  }
}

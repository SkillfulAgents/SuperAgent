// Opt-in: localStorage.setItem('superagent:voice-trace', '1') BEFORE entering voice mode.
// Console "Save as" truncates payloads; use window.__voiceTrace.download() (or copy(__voiceTrace.text())) for full JSONL.
const KEY = 'superagent:voice-trace'
const MAX_ENTRIES = 5000
const buffer: string[] = []

export function voiceTraceEnabled(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function voiceTrace(step: string, data: unknown): void {
  if (!voiceTraceEnabled()) return
  const at = new Date().toISOString()
  console.info(`[voice-trace] ${at} ${step}`, data)
  buffer.push(JSON.stringify({ at, step, data }))
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
}

function text(): string { return buffer.join('\n') + '\n' }

function download(): void {
  const url = URL.createObjectURL(new Blob([text()], { type: 'application/x-ndjson' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `voice-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  a.click()
  URL.revokeObjectURL(url)
}

declare global {
  interface Window { __voiceTrace?: { text(): string; download(): void; clear(): void; size(): number } }
}

if (typeof window !== 'undefined') {
  window.__voiceTrace = { text, download, clear: () => { buffer.length = 0 }, size: () => buffer.length }
}

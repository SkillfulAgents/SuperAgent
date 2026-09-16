// Opt-in: localStorage.setItem('superagent:voice-trace', '1'), then re-enter voice mode.
const KEY = 'superagent:voice-trace'

export function voiceTraceEnabled(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function voiceTrace(step: string, data: unknown): void {
  if (!voiceTraceEnabled()) return
  console.info(`[voice-trace] ${new Date().toISOString()} ${step}`, data)
}

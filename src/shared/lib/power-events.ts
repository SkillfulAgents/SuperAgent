// Recent sleep/wake transitions of the desktop host. Stays empty on web.

export type PowerEventType = 'suspend' | 'resume'

const MAX_EVENTS = 10
const events: Array<{ type: PowerEventType; at: string }> = []

export function recordPowerEvent(type: PowerEventType): void {
  events.push({ type, at: new Date().toISOString() })
  if (events.length > MAX_EVENTS) events.shift()
}

export function getRecentPowerEvents(): Array<{ type: PowerEventType; at: string }> {
  return [...events]
}

/**
 * The runtime's `Monitor` tool delivers what its script prints (or its
 * WebSocket receives) as `<task-notification>` user entries, one per batch of
 * lines, each waking the agent for a turn. The transcript hides task
 * notifications, so without these the agent's reactions would appear with
 * nothing that prompted them; parsed here, each one is shown in place.
 *
 * Shapes written by the CLI bundled with SDK 0.3.303:
 *
 *   <task-notification>
 *   <task-id>b8ezoj4kh</task-id>
 *   <summary>Monitor event: "probe ticks"</summary>
 *   <event>tick-1</event>
 *   </task-notification>
 *
 * and, for the batch that ends the watch, `<tool-use-id>`, `<output-file>` and
 * `<status>` lines with `<summary>Monitor "probe ticks" stream ended</summary>`
 * (or `script failed (exit 3)`), the last lines' `<event>` when there were
 * any. Event text is XML-escaped. Expiry and a WebSocket close arrive as
 * ordinary events whose text the runtime wrote ("[Monitor expired after …]",
 * "[WebSocket closed: 1000 done]"); they are shown as the runtime wrote them.
 */

export interface MonitorNotification {
  taskId: string
  /** The Monitor call's description, as the runtime quotes it. */
  description: string | null
  /** Each event's text, in order; a burst of lines arrives as one event. */
  events: string[]
  /** The ending batch's status (completed, failed, …); null while the watch runs. */
  status: string | null
  /** The ending batch's reason after the description ("stream ended", "script failed (exit 3)"). */
  endReason: string | null
}

const NOTIFICATION_RE = /^\s*<task-notification(?:\s[^>]*)?>([\s\S]*)<\/task-notification>\s*$/
const EVENT_RE = /<event(?:\s[^>]*)?>([\s\S]*?)<\/event(?:\s[^>]*)?>/g
const EVENT_SUMMARY_RE = /^Monitor event: "([\s\S]*)"$/
const END_SUMMARY_RE = /^Monitor "([\s\S]*)" (\S[\s\S]*)$/

function tag(body: string, name: string): string | null {
  const match = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return match ? match[1] : null
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** A Monitor's task notification, or null for any other content (another task's notification included). */
export function parseMonitorNotification(content: unknown): MonitorNotification | null {
  if (typeof content !== 'string') return null
  const body = content.match(NOTIFICATION_RE)?.[1]
  if (body === undefined) return null

  // Events first and stripped, so nothing inside one can pose as a tag.
  const events = [...body.matchAll(EVENT_RE)].map((match) => unescapeXml(match[1]))
  const header = body.replace(EVENT_RE, '')
  const taskId = tag(header, 'task-id')?.trim()
  const summary = tag(header, 'summary')
  if (!taskId || summary === null) return null
  const summaryText = unescapeXml(summary).trim()
  const status = tag(header, 'status')?.trim() || null

  const eventSummary = summaryText.match(EVENT_SUMMARY_RE)
  if (eventSummary) return { taskId, description: eventSummary[1], events, status, endReason: null }
  const endSummary = summaryText.match(END_SUMMARY_RE)
  if (endSummary) return { taskId, description: endSummary[1], events, status, endReason: endSummary[2] }
  return null
}

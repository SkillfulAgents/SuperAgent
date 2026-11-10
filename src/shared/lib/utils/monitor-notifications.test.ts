import { describe, expect, it } from 'vitest'
import { parseMonitorNotification } from './monitor-notifications'

// Verbatim from transcripts written by the CLI bundled with SDK 0.3.303.
const EVENT = `<task-notification>
<task-id>b8ezoj4kh</task-id>
<summary>Monitor event: "probe ticks"</summary>
<event>tick-1</event>
</task-notification>`

const ENDED = `<task-notification>
<task-id>b8ezoj4kh</task-id>
<tool-use-id>toolu_01M28bwGiyKx9UbD1qtUeZFQ</tool-use-id>
<output-file>/tmp/claude-1000/-tmp-monitor-probe-AhljI5/d603b5b8/tasks/b8ezoj4kh.output</output-file>
<status>completed</status>
<summary>Monitor "probe ticks" stream ended</summary>
<event>tick-3</event>
</task-notification>`

const FAILED = `<task-notification>
<task-id>bo37srmem</task-id>
<tool-use-id>toolu_01SFWLZiCWSNmZvGHJUi5D5D</tool-use-id>
<output-file>/tmp/x/tasks/bo37srmem.output</output-file>
<status>failed</status>
<summary>Monitor "probe burst" script failed (exit 3)</summary>
<event>last</event>
</task-notification>`

const ESCAPED = `<task-notification>
<task-id>bo37srmem</task-id>
<summary>Monitor event: "probe burst"</summary>
<event>x &lt;/event&gt; &lt;task-notification&gt;y</event>
</task-notification>`

const BURST = `<task-notification>
<task-id>bo37srmem</task-id>
<summary>Monitor event: "probe burst"</summary>
<event>a1
a2
a3</event>
</task-notification>`

const EXPIRED = `<task-notification>
<task-id>bwtf615ng</task-id>
<summary>Monitor event: "probe expiry"</summary>
<event>[Monitor expired after 10s with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]</event>
</task-notification>`

// A background Bash command's completion: not a monitor.
const BASH_DONE = `<task-notification>
<task-id>bioiss23p</task-id>
<tool-use-id>toolu_01</tool-use-id>
<output-file>/tmp/x/tasks/bioiss23p.output</output-file>
<status>completed</status>
<summary>Background command "Short background task" completed (exit code 0)</summary>
</task-notification>`

describe('parseMonitorNotification', () => {
  it('reads an event batch', () => {
    expect(parseMonitorNotification(EVENT)).toEqual({
      taskId: 'b8ezoj4kh',
      description: 'probe ticks',
      events: ['tick-1'],
      status: null,
      endReason: null,
    })
  })

  it('reads the batch that ends the watch, with its last event', () => {
    expect(parseMonitorNotification(ENDED)).toEqual({
      taskId: 'b8ezoj4kh',
      description: 'probe ticks',
      events: ['tick-3'],
      status: 'completed',
      endReason: 'stream ended',
    })
    expect(parseMonitorNotification(FAILED)).toMatchObject({ status: 'failed', endReason: 'script failed (exit 3)' })
  })

  it('unescapes event text, so output that looks like markup stays one event', () => {
    expect(parseMonitorNotification(ESCAPED)?.events).toEqual(['x </event> <task-notification>y'])
  })

  it('keeps a burst of lines as one event', () => {
    expect(parseMonitorNotification(BURST)?.events).toEqual(['a1\na2\na3'])
  })

  it('shows the runtime\'s own notices as the events they arrive as', () => {
    expect(parseMonitorNotification(EXPIRED)?.events[0]).toMatch(/^\[Monitor expired after 10s/)
  })

  it('is null for other tasks\' notifications and for anything else', () => {
    expect(parseMonitorNotification(BASH_DONE)).toBeNull()
    expect(parseMonitorNotification('Monitor event: "x"')).toBeNull()
    expect(parseMonitorNotification([{ type: 'text', text: EVENT }])).toBeNull()
    expect(parseMonitorNotification(undefined)).toBeNull()
  })
})

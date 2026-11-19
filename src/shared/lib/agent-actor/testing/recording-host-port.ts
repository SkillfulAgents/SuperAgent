/**
 * Test helper: a host port that records what the actor asked of it.
 *
 * A call is answered from `answers` (a value, or a function of the request).
 * A call with no answer goes to `fallback` when one is given, and otherwise
 * rejects, so a test sees the host call it did not expect. Sends are
 * recorded, then go to `fallback` (if any).
 *
 *   const host = createRecordingHostPort({ hostTool: { status: 'resolved', ... } })
 *   ... drive the actor ...
 *   host.calls      // [['hostTool', { toolName: 'schedule_task', ... }]]
 *   host.sent('notification')
 */
import type { HostCalls, HostEvents, HostPort } from '../host-port'

export type HostCallAnswers = {
  [N in keyof HostCalls]?:
    | HostCalls[N]['response']
    | ((request: HostCalls[N]['request']) => HostCalls[N]['response'] | Promise<HostCalls[N]['response']>)
}

export interface RecordingHostPort {
  readonly port: HostPort
  /** Every call, in order: its name and its request. */
  readonly calls: Array<[keyof HostCalls, unknown]>
  /** Every send, in order: its name and its event. */
  readonly sends: Array<[keyof HostEvents, unknown]>
  /** The events sent under one name, in order. */
  sent<N extends keyof HostEvents>(name: N): Array<HostEvents[N]>
  /** Answer later calls of this name differently. */
  answer<N extends keyof HostCalls>(name: N, answer: HostCallAnswers[N]): void
  /** Forget the recordings and go back to the answers it was created with. */
  reset(): void
}

export function createRecordingHostPort(initial: HostCallAnswers = {}, fallback?: HostPort): RecordingHostPort {
  let answers: HostCallAnswers = { ...initial }
  const calls: Array<[keyof HostCalls, unknown]> = []
  const sends: Array<[keyof HostEvents, unknown]> = []
  const port: HostPort = {
    call: async (name, request) => {
      calls.push([name, request])
      const answer = answers[name] as unknown
      if (answer === undefined) {
        if (fallback) return fallback.call(name, request)
        throw new Error(`No answer for host call '${name}' in this test`)
      }
      return (typeof answer === 'function' ? await answer(request) : answer) as never
    },
    send: (name, event) => {
      sends.push([name, event])
      fallback?.send(name, event)
    },
  }
  return {
    port,
    calls,
    sends,
    sent: <N extends keyof HostEvents>(name: N) =>
      sends.filter(([sentName]) => sentName === name).map(([, event]) => event as HostEvents[N]),
    answer: (name, answer) => {
      answers[name] = answer as never
    },
    reset: () => {
      calls.length = 0
      sends.length = 0
      answers = { ...initial }
    },
  }
}

/**
 * What a restarted actor rebuilds from its running container: the container
 * is the authority on the turns it runs and the asks its tools are parked on.
 *
 * - every session the container runs a turn in is attached again, so its
 *   stream (and the turn's state) comes back;
 * - every request the container waits on (`GET /inputs/pending`) is
 *   registered again on its session, marked recovered, as transcript recovery
 *   does: clients render the card from the transcript;
 * - user messages held for a recovery the restart cut short are sent.
 */
import { z } from 'zod'
import type { CoalescedUserMessage } from '@shared/lib/container/runtime-death'

const containerSessionsSchema = z.array(z.object({ sessionId: z.string().min(1) }).passthrough())
const containerSessionSchema = z.object({ isRunning: z.boolean().optional() }).passthrough()
const containerPendingSchema = z.array(z.object({
  toolUseId: z.string().min(1),
  inputType: z.string(),
  sessionId: z.string().optional(),
}).passthrough())

export interface RecoverFromContainerDeps {
  containerStatus(): Promise<string>
  fetch(path: string): Promise<Response>
  attach(sessionId: string): Promise<void>
  recoverAwaitingInput(sessionId: string, unresolved: Array<{ toolUseId: string; toolName: string }>): void
  takeStoredCoalesced(): Array<{ sessionId: string; messages: CoalescedUserMessage[] }>
  sendHeld(sessionId: string, message: CoalescedUserMessage): Promise<void>
}

export interface RecoverFromContainerResult {
  /** Sessions attached again: a turn in flight, or an ask parked. */
  attached: string[]
  /** Requests registered again. */
  requests: string[]
  /** Held messages sent, by uuid. */
  resent: string[]
}

async function json(deps: RecoverFromContainerDeps, path: string): Promise<unknown> {
  const response = await deps.fetch(path)
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
  return response.json()
}

export async function recoverFromContainer(deps: RecoverFromContainerDeps): Promise<RecoverFromContainerResult> {
  const result: RecoverFromContainerResult = { attached: [], requests: [], resent: [] }
  // Held messages wait for a container that runs: a stopped one starts fresh.
  if ((await deps.containerStatus()) !== 'running') return result

  const sessions = containerSessionsSchema.parse(await json(deps, '/sessions'))
  const running = new Set<string>()
  for (const { sessionId } of sessions) {
    const session = containerSessionSchema.parse(await json(deps, `/sessions/${encodeURIComponent(sessionId)}`))
    if (session.isRunning) running.add(sessionId)
  }
  const parked = new Map<string, Array<{ toolUseId: string; toolName: string }>>()
  for (const input of containerPendingSchema.parse(await json(deps, '/inputs/pending'))) {
    if (!input.sessionId) continue
    parked.set(input.sessionId, [...(parked.get(input.sessionId) ?? []), { toolUseId: input.toolUseId, toolName: input.inputType }])
  }

  for (const sessionId of new Set([...running, ...parked.keys()])) {
    await deps.attach(sessionId)
    result.attached.push(sessionId)
    const unresolved = parked.get(sessionId) ?? []
    if (unresolved.length > 0) {
      deps.recoverAwaitingInput(sessionId, unresolved)
      result.requests.push(...unresolved.map(({ toolUseId }) => toolUseId))
    }
  }

  for (const { sessionId, messages } of deps.takeStoredCoalesced()) {
    for (const message of messages) {
      await deps.sendHeld(sessionId, message)
      result.resent.push(message.uuid)
    }
  }
  return result
}

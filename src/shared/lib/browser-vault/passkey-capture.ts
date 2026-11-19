import { z } from 'zod'
import { agentRegistry } from '@shared/lib/agent-actor'
import { background } from '@shared/lib/background'
import { passkeySchema, type Passkey } from './vault-schemas'
import { passkeyWorksOn, savePasskey, type VaultAccount } from './vault-service'

/**
 * The owner asked for a sign-in method on an account: the agent's tab records
 * at once the passkey a page creates (passkey-keeper, record mode), and what it
 * creates for the account's site is sealed into the account. The agent adds a
 * passkey in the site's settings as a person would, with nothing to call: the
 * browser's own passkey prompt is answered by the recorder. Asked in the
 * sign-in card's box (armed when it is ticked), in Settings → Logins (armed at
 * the next sign-in with the account), or in the conversation (armed when the
 * agent passes it on). One recording per agent's session.
 */

/** How long the tab records: through the sign-in, and a task the agent finishes first. */
export const RECORD_MS = 30 * 60 * 1000
/** One wait for the page to create a passkey; the watch waits again until the recording ends. */
const TAKE_WAIT_MS = 60_000

const createdSchema = z.object({ credential: passkeySchema.nullable() })
const stateSchema = z.object({ armed: z.boolean(), mode: z.enum(['present', 'record']).nullable() })

interface Recording {
  agentSlug: string
  sessionId: string
  account: Pick<VaultAccount, 'id' | 'origin' | 'username'>
  asked: { request: true } | { words: string }
  until: number
  stopped: boolean
}

const recordings = new Map<string, Recording>()

function post(agentSlug: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return agentRegistry.get(agentSlug).container.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Arm the agent's tab to record a passkey for the account, and keep the one the page creates. */
export async function recordPasskeyFor(input: Omit<Recording, 'until' | 'stopped'>): Promise<boolean> {
  const { agentSlug, sessionId } = input
  try {
    const arming = await post(agentSlug, '/browser/passkey/arm', { sessionId, mode: 'record', ttlMs: RECORD_MS, keep: true })
    if (!arming.ok) return false
  } catch (error) {
    console.error('[passkey-capture] Arming the tab to record failed:', error instanceof Error ? error.message : error)
    return false
  }
  const key = `${agentSlug}:${sessionId}`
  const earlier = recordings.get(key)
  // Watching for this account already (the card's box, then the ask): it goes on a while longer.
  if (earlier && !earlier.stopped && earlier.account.id === input.account.id) {
    earlier.until = Date.now() + RECORD_MS
    return true
  }
  if (earlier) earlier.stopped = true
  const recording: Recording = { ...input, until: Date.now() + RECORD_MS, stopped: false }
  recordings.set(key, recording)
  background(watchCreated(recording, key), { name: 'browser-vault.record-passkey' })
  return true
}

/** The recording for this session ends: nothing more the page creates is kept. */
export function stopRecording(agentSlug: string, sessionId: string): void {
  const recording = recordings.get(`${agentSlug}:${sessionId}`)
  if (recording) recording.stopped = true
}

async function watchCreated(recording: Recording, key: string): Promise<void> {
  const { agentSlug } = recording
  try {
    while (!recording.stopped && Date.now() < recording.until) {
      const taking = await post(agentSlug, '/browser/passkey/created', { waitMs: TAKE_WAIT_MS })
      const created = createdSchema.safeParse(await taking.json().catch(() => null))
      const passkey = taking.ok && created.success ? created.data.credential : null
      // Taken from the tab, it is this recording's to keep even if another
      // replaced it meanwhile: no other watch will see it.
      if (passkey) {
        if (await keep(recording, passkey) || recording.stopped) return
        // One for another site (the tab went elsewhere) is not the account's: the watch goes on.
        continue
      }
      if (recording.stopped) return
      // The tab let go (the time is up, the browser went, a sign-in's passkeys replaced it): nothing more comes.
      const state = stateSchema.safeParse(await (await agentRegistry.get(agentSlug).container.fetch('/browser/passkey/state')).json().catch(() => null))
      if (!state.success || !state.data.armed || state.data.mode !== 'record') return
    }
  } catch (error) {
    // The container went: the request stays on the account for the next sign-in.
    console.error('[passkey-capture] Watching for a passkey failed:', error instanceof Error ? error.message : error)
  } finally {
    if (recordings.get(key) === recording) recordings.delete(key)
  }
}

/**
 * One that works where the account signs in is sealed into it. The tab keeps
 * it until the recording's time is up: a site may ask for the new passkey at
 * once, to try it.
 */
async function keep(recording: Recording, passkey: Passkey): Promise<boolean> {
  const { agentSlug, sessionId, account } = recording
  const host = hostOf(account.origin)
  if (!host || !passkeyWorksOn(passkey.rpId, host)) {
    console.warn(`[passkey-capture] The page created a passkey for ${passkey.rpId}, which does not work on ${host}: not saved`)
    return false
  }
  try {
    await savePasskey({ agentSlug, accountId: account.id, sessionId, passkey, name: null, asked: recording.asked })
  } catch (error) {
    console.error('[passkey-capture] Saving the passkey failed:', error instanceof Error ? error.message : error)
  }
  return true
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

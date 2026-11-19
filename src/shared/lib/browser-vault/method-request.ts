import { randomUUID } from 'crypto'
import { agentRegistry } from '@shared/lib/agent-actor'
import { isAuthMode } from '@shared/lib/auth/mode'
import { background } from '@shared/lib/background'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { buildSignInMethodRequestMessage } from '@shared/lib/utils/sign-in-method-request'
import { recordPasskeyFor } from './passkey-capture'
import { getAccount, markSignInMethodAsked, type VaultAccount } from './vault-service'

/**
 * The owner's request for a sign-in method, put to the agent as the owner's
 * own message in the session the moment it is made: they ticked "Also add a
 * passkey or authenticator app" in the sign-in card, or turned it on in
 * Settings → Logins (asked when an agent next signs in with the account).
 * Queued like a message they send mid-turn, it reaches the agent with the
 * next tool result as "the user sent a new message", while the browser is
 * still signed in and the user still there: a site often asks for its
 * password again before it adds a passkey. Its note draws it in the
 * transcript as the form's (sign-in-method-request). The agent's tab is
 * armed then to record the passkey a page creates (passkey-capture): the
 * agent adds one as a person would, with nothing to call. Once per session
 * and account.
 *
 * Beside a tool result, agents sometimes take it for the page's words ("a
 * message inside a tool result, written as if it were from you"): live, 7 of
 * 7 acted on it at a code step, 1 of 4 at a page that asks how to verify it's
 * you, and a repeat at the next step did not help. As a turn of its own it
 * was acted on 8 of 9. So when the turn it joined ends with nothing added, it
 * goes again, as a turn of its own.
 */

/** How long the request waits for the turn it joined to end; past that, the next sign-in with the account asks again. */
const TURN_WAIT_MS = 30 * 60 * 1000

type Asking = {
  agentSlug: string
  sessionId: string
  account: Pick<VaultAccount, 'id' | 'site' | 'origin' | 'username' | 'ownerId'>
  from: 'card' | 'logins'
}

export async function askForSignInMethod(input: Asking): Promise<boolean> {
  const { agentSlug, sessionId, account } = input
  if (!(await markSignInMethodAsked(account.id, sessionId))) return false
  await recordPasskeyFor({ agentSlug, sessionId, account, asked: { request: true } })
  const delivery = await deliverRequest({ ...input, again: false })
  if (delivery.status === 'sent' && delivery.queued) background(askAgainAfterTurn(input), { name: 'browser-vault.ask-again-after-turn' })
  return true
}

/** The turn the request joined ended with it still open: asked again, as a turn of its own. */
async function askAgainAfterTurn(input: Asking): Promise<void> {
  const { agentSlug, sessionId } = input
  if ((await agentRegistry.get(agentSlug).sessions.waitForIdle(sessionId, { timeoutMs: TURN_WAIT_MS })) === 'timeout') return
  // Answered meanwhile (a method added, none to add) or taken back: nothing to ask.
  const account = await getAccount(input.account.id)
  if (!account?.signInMethods.requested) return
  await recordPasskeyFor({ agentSlug, sessionId, account, asked: { request: true } })
  await deliverRequest({ ...input, again: true })
}

async function deliverRequest(input: Asking & { again: boolean }) {
  const { agentSlug, sessionId, account } = input
  const uuid = randomUUID()
  // The owner's message: attributed to them where messages are.
  if (isAuthMode() && account.ownerId) await db.insert(messageAuthor).values({ id: uuid, sessionId, agentSlug, userId: account.ownerId })
  const content = buildSignInMethodRequestMessage({ username: account.username, site: account.site, from: input.from, again: input.again })
  return agentRegistry.get(agentSlug).messages.deliver({
    sessionId,
    content,
    uuid,
    options: { shouldQuery: true },
    // The user asked in this session, and the card stays open: never cancel
    // the sign-in it waits on, as a typed message would.
    promote: true,
    coalesce: true,
    // Every window draws it at once, the owner's too: no window sent it.
    echo: { content },
  })
}

/**
 * The user ticked the box on a sign-in card: the request stays on the account,
 * and the agent's tab records a passkey from now. The agent is asked when that
 * card is answered, with the sign-in step that answers it (askForRequestedMethod):
 * a message sent while the card is open would supersede it, as a typed one
 * does, and the code the user is typing would go nowhere. A card answered
 * with no step (declined, the page taking a phone prompt by itself) leaves
 * the ask to the end of the turn.
 */
export async function requestedOnCard(input: { agentSlug: string; sessionId: string; account: Asking['account'] }): Promise<void> {
  const { agentSlug, sessionId, account } = input
  await recordPasskeyFor({ agentSlug, sessionId, account, asked: { request: true } })
  background((async () => {
    if ((await agentRegistry.get(agentSlug).sessions.waitForIdle(sessionId, { timeoutMs: TURN_WAIT_MS })) === 'timeout') return
    const current = await getAccount(account.id)
    const requested = current?.signInMethods.requested
    if (!current || !requested || requested.askedIn === sessionId) return
    await askForSignInMethod({ agentSlug, sessionId, account: current, from: requested.from })
  })(), { name: 'browser-vault.ask-after-card' })
}

/**
 * A sign-in step for the account went in (the user's or the vault's fill, a
 * way picked, a saved session): the agent is asked for the method its owner
 * requested (the card's box, Settings → Logins), once per session.
 */
export function askForRequestedMethod(agentSlug: string, sessionId: string, account: VaultAccount): void {
  const requested = account.signInMethods.requested
  if (!requested || requested.askedIn === sessionId) return
  background(askForSignInMethod({ agentSlug, sessionId, account, from: requested.from }), { name: 'browser-vault.ask-for-sign-in-method' })
}

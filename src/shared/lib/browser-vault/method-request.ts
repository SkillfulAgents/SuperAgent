import { randomUUID } from 'crypto'
import { agentRegistry } from '@shared/lib/agent-actor'
import { isAuthMode } from '@shared/lib/auth/mode'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { markSignInMethodAsked, type VaultAccount } from './vault-service'

/**
 * The owner's request for a sign-in method, put to the agent as the owner's
 * own message in the session: they ticked "Also add an authenticator app" in
 * the sign-in card, or turned it on in Settings → Logins. Said in a tool
 * result, it would read as the tool's or the page's words, which agents rightly
 * do not take as the user's (live runs: they declined it every time). Once per
 * session and account, when the agent signs in with it.
 */

/** The request in the owner's words, saying where they made it. */
export function signInMethodMessage(account: Pick<VaultAccount, 'site' | 'username'>, from: 'card' | 'logins'): string {
  const where = from === 'card' ? 'From the sign-in form' : 'From Settings → Logins'
  return `${where}: once you are signed in, also add an authenticator app to my account ${account.username} on ${account.site} `
    + 'with add_sign_in_method, so you can sign in there later without me. Add it only next to the two-step verification '
    + 'the account already has: never turn two-step verification on, and never replace or remove a method it has. If the site '
    + 'offers nothing else, call add_sign_in_method with method "none" and say why.'
}

/** Ask the agent in this session for the sign-in method its owner requested, unless it was already asked here. */
export async function askForSignInMethod(input: {
  agentSlug: string
  sessionId: string
  account: Pick<VaultAccount, 'id' | 'site' | 'username' | 'ownerId'>
  from: 'card' | 'logins'
}): Promise<boolean> {
  const { agentSlug, sessionId, account } = input
  if (!(await markSignInMethodAsked(account.id, sessionId))) return false
  const uuid = randomUUID()
  // The owner's message: attributed to them where messages are.
  if (isAuthMode() && account.ownerId) await db.insert(messageAuthor).values({ id: uuid, sessionId, agentSlug, userId: account.ownerId })
  await agentRegistry.get(agentSlug).messages.deliver({
    sessionId,
    content: signInMethodMessage(account, input.from),
    uuid,
    options: { shouldQuery: true },
  })
  return true
}

/**
 * The message a sign-in method request reaches the agent as: the user's own
 * words (they ticked "Also add a passkey or authenticator app" in the sign-in
 * card, or turned it on in Settings → Logins), queued into the session at
 * once like a message they sent mid-turn. A note at its end, in words, says
 * where it was sent from (as the computer-use note does), so the transcript
 * draws it as a note from the form rather than a message the user typed.
 * Typed text cannot forge the note: the composer escapes a typed `[`. A note
 * of data instead read to an agent as text posing as the user (live run).
 * Sent again as a turn of its own (`again`: the agent took the first, beside
 * a tool result, for the page's words), its note says so.
 */

export interface SignInMethodRequestNote {
  username: string
  site: string
  from: 'card' | 'logins'
  /** The same request sent once more, as a turn of its own. */
  again?: boolean
}

const PLACES = { card: 'the sign-in form', logins: 'Settings → Logins' } as const
const TRAILING_NOTE = /\n\n\[Sent (again )?from (the sign-in form|Settings → Logins) for (.+) on (\S+)\]\s*$/

/** Shared with the transcript renderer, including messages already on disk. */
export function buildSignInMethodRequestMessage(note: SignInMethodRequestNote): string {
  const request = [
    `From ${PLACES[note.from]}: once you are signed in, also add a passkey to my account ${note.username} on ${note.site}, so you can sign in there later without me.`,
    'The browser is ready to create one: in the site\'s security settings, create a passkey as the page asks, and the vault keeps it, with nothing to call.',
    'Where the site has no passkeys, add an authenticator app instead with add_sign_in_method, only next to the two-step verification the account already has: never turn two-step verification on, and never replace or remove a method it has.',
    'If the site offers neither, call add_sign_in_method with method "none" and say why.',
    'Tell me what the page says at the end, including any wait or approval it puts on a new passkey.',
  ].join(' ')
  // A bracket or a line break in the name would end the note early.
  const name = note.username.replace(/[[\]\n\r]/g, ' ').trim()
  return `${request}\n\n[Sent ${note.again ? 'again ' : ''}from ${PLACES[note.from]} for ${name} on ${note.site}]`
}

/** The request a message carries, or null for any other message. */
export function parseSignInMethodRequestMessage(text: string): SignInMethodRequestNote | null {
  const match = TRAILING_NOTE.exec(text)
  if (!match) return null
  return { from: match[2] === PLACES.card ? 'card' : 'logins', username: match[3], site: match[4], ...(match[1] ? { again: true } : {}) }
}

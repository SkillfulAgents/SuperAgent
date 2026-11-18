/**
 * Whether this renderer is the meeting bot's camera page (`/meeting/:id`).
 *
 * That page runs in a browser nobody is signed into and authenticates with
 * the token in its URL (the server turns it into a scoped cookie), so the
 * login gate must let it through and an authorization failure must not be
 * treated as an expired login. Decided from the location, which is fixed for
 * the page's lifetime.
 */
export function isMeetingParticipantPage(pathname: string = window.location.pathname): boolean {
  return /^\/meeting\/[^/]+\/?$/.test(pathname)
}

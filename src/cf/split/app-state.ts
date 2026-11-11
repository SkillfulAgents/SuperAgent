/** The script of the org's AppState object when the org runs as three scripts (split/main.ts). */
export { AppStateDurableObject } from '../cloudflare-app-state-object'

export default {
  fetch: () => new Response(null, { status: 404 }),
}

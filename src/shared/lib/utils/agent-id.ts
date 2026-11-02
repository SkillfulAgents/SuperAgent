/**
 * Agent ids and display slugs, with no Node dependency: the host mints and checks them, and the
 * renderer mints one to open a new agent before the host has answered.
 */

/**
 * Length of a minted agent id. Deliberately distinct from the legacy 6-char
 * name-suffix: that length gap is what lets the agent catalog tell a minted
 * id apart from a legacy compound folder name when it resolves a display slug.
 */
export const AGENT_ID_LENGTH = 10

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const MINTED_ID_RE = new RegExp(`^[a-z0-9]{${AGENT_ID_LENGTH}}$`)

/** A uniformly random index below `size`, from the Web Crypto source every runtime here has. */
export function randomIndex(size: number): number {
  // Bytes at or above the last whole multiple of `size` are redrawn, so no index is favored.
  const limit = 256 - (256 % size)
  for (;;) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1))
    if (byte < limit) return byte % size
  }
}

/** A fresh random agent id. Unused is the caller's to check. */
export function randomAgentId(): string {
  let id = ''
  for (let i = 0; i < AGENT_ID_LENGTH; i++) id += ID_ALPHABET[randomIndex(ID_ALPHABET.length)]
  return id
}

/**
 * Whether an id is a freshly-minted opaque id (vs a legacy name-derived folder).
 */
export function isMintedAgentId(id: string): boolean {
  return MINTED_ID_RE.test(id)
}

/**
 * Convert a name to a URL-safe slug
 * "My Cool Agent" -> "my-cool-agent"
 */
export function nameToSlugBase(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
    .substring(0, 50) // Limit length
}

/**
 * Project the decorative display slug shown to models and placed in URLs:
 *   {nameToSlugBase(name)}-{id}   (or bare {id} when the name slugifies to empty)
 *
 * Legacy folders (non-minted ids, e.g. "untitled-h45k3n") are returned VERBATIM:
 * prettifying them would break resolution, since the folder still embeds the old
 * name and there is no reverse lookup from a name-prefix back to the folder.
 */
export function displaySlug(name: string, id: string): string {
  if (!isMintedAgentId(id)) return id
  const base = nameToSlugBase(name)
  return base ? `${base}-${id}` : id
}

/**
 * What `GET /api/agents/:id/access/search-users` answers: the people an agent
 * could be shared with. Gamut accounts come first, then people from connected
 * team directories who have no account yet. Shared with the renderer.
 */

/** A Gamut account. */
export interface AccountInviteCandidate {
  kind: 'user'
  id: string
  name: string
  email: string
  image: string | null
  /** Shown dimmed, with a "Not on Gamut" badge. */
  notOnGamut: boolean
}

/** A directory person with no Gamut account: picking them is what creates one. */
export interface DirectoryInviteCandidate {
  kind: 'directory'
  /** Names the person to the server: the directory that listed them first, and their id there. */
  directoryRef: { directoryId: string; remoteId: string }
  name: string
  email: string
  image: string | null
  notOnGamut: true
  /** Where they were found, for display: "Slack · Acme". */
  source: string
}

export type InviteCandidate = AccountInviteCandidate | DirectoryInviteCandidate

/** The candidates a client can use before it knows directory people. */
export function accountCandidates(candidates: readonly InviteCandidate[]): AccountInviteCandidate[] {
  return candidates.filter((candidate): candidate is AccountInviteCandidate => candidate.kind !== 'directory')
}

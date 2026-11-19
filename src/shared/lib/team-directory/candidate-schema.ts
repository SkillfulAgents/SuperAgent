import { z } from 'zod'

/** Identifies a person picked from a connected directory when sharing an agent or a drive. */
export const directoryRefSchema = z.object({ directoryId: z.string().min(1).max(200), remoteId: z.string().min(1).max(200) })

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
  directoryRef: z.infer<typeof directoryRefSchema>
  name: string
  email: string
  image: string | null
  notOnGamut: true
  /** Where they were found, for display: "Slack · Acme". */
  source: string
}

export type InviteCandidate = AccountInviteCandidate | DirectoryInviteCandidate

/** A stable key for a candidate: the account id, or the directory person's reference. */
export function candidateKey(candidate: InviteCandidate): string {
  return candidate.kind === 'directory'
    ? `directory:${candidate.directoryRef.directoryId}:${candidate.directoryRef.remoteId}`
    : candidate.id
}

/** A replacement changes identity, so the agent must retry through the new
 * account's policy gate instead of replaying an already-approved request. */
export class AccountReplacedError extends Error {
  readonly replacementAccountId: string

  constructor(accountId: string) {
    super('The connection was replaced for this agent')
    this.name = 'AccountReplacedError'
    this.replacementAccountId = accountId
  }
}

export function getReplacementAccountId(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const id = (error as { replacementAccountId?: unknown }).replacementAccountId
  return typeof id === 'string' && id ? id : undefined
}

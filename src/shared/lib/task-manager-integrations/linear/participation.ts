import { MAX_LINEAR_PARTICIPATION, type LinearConfig, type LinearIdentity } from './config'

/** Bounded thread membership only; no event payloads, work status or retry state. */
export class LinearParticipation {
  private entries: NonNullable<LinearConfig['participation']>['threads']
  private issues = new Map<string, Set<string>>()
  constructor(private readonly identity: LinearIdentity, stored?: LinearConfig['participation']) {
    this.entries = stored?.workspaceId === identity.workspaceId && stored.appUserId === identity.appUserId ? stored.threads : []
    this.index()
  }
  private index(): void {
    this.issues.clear()
    for (const entry of this.entries) {
      const threads = this.issues.get(entry.issueId) ?? new Set<string>()
      if (entry.rootId) threads.add(entry.rootId)
      this.issues.set(entry.issueId, threads)
    }
  }
  get(issueId: string): Set<string> | undefined { return this.issues.get(issueId) }
  remember(issueId: string, rootId?: string): boolean {
    if (this.entries.some(entry => entry.issueId === issueId && entry.rootId === rootId)) return false
    this.entries = [...this.entries, { issueId, rootId }].slice(-MAX_LINEAR_PARTICIPATION)
    this.index()
    return true
  }
  snapshot(): NonNullable<LinearConfig['participation']> {
    return { workspaceId: this.identity.workspaceId, appUserId: this.identity.appUserId, threads: this.entries }
  }
}

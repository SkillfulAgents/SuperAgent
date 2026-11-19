/**
 * Audit rows keep only rule version ids and results; the logs API adds each
 * rule's name back from its (immutable) version before sending a page.
 */
import type { RequestLogEntry } from '@shared/lib/types/request-log'
import { getRuleVersions } from './store'

function parseOutcomes(json: string): Array<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object') : null
  } catch {
    return null
  }
}

export async function withRuleNames(entries: RequestLogEntry[]): Promise<RequestLogEntry[]> {
  const versionIds = new Set<string>()
  for (const entry of entries) {
    for (const outcome of entry.ruleOutcomes ? parseOutcomes(entry.ruleOutcomes) ?? [] : []) {
      if (typeof outcome.versionId === 'string' && typeof outcome.name !== 'string') versionIds.add(outcome.versionId)
    }
  }
  if (versionIds.size === 0) return entries
  const names = new Map((await getRuleVersions([...versionIds])).map((v) => [v.id, v.name]))
  return entries.map((entry) => {
    const outcomes = entry.ruleOutcomes ? parseOutcomes(entry.ruleOutcomes) : null
    if (!outcomes) return entry
    const named = outcomes.map((o) => (typeof o.versionId === 'string' && names.has(o.versionId) && typeof o.name !== 'string'
      ? { ...o, name: names.get(o.versionId) }
      : o))
    return { ...entry, ruleOutcomes: JSON.stringify(named) }
  })
}

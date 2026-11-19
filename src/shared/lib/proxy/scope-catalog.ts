import { SCOPE_METADATA, getScopeDescription, getScopeLabel, type ScopeLabel } from './scope-metadata'

export interface ScopeDescriptor {
  scope: string
  description: string
  label: ScopeLabel | 'other'
}

/** The deployment's catalog, or just the sufficient scopes matched for a review. */
export function getScopeDescriptors(
  toolkit: string,
  scopes?: readonly string[],
  descriptions: Record<string, string> = {},
): ScopeDescriptor[] {
  const provider = toolkit.toLowerCase()
  return [...new Set(scopes ?? Object.keys(SCOPE_METADATA[provider] ?? {}))].map((scope) => ({
    scope,
    description: getScopeDescription(provider, scope) ?? descriptions[scope] ?? '',
    label: getScopeLabel(provider, scope) ?? 'other',
  }))
}

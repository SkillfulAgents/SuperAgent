import { creationDraftSchema, type CreationDraft } from '@shared/lib/types/creation-draft'
export type { CreationDraft, ChosenAgentIdentity } from '@shared/lib/types/creation-draft'

declare module '@tanstack/history' {
  interface HistoryState {
    /** Templates opened from the identity step can return to its original draft. */
    fromAgentIdentity?: boolean
  }
}

// A refresh keeps the history entry. Opening New Agent again gets a different entry.
export function creationDraftKey() {
  const key = window.history.state?.__TSR_key
  return key ? 'gamut:new-agent:' + key : null
}

export function readCreationDraft(key: string | null): CreationDraft | undefined {
  try {
    return key ? creationDraftSchema.parse(JSON.parse(sessionStorage.getItem(key) ?? 'null')) : undefined
  } catch {
    return undefined
  }
}

export function saveCreationDraft(key: string | null, draft: CreationDraft | null) {
  if (!key) return
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(creationDraftSchema.parse(draft)))
    else sessionStorage.removeItem(key)
  } catch {
    // Storage may be unavailable in this browser. Creation can still finish.
  }
}

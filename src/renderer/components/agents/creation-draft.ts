import { z } from 'zod'
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'

const creationDraftSchema = z.object({
  agent: z.object({ slug: z.string(), displaySlug: z.string() }),
  identity: z.object({ name: z.string(), avatar: agentAvatarSchema }),
  stage: z.enum(['name', 'describe', 'addons']),
  prompt: z.string(),
})
export type ChosenAgentIdentity = z.infer<typeof creationDraftSchema>['identity']
export type CreationDraft = z.infer<typeof creationDraftSchema>

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
    // The agent itself is already saved on the server.
  }
}

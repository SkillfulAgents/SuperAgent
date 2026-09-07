import { useEffect, useState } from 'react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import { useDraftsStore } from '@renderer/context/drafts-context'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

export interface ComposerSnapshot {
  text: string
  attachments: Attachment[]
  model: string | undefined
  effort: EffortLevel
  speed: SpeedLevel
}

export interface NewSessionCarryover {
  attachments: Attachment[]
  model: string | undefined
  effort: EffortLevel
  speed: SpeedLevel
}

export const newSessionCarryoverKey = (agentSlug: string) => `new-session-carryover:${agentSlug}`

function stripObjectUrls(attachments: Attachment[]): Attachment[] {
  return attachments.map((attachment) =>
    attachment.type === 'file' && attachment.preview
      ? { ...attachment, preview: undefined }
      : attachment,
  )
}

export function splitComposerSnapshot(snapshot: ComposerSnapshot | undefined): {
  draftText: string | undefined
  carryover: NewSessionCarryover | undefined
} {
  if (!snapshot) return { draftText: undefined, carryover: undefined }

  return {
    draftText: snapshot.text.trim() ? snapshot.text : undefined,
    carryover: {
      attachments: stripObjectUrls(snapshot.attachments),
      model: snapshot.model,
      effort: snapshot.effort,
      speed: snapshot.speed,
    },
  }
}

/** Consume a pending composer handoff exactly once when the agent home mounts. */
export function useNewSessionCarryover(agentSlug: string): NewSessionCarryover | undefined {
  const store = useDraftsStore()
  const key = newSessionCarryoverKey(agentSlug)
  const [carryover] = useState(() => store.get<NewSessionCarryover>(key))

  useEffect(() => {
    store.set(key, undefined)
  }, [key, store])

  return carryover
}

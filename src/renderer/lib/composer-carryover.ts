import { useEffect, useState } from 'react'
import { useDraftsStore } from '@renderer/context/drafts-context'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import type { EffortLevel } from '@shared/lib/container/types'

/**
 * "Start fresh" carry-over: when a user leaves a stale conversation for a new one
 * under the same agent, their in-progress composer (text, attachments, selected
 * model + effort) follows them into the new-chat composer instead of being lost.
 *
 * No session is created here — the snapshot only pre-fills the new-chat composer;
 * the session is born when the user actually sends, via the normal AgentHome path.
 *
 * Text travels through the agent's existing text draft key; the rest rides in a
 * one-shot carry-over slot in the drafts store, keyed by agent slug.
 */

/** Live composer state captured at the moment the user chooses "Start fresh". */
export interface ComposerSnapshot {
  text: string
  attachments: Attachment[]
  /** Family alias, or undefined while settings are still loading. */
  model: string | undefined
  effort: EffortLevel
}

/** The non-text part of a snapshot, stashed for the new-chat composer to pick up. */
export interface NewChatCarryover {
  attachments: Attachment[]
  model: string | undefined
  effort: EffortLevel
}

/** Drafts-store key under which a pending carry-over for an agent lives. */
export const carryoverKey = (agentSlug: string) => `newchat-carryover:${agentSlug}`

/**
 * Image previews are object URLs owned by the source composer; they get revoked
 * when it unmounts on navigation. Drop them here so a dead URL never travels —
 * the target composer recreates fresh ones from the still-valid File on hydrate.
 */
function stripPreviews(attachments: Attachment[]): Attachment[] {
  return attachments.map((a) => (a.type === 'file' && a.preview ? { ...a, preview: undefined } : a))
}

/**
 * Split a composer snapshot into its two handoff channels:
 *   - `draftText`: the agent's text draft. Omitted when blank so an empty
 *     "Start fresh" never clobbers an existing agent-home draft.
 *   - `carryover`: attachments + selected model + effort, stashed under
 *     `carryoverKey`. Model and effort are always carried (even for an otherwise
 *     empty composer) so the user's current selection follows them.
 *
 * Returns both as undefined when there is no snapshot (e.g. a view-only column
 * with no live composer to read).
 */
export function splitSnapshotForHandoff(snapshot: ComposerSnapshot | undefined): {
  draftText: string | undefined
  carryover: NewChatCarryover | undefined
} {
  if (!snapshot) return { draftText: undefined, carryover: undefined }
  const draftText = snapshot.text.trim() ? snapshot.text : undefined
  const carryover: NewChatCarryover = {
    attachments: stripPreviews(snapshot.attachments),
    model: snapshot.model,
    effort: snapshot.effort,
  }
  return { draftText, carryover }
}

/** Map a consumed carry-over into the initial props the new-chat composer seeds from. */
export function carryoverToComposerInit(carryover: NewChatCarryover | undefined): {
  initialAttachments: Attachment[]
  initialModel: string | undefined
  initialEffort: EffortLevel | undefined
} {
  return {
    initialAttachments: carryover?.attachments ?? [],
    initialModel: carryover?.model,
    initialEffort: carryover?.effort,
  }
}

/**
 * Read and clear a pending carry-over for an agent, exactly once. The value is
 * captured at mount so the composer can seed from it on first render, and the
 * store slot is cleared in an effect — so navigating back to the home view later
 * starts clean rather than re-applying a stale carry-over.
 */
export function useNewChatCarryover(agentSlug: string): NewChatCarryover | undefined {
  const store = useDraftsStore()
  const key = carryoverKey(agentSlug)
  const [value] = useState(() => store.get<NewChatCarryover>(key))
  useEffect(() => {
    if (store.get(key) !== undefined) store.set(key, undefined)
  }, [store, key])
  return value
}

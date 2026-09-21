import type { IntegrationSessionContext } from '../agent-integrations/types'

/** Provider-normalized event. Stable item IDs and reply destinations are separate. */
export interface TaskEvent {
  id: string
  taskId: string
  interactionId: string
  kind: 'invocation' | 'status' | 'context'
  timestamp: string
  text: string
  /** The triggering comment, distinct from the thread used for the reply. */
  sourceCommentId?: string
  title?: string
  replyTarget: Record<string, string>
  payload: unknown
}

export interface TaskSnapshot {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  updatedAt: string
  properties: Record<string, unknown>
  comments: Array<{ id: string; body: string; author: string; createdAt: string; parentId?: string | null }>
  attachments: Array<{ id: string; title: string; url: string }>
  truncated: boolean
}

export type TaskContext = IntegrationSessionContext & { interactionId: string; replyTarget: Record<string, string> }

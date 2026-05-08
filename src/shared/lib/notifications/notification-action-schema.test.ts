import { describe, it, expect } from 'vitest'
import {
  NotificationActionContextSchema,
  NotificationEventSchema,
  NotificationActionsArraySchema,
  NotificationMetadataSchema,
} from './notification-action-schema'

describe('NotificationActionContextSchema', () => {
  it('accepts a well-formed proxy_review context', () => {
    const result = NotificationActionContextSchema.safeParse({
      kind: 'proxy_review',
      reviewId: 'rid-1',
      agentSlug: 'agent-1',
      sessionId: 'sess-1',
      decisions: ['allow', 'deny'],
      notificationId: 'notif-1',
    })
    expect(result.success).toBe(true)
  })

  it('accepts proxy_review without optional sessionId / decisions', () => {
    const result = NotificationActionContextSchema.safeParse({
      kind: 'proxy_review',
      reviewId: 'rid-1',
      agentSlug: 'agent-1',
    })
    expect(result.success).toBe(true)
  })

  // SECURITY: an attacker who controls SSE / IPC traffic cannot inject a
  // payload missing required fields and have the renderer dispatch on it.
  it('SECURITY: rejects context missing required fields', () => {
    expect(NotificationActionContextSchema.safeParse({}).success).toBe(false)
    expect(
      NotificationActionContextSchema.safeParse({ kind: 'proxy_review' }).success,
    ).toBe(false)
    expect(
      NotificationActionContextSchema.safeParse({
        kind: 'proxy_review',
        reviewId: 'rid-1',
      }).success,
    ).toBe(false)
  })

  it('SECURITY: rejects unknown kind', () => {
    const result = NotificationActionContextSchema.safeParse({
      kind: 'fake_kind',
      reviewId: 'rid-1',
      agentSlug: 'agent-1',
    })
    expect(result.success).toBe(false)
  })

  it('SECURITY: rejects empty-string identifiers', () => {
    expect(
      NotificationActionContextSchema.safeParse({
        kind: 'proxy_review',
        reviewId: '',
        agentSlug: 'agent-1',
      }).success,
    ).toBe(false)
    expect(
      NotificationActionContextSchema.safeParse({
        kind: 'proxy_review',
        reviewId: 'rid-1',
        agentSlug: '',
      }).success,
    ).toBe(false)
  })

  it('SECURITY: rejects invalid decision values in decisions array', () => {
    const result = NotificationActionContextSchema.safeParse({
      kind: 'proxy_review',
      reviewId: 'rid-1',
      agentSlug: 'agent-1',
      decisions: ['allow', 'eat-everything'],
    })
    expect(result.success).toBe(false)
  })

  it('SECURITY: rejects more than 4 decisions (cap)', () => {
    const result = NotificationActionContextSchema.safeParse({
      kind: 'proxy_review',
      reviewId: 'rid-1',
      agentSlug: 'agent-1',
      decisions: ['allow', 'deny', 'allow', 'deny', 'allow'],
    })
    expect(result.success).toBe(false)
  })
})

describe('NotificationEventSchema', () => {
  it('accepts click and action events', () => {
    expect(
      NotificationEventSchema.safeParse({ type: 'click' }).success,
    ).toBe(true)
    expect(
      NotificationEventSchema.safeParse({ type: 'action', actionIndex: 0 }).success,
    ).toBe(true)
  })

  it('SECURITY: rejects unknown type', () => {
    expect(
      NotificationEventSchema.safeParse({ type: 'pwn' }).success,
    ).toBe(false)
  })

  it('SECURITY: rejects negative actionIndex', () => {
    expect(
      NotificationEventSchema.safeParse({ type: 'action', actionIndex: -1 }).success,
    ).toBe(false)
  })
})

describe('NotificationMetadataSchema', () => {
  // Used by the renderer dispatcher to mark DB notifications as read on
  // ANY interaction, regardless of `kind`. Must extract notificationId
  // from both action contexts and generic non-action contexts.
  it('extracts notificationId from a proxy_review context', () => {
    const result = NotificationMetadataSchema.safeParse({
      kind: 'proxy_review',
      reviewId: 'rid-1',
      agentSlug: 'agent-1',
      notificationId: 'notif-1',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.notificationId).toBe('notif-1')
  })

  it('extracts notificationId from a generic (no-kind) context', () => {
    const result = NotificationMetadataSchema.safeParse({
      agentSlug: 'agent-1',
      sessionId: 'sess-1',
      notificationId: 'notif-2',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.notificationId).toBe('notif-2')
  })

  it('returns success with undefined notificationId when absent', () => {
    const result = NotificationMetadataSchema.safeParse({ agentSlug: 'a' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.notificationId).toBeUndefined()
  })
})

describe('NotificationActionsArraySchema', () => {
  it('accepts up to 4 buttons', () => {
    const result = NotificationActionsArraySchema.safeParse([
      { text: 'A' },
      { text: 'B' },
      { text: 'C' },
      { text: 'D' },
    ])
    expect(result.success).toBe(true)
  })

  it('SECURITY: rejects more than 4 buttons', () => {
    const result = NotificationActionsArraySchema.safeParse([
      { text: 'A' },
      { text: 'B' },
      { text: 'C' },
      { text: 'D' },
      { text: 'E' },
    ])
    expect(result.success).toBe(false)
  })

  it('SECURITY: rejects oversized text', () => {
    const result = NotificationActionsArraySchema.safeParse([{ text: 'x'.repeat(65) }])
    expect(result.success).toBe(false)
  })

  it('SECURITY: rejects empty text', () => {
    const result = NotificationActionsArraySchema.safeParse([{ text: '' }])
    expect(result.success).toBe(false)
  })
})

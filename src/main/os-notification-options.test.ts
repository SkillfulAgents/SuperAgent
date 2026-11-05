import { describe, expect, it } from 'vitest'
import { osNotificationOptions, reviewIdOf, reviewNotificationId } from './os-notification-options'

describe('osNotificationOptions', () => {
  it('turns action labels into buttons', () => {
    const options = osNotificationOptions({ title: 'T', body: 'B', actions: [{ text: 'Approve' }, { text: 'Deny' }] })
    expect(options.actions).toEqual([
      { type: 'button', text: 'Approve' },
      { type: 'button', text: 'Deny' },
    ])
  })

  it('leaves actions off when there are none', () => {
    expect(osNotificationOptions({ title: 'T', body: 'B', actions: [] })).not.toHaveProperty('actions')
  })

  it('groups an agent\'s notifications together', () => {
    const options = osNotificationOptions({ title: 'T', body: 'B', context: { agentSlug: 'sales', sessionId: 's1' } })
    expect(options.groupId).toBe('sales')
  })

  it('keeps the group within the length a Windows toast accepts', () => {
    const options = osNotificationOptions({ title: 'T', body: 'B', context: { agentSlug: 'a'.repeat(100) } }, 'win32')
    expect(options.groupId).toHaveLength(64)
  })

  it('posts a review under an id derived from the review on macOS', () => {
    const context = { kind: 'proxy_review', reviewId: 'r-1', agentSlug: 'sales' }
    expect(osNotificationOptions({ title: 'T', body: 'B', context }, 'darwin').id).toBe(reviewNotificationId('r-1'))
  })

  it('lets other platforms pick the id of a review', () => {
    const context = { kind: 'proxy_review', reviewId: 'r-1' }
    expect(osNotificationOptions({ title: 'T', body: 'B', context }, 'win32')).not.toHaveProperty('id')
  })

  it('lets the OS pick the id of anything that is not a review', () => {
    const context = { kind: 'session_complete', reviewId: 'r-1' }
    expect(osNotificationOptions({ title: 'T', body: 'B', context }, 'darwin')).not.toHaveProperty('id')
  })
})

describe('reviewIdOf', () => {
  it('reads the review of a proxy-review notification', () => {
    expect(reviewIdOf({ kind: 'proxy_review', reviewId: 'r-1' })).toBe('r-1')
  })

  it('ignores anything else', () => {
    expect(reviewIdOf(undefined)).toBeUndefined()
    expect(reviewIdOf({ kind: 'proxy_review' })).toBeUndefined()
    expect(reviewIdOf({ kind: 'x_agent_review', reviewId: 'r-1' })).toBeUndefined()
  })
})

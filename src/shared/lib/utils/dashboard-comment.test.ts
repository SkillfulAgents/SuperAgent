import { describe, expect, it } from 'vitest'
import { appendDashboardCommentContext, parseDashboardCommentContext } from './dashboard-comment'

describe('dashboard comment context', () => {
  it('round-trips a context block after the comment', () => {
    const message = appendDashboardCommentContext('Make it blue', 'line one\nline two')
    expect(message).toBe('Make it blue\n\n[Dashboard comment context:]\nline one\nline two')
    expect(parseDashboardCommentContext(message)).toEqual({ cleanText: 'Make it blue', context: 'line one\nline two' })
  })

  it('leaves a message without one alone', () => {
    expect(parseDashboardCommentContext('plain')).toEqual({ cleanText: 'plain', context: null })
  })

  it('reads from the first marker, so console output quoting one stays inside', () => {
    const context = 'logs:\n\n[Dashboard comment context:]\nquoted by the page'
    const message = appendDashboardCommentContext('Fix it', context)
    expect(parseDashboardCommentContext(message)).toEqual({ cleanText: 'Fix it', context })
  })

  it('needs the marker on a line of its own after a blank line', () => {
    const text = 'see [Dashboard comment context:] inline'
    expect(parseDashboardCommentContext(text)).toEqual({ cleanText: text, context: null })
  })
})

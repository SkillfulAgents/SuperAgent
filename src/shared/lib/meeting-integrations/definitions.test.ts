import { describe, expect, it, vi } from 'vitest'

const appLink = vi.hoisted(() => ({ baseUrl: null as string | null }))
vi.mock('../agent-integrations/app-link', () => ({ resolveInternetAppBaseUrl: () => appLink.baseUrl }))
vi.mock('../db', () => ({ db: {} }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))

const { meetingAvailability } = await import('./definitions')

describe('meetingAvailability', () => {
  it('needs a public address for the bot to load the page and a bot service, and never a particular voice provider', () => {
    appLink.baseUrl = null
    expect(meetingAvailability(true)).toBe(false)
    expect(meetingAvailability(false)).toBe(false)
    appLink.baseUrl = 'https://app.example'
    expect(meetingAvailability(false)).toBe(false)
    expect(meetingAvailability(true)).toBe(true)
  })
})

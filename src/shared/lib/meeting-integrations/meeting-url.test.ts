import { describe, expect, it } from 'vitest'
import { parseMeetingUrl } from './meeting-url'

describe('parseMeetingUrl', () => {
  it('recognizes Google Meet rooms and lookup links', () => {
    expect(parseMeetingUrl('https://meet.google.com/abc-defg-hij')).toEqual({ platform: 'google_meet', url: 'https://meet.google.com/abc-defg-hij' })
    expect(parseMeetingUrl('meet.google.com/abc-defg-hij?authuser=0')?.platform).toBe('google_meet')
    expect(parseMeetingUrl('https://meet.google.com/lookup/team-sync')?.platform).toBe('google_meet')
    expect(parseMeetingUrl('https://meet.google.com/')).toBeNull()
  })
  it('keeps Zoom passcodes embedded in invite links', () => {
    const parsed = parseMeetingUrl('https://us02web.zoom.us/j/1234567890?pwd=abcDEF123')
    expect(parsed).toEqual({ platform: 'zoom', url: 'https://us02web.zoom.us/j/1234567890?pwd=abcDEF123' })
    expect(parseMeetingUrl('https://zoom.us/wc/join/1234567890')?.platform).toBe('zoom')
    expect(parseMeetingUrl('https://zoom.us/pricing')).toBeNull()
  })
  it('recognizes Teams meetup-join and short meet links, not the Teams home page', () => {
    expect(parseMeetingUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d')?.platform).toBe('microsoft_teams')
    expect(parseMeetingUrl('https://teams.live.com/meet/9876543210?p=abc')?.platform).toBe('microsoft_teams')
    expect(parseMeetingUrl('https://teams.microsoft.com/')).toBeNull()
    expect(parseMeetingUrl('https://teams.microsoft.com/_#/calendar')).toBeNull()
  })
  it('rejects anything that is not a platform invite', () => {
    expect(parseMeetingUrl('https://calendar.google.com/event?eid=abc')).toBeNull()
    expect(parseMeetingUrl('http://meet.google.com/abc-defg-hij')).toBeNull()
    expect(parseMeetingUrl('not a url')).toBeNull()
    expect(parseMeetingUrl('https://evil.example/meet.google.com/abc-defg-hij')).toBeNull()
  })
  it('hands the bot host the invite without embedded credentials or a fragment', () => {
    expect(parseMeetingUrl('https://user:secret@zoom.us/j/1234567890?pwd=abc#success')?.url).toBe('https://zoom.us/j/1234567890?pwd=abc')
  })
})

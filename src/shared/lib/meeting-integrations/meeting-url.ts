import { z } from 'zod'

/** Platforms a meeting bot host can join. Kept independent of any provider. */
export const MEETING_PLATFORMS = ['zoom', 'google_meet', 'microsoft_teams'] as const
export const meetingPlatformSchema = z.enum(MEETING_PLATFORMS)
export type MeetingPlatform = z.infer<typeof meetingPlatformSchema>

export const MEETING_PLATFORM_LABELS: Record<MeetingPlatform, string> = {
  zoom: 'Zoom', google_meet: 'Google Meet', microsoft_teams: 'Microsoft Teams',
}

export interface ParsedMeetingUrl {
  platform: MeetingPlatform
  /** The normalized URL handed to the bot host; passcodes in the query survive, credentials and fragments do not. */
  url: string
}

/** Recognize an invite link. Only real platform hosts and their meeting paths: shorteners, calendar redirects and platform home pages are rejected. */
export function parseMeetingUrl(input: string): ParsedMeetingUrl | null {
  const trimmed = input.trim()
  const url = URL.parse(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  if (!url || url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  const platform: MeetingPlatform | null = host === 'meet.google.com'
    ? (/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/.test(url.pathname) || /^\/lookup\/[^/]+/.test(url.pathname) ? 'google_meet' : null)
    : host === 'zoom.us' || host.endsWith('.zoom.us') || host.endsWith('.zoomgov.com')
      ? (/^\/(j|w|s|wc\/join|my)\/[^/]+/.test(url.pathname) ? 'zoom' : null)
      : host === 'teams.microsoft.com' || host === 'teams.live.com' || host.endsWith('.teams.microsoft.com')
        ? (/^\/(l\/meetup-join|meet)\/[^/]+/.test(url.pathname) ? 'microsoft_teams' : null)
        : null
  if (!platform) return null
  // Nothing but the invite goes to the bot host: no embedded credentials, no fragment.
  url.username = ''; url.password = ''; url.hash = ''
  return { platform, url: url.toString() }
}

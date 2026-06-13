export interface GoogleUserInfo {
  email: string
  name?: string
  picture?: string
}

const GOOGLE_TOOLKITS = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
  'googleslides',
  'googlemeet',
  'googletasks',
  'youtube',
]

const MICROSOFT_TOOLKITS = ['outlook', 'microsoft_teams']

function getGoogleEmailLookup(
  toolkitSlug: string
): { endpoint: string; field: 'email' | 'id' } | null {
  if (toolkitSlug === 'googlecalendar') {
    return {
      endpoint:
        'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary',
      field: 'id',
    }
  }
  if (GOOGLE_TOOLKITS.includes(toolkitSlug)) {
    return {
      endpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
      field: 'email',
    }
  }
  return null
}

export async function getGoogleUserInfo(
  accessToken: string,
  toolkitSlug: string = 'gmail'
): Promise<GoogleUserInfo | null> {
  const lookup = getGoogleEmailLookup(toolkitSlug)
  if (!lookup) return null
  try {
    const response = await fetch(lookup.endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      console.warn('Failed to fetch Google user info:', response.status)
      return null
    }
    const data = await response.json()
    const email = typeof data?.[lookup.field] === 'string' ? data[lookup.field] : ''
    if (!email) return null
    return {
      email,
      name: typeof data?.name === 'string' ? data.name : undefined,
      picture: typeof data?.picture === 'string' ? data.picture : undefined,
    }
  } catch (error) {
    console.warn('Error fetching Google user info:', error)
    return null
  }
}

type MakeApiCallFn = (params: {
  providerConnectionId: string
  toolkitSlug: string
  targetUrl: string
  method: string
  headers: Headers
  body: ArrayBuffer | null
}) => Promise<Response>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

async function resolveGoogleDisplayName(
  makeApiCall: MakeApiCallFn,
  connectionId: string,
  toolkitSlug: string,
): Promise<string | null> {
  const lookup = getGoogleEmailLookup(toolkitSlug)
  if (!lookup) return null
  try {
    const response = await makeApiCall({
      providerConnectionId: connectionId,
      toolkitSlug,
      targetUrl: lookup.endpoint,
      method: 'GET',
      headers: new Headers(),
      body: null,
    })
    if (!response.ok) return null
    const data = await response.json()
    if (!isRecord(data)) return null
    const email = typeof data[lookup.field] === 'string' ? (data[lookup.field] as string) : ''
    return email || null
  } catch (error) {
    console.warn('Could not fetch Google user info for display name:', error)
    return null
  }
}

async function resolveMicrosoftDisplayName(
  makeApiCall: MakeApiCallFn,
  connectionId: string,
  toolkitSlug: string,
): Promise<string | null> {
  try {
    const response = await makeApiCall({
      providerConnectionId: connectionId,
      toolkitSlug,
      targetUrl: 'https://graph.microsoft.com/v1.0/me',
      method: 'GET',
      headers: new Headers(),
      body: null,
    })
    if (!response.ok) return null
    const data = await response.json()
    if (!isRecord(data)) return null
    const mail = data.mail
    const upn = data.userPrincipalName
    if (typeof mail === 'string' && mail) return mail
    if (typeof upn === 'string' && upn) return upn
    return null
  } catch (error) {
    console.warn('Could not fetch Microsoft user info for display name:', error)
    return null
  }
}

export async function resolveDisplayName(
  makeApiCall: MakeApiCallFn,
  connectionId: string,
  toolkitSlug: string,
  fallbackName: string,
): Promise<string> {
  const slug = toolkitSlug.toLowerCase()

  if (GOOGLE_TOOLKITS.includes(slug)) {
    const email = await resolveGoogleDisplayName(makeApiCall, connectionId, slug)
    if (email) return email
  } else if (MICROSOFT_TOOLKITS.includes(slug)) {
    const email = await resolveMicrosoftDisplayName(makeApiCall, connectionId, slug)
    if (email) return email
  }

  return fallbackName
}

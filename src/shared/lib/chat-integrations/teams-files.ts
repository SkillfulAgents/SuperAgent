import { z } from 'zod'
import { isHostOrSubdomain } from '../utils/url-safety'

export function isTeamsServiceHost(hostname: string): boolean {
  return hostname === 'smba.trafficmanager.net' || hostname.endsWith('.msg.teams.microsoft.com') || hostname === 'smba.infra.gcc.teams.microsoft.com'
}

export function isTeamsInlineImageUrl(value: string): boolean {
  const url = URL.parse(value)
  return !!url && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
    isTeamsServiceHost(url.hostname) && /^\/(?:[a-zA-Z0-9-]+\/)*v3\/attachments\/[a-zA-Z0-9%_.~:=+-]+\/views\/original$/.test(url.pathname)
}

// The file URLs in an activity are capabilities in their own right. No app
// token is attached, and every redirect is checked before issuing a request.
export function isTeamsFileUrl(value: string): boolean {
  const url = URL.parse(value)
  return !!url && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['sharepoint.com', '1drv.com', 'onedrive.com', 'onedrive.live.com'].some(domain => isHostOrSubdomain(url.hostname, domain))
}

export async function fetchTeamsFile(value: string): Promise<Response> {
  let target = value
  const signal = AbortSignal.timeout(30_000)
  for (let hop = 0; hop < 6; hop++) {
    if (!isTeamsFileUrl(target)) throw new Error('Unrecognized Microsoft file destination')
    const response = await fetch(target, { redirect: 'manual', signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) break
    const redirected = URL.parse(location, target)
    if (!redirected) break
    target = redirected.href
  }
  throw new Error('Microsoft file download exceeded the redirect limit')
}

export async function uploadTeamsFile(url: string, data: Buffer): Promise<void> {
  if (!isTeamsFileUrl(url) || !data.length) throw new Error('Invalid Microsoft file upload destination or size')
  // OneDrive requires every non-final fragment to be a multiple of 320 KiB.
  const chunkSize = 16 * 320 * 1024
  let start = 0
  while (start < data.length) {
    const end = Math.min(start + chunkSize, data.length)
    const response = await fetch(url, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` },
      body: new Uint8Array(data.subarray(start, end)),
    })
    await response.body?.cancel()
    if (response.status === 416) {
      // A previous attempt can have committed this fragment before its response
      // arrived. OneDrive reports the first byte still missing on the session.
      const resume = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!resume.ok) throw new Error(`Microsoft file upload session returned HTTP ${resume.status}`)
      const { nextExpectedRanges } = z.object({ nextExpectedRanges: z.array(z.string().regex(/^\d+-\d*$/)).min(1) }).parse(await resume.json())
      const offset = Math.min(...nextExpectedRanges.map(range => Number(range.split('-')[0])))
      if (!Number.isSafeInteger(offset) || offset <= start || offset >= data.length) throw new Error('Invalid Microsoft upload session offset')
      start = offset
      continue
    }
    if (!(end < data.length ? response.status === 202 : [200, 201].includes(response.status))) throw new Error(`Microsoft file upload returned HTTP ${response.status}`)
    start = end
  }
}

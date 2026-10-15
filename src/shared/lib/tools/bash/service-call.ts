import { TOOLKIT_ALLOWED_HOSTS, isHostAllowed } from '@shared/lib/proxy/allowed-hosts'
import { SCOPE_MAPS } from '@shared/lib/proxy/scope-maps'
import { getProviderDisplayName } from '@shared/lib/account-providers/service-catalog'

/** Built-in platform services, named by capability unless the brand is the subject. */
const BUILT_IN_SERVICES = {
  replicate: 'Media generation',
  apollo: 'Lead enrichment',
  openai: 'Audio',
  x: 'X',
} as const

export type BuiltInService = keyof typeof BUILT_IN_SERVICES

/** Which Gamut platform service a Bash command calls. */
export type ServiceCall =
  | { kind: 'connected-account'; toolkit: string; name: string }
  | { kind: 'built-in'; service: BuiltInService; name: string }

// The whole host or service segment; the allowlist and the built-in list decide whether it is real.
// Older agent docs reached built-ins through $ANTHROPIC_BASE_URL.
const PROXY_URL = /\$(?:\{PROXY_BASE_URL\}|PROXY_BASE_URL)\/[^/\s"']+\/([^/\s"'?]+)(\/[^\s"'?]*)?/g
const PLATFORM_URL = /\$(?:\{(?:PLATFORM|ANTHROPIC)_BASE_URL\}|(?:PLATFORM|ANTHROPIC)_BASE_URL)\/v1\/([^/\s"'?]+)/g
// An unquoted URL can run straight into a shell terminator: `curl $PROXY_BASE_URL/a/api.github.com; ...`
const TRAILING_TERMINATORS = /[;|&)]+$/

function isBuiltInService(service: string): service is BuiltInService {
  return Object.hasOwn(BUILT_IN_SERVICES, service)
}

/** The toolkit a proxied host serves. A host several toolkits share resolves only when its path names one. */
function toolkitFor(host: string, path: string): string | null {
  const candidates = Object.keys(TOOLKIT_ALLOWED_HOSTS).filter((toolkit) => isHostAllowed(toolkit, host))
  if (candidates.length === 1) return candidates[0]
  const byPath = candidates.filter((toolkit) => {
    const basePath = SCOPE_MAPS[toolkit]?.basePath
    return !!basePath && path.startsWith(basePath)
  })
  return byPath.length === 1 ? byPath[0] : null
}

/**
 * The one platform service a command calls, in any shell shape (pipes, loops, variables).
 * Null when it calls none, an unknown one, or more than one.
 */
export function identifyServiceCall(command: string): ServiceCall | null {
  const keys = new Set<string>()
  let call: ServiceCall | null = null

  for (const [, segment, path = ''] of command.matchAll(PROXY_URL)) {
    const toolkit = toolkitFor(segment.replace(TRAILING_TERMINATORS, ''), path)
    if (!toolkit) return null
    keys.add(`connected-account:${toolkit}`)
    call = { kind: 'connected-account', toolkit, name: getProviderDisplayName(toolkit) }
  }
  for (const [, segment] of command.matchAll(PLATFORM_URL)) {
    const service = segment.replace(TRAILING_TERMINATORS, '')
    if (!isBuiltInService(service)) return null
    keys.add(`built-in:${service}`)
    call = { kind: 'built-in', service, name: BUILT_IN_SERVICES[service] }
  }

  return keys.size === 1 ? call : null
}

const FETCH_COMMAND = /(?:^|[\s;&|(`])(?:curl|wget)\s/
const PLATFORM_VARIABLE = /\$\{?(?:PROXY|PLATFORM|ANTHROPIC)_BASE_URL\b/
const LITERAL_URL = /https?:\/\/[^\s"'`<>;|&)]+/g
// URL parsing accepts `${HOST}` as a hostname; a literal site is dotted labels.
const SITE_HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/

/** The website a direct (non-platform) curl or wget fetches, and the toolkit whose icon Gamut already ships for it. */
export interface DirectSite {
  origin: string
  toolkit: string | null
}

/**
 * The one site a direct curl or wget names, read from its literal URLs. Null when the command fetches
 * nothing, names two sites, or touches a platform URL at all: identifyServiceCall decides those.
 * Matching is by text, so a command built to mislead can show the wrong icon; the raw command stays one click away.
 */
export function identifyDirectSite(command: string): DirectSite | null {
  if (!FETCH_COMMAND.test(command) || PLATFORM_VARIABLE.test(command)) return null
  const urls: URL[] = []
  for (const [text] of command.matchAll(LITERAL_URL)) {
    try {
      urls.push(new URL(text))
    } catch {
      return null
    }
  }
  if (!urls.every((url) => SITE_HOSTNAME.test(url.hostname))) return null
  if (new Set(urls.map((url) => url.hostname)).size !== 1) return null
  const toolkits = new Set(urls.map((url) => toolkitFor(url.hostname, url.pathname)))
  return { origin: urls[0].origin, toolkit: toolkits.size === 1 ? [...toolkits][0] : null }
}

import { useState } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

/**
 * Renders a vendor-supplied page icon (Exa `favicon`), or a globe when absent/blocked.
 * Only https icon URLs are accepted; private/local hosts are refused. Pattern ancestry:
 * onError→fallback from agent-home/home-bookmarks.tsx. No third-party favicon service.
 *
 * Hosts that only exist on this machine or the local network: a result pointing at one
 * would turn a card render into a quiet probe of the user's own network, so it gets the
 * generic icon instead. Literal addresses only - a public name resolving to a private
 * address still loads, which is acceptable for an <img> whose response can't be read back.
 *
 * Deliberately mirrors, rather than imports, `isPrivateHost` from
 * shared/lib/utils/url-safety.ts: that module imports `node:dns/promises` at top level, and no
 * renderer file pulls it in today. Importing it here would drag Node's dns into the browser
 * bundle - which typecheck and vitest both pass and only a build catches. site-favicon.test.ts
 * asserts this copy is never weaker than that one, so loosening it here fails the suite.
 */
function isPrivateHost(hostname: string): boolean {
  // A trailing dot is the same name to a resolver ('localhost.' resolves to localhost), so it
  // is stripped before every check rather than treated as a different host.
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host === 'ip6-localhost' || host === 'ip6-loopback') return true
  if (host.includes(':')) {
    // IPv6 literal. The fc/fd/fe80 prefixes are only meaningful here - a public name like
    // 'fd.example' is not a unique-local address. Link-local is fe80::/10, so the whole
    // fe80-febf hextet range counts, not just addresses starting 'fe80:'.
    const hextet = parseInt(host.split(':')[0], 16)
    if (host === '::1' || host === '::' || /^f[cd]/.test(host)) return true
    if (hextet >= 0xfe80 && hextet <= 0xfebf) return true
    const mapped = host.match(/^::ffff:(.+)$/)
    return mapped ? isPrivateV4(hexQuadToV4(mapped[1])) : false
  }
  return isPrivateV4(host)
}

function isPrivateV4(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return (
    a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  )
}

/** '7f00:1' -> '127.0.0.1'. Already-dotted input passes through; anything else is not an address. */
function hexQuadToV4(rest: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest
  const quad = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!quad) return ''
  const n = (parseInt(quad[1], 16) << 16) | parseInt(quad[2], 16)
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/**
 * A vendor-supplied icon URL, accepted only if https and not a private host. The URL is the
 * page's own declared icon, so a hostile page can name anything - including an address on the
 * reader's network. http is refused rather than upgraded to https: we did not construct this
 * path, so rewriting its scheme would just 404.
 */
export function vendorFaviconHref(src: string): string | null {
  try {
    const parsed = new URL(src)
    if (parsed.protocol !== 'https:') return null
    if (isPrivateHost(parsed.hostname)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * The showable icon URL for a vendor-supplied favicon, with load failures tracked per URL -
 * a new src on the same mounted instance gets a fresh try instead of inheriting the previous
 * icon's broken state. `href` is null when the URL is refused, absent, or has failed.
 */
export function useVendorFavicon(src?: string): { href: string | null; onError: () => void } {
  const candidate = src ? vendorFaviconHref(src) : null
  const [failedHref, setFailedHref] = useState<string | null>(null)
  return {
    href: candidate && failedHref !== candidate ? candidate : null,
    onError: () => setFailedHref(candidate),
  }
}

export function SiteFavicon({
  src,
  className,
  fallback = 'globe',
}: {
  /**
   * The page's declared icon, as supplied by the search vendor. Nothing is derived: guessing
   * `/favicon.ico` misses roughly 40% of real sites, and every result we can show an icon for
   * already carries one. No icon means the generic glyph, which is the honest answer.
   */
  src?: string
  className?: string
  /** 'none' where a globe already sits in the same row, so a failure isn't two identical icons. */
  fallback?: 'globe' | 'none'
}) {
  const { href, onError } = useVendorFavicon(src)
  if (!href) {
    if (fallback === 'none') return null
    return <Globe aria-hidden className={cn('shrink-0 text-muted-foreground', className)} />
  }
  // Light plate in both themes: site favicons are often dark-on-transparent (Exa returns the
  // page's declared icon, not a dark-mode variant). Size/margin classes land on the plate.
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm bg-white ring-1 ring-black/10',
        className,
      )}
    >
      <img src={href} alt="" className="h-full w-full object-contain" onError={onError} />
    </span>
  )
}

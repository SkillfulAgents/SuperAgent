import { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { getApiBaseUrl } from './env'

// react-markdown's defaultUrlTransform passes only URLs whose scheme matches
// ^(https?|ircs?|mailto|xmpp)$ and rewrites everything else to '' (an empty
// href). That silently kills the tel:/sms: links agents emit (SUP-238), even
// though the Electron shell opener explicitly allows them — see
// src/main/safe-open-external.ts POPUP_PROTOCOLS, added in SUP-214.
//
// These are the extra link schemes the renderer should keep so the renderer and
// the opener stay in lockstep. They are communication composers (dialer / SMS
// composer): inert until the user confirms the call/text, and never executed in
// the page like javascript:/data:.
const EXTRA_ALLOWED_HREF_SCHEME = /^(?:tel|sms):/i

/**
 * The renderer's single link-href policy: the URL to use, or '' to refuse it.
 *
 * Both link surfaces go through here — <ReactMarkdown> via markdownUrlTransform
 * below, and plain-prose autolinking via src/renderer/lib/linkify.tsx — so the
 * two can never drift apart, or from safe-open-external.ts.
 */
export function safeHref(url: string): string {
  if (EXTRA_ALLOWED_HREF_SCHEME.test(url)) {
    return url
  }
  return defaultUrlTransform(url)
}

/**
 * Shared `urlTransform` for every <ReactMarkdown> renderer.
 *
 * Composes react-markdown's defaultUrlTransform — so dangerous schemes
 * (javascript:, file:, data:, vbscript:, custom protocols, …) are still blanked
 * exactly as before — and additionally permits tel:/sms: on link hrefs.
 *
 * Scoped to `key === 'href'` on purpose: it widens what links may point at, not
 * what images/other resources may load.
 */
export const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key === 'href' && typeof url === 'string') {
    return safeHref(url)
  }
  return defaultUrlTransform(url)
}

export interface MarkdownImageContext {
  /** Exact container paths proven to belong to image blocks in tool results. */
  aliases?: ReadonlyMap<string, string>
  /** Enables file:///workspace images through the authenticated workspace route. */
  agentSlug?: string
}

const IMAGE_FILE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i

/** Resolve an agent-workspace file without ever handing `file:` to Chromium. */
function workspaceImageUrl(url: string, agentSlug: string): string | null {
  let pathname: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' || parsed.hostname !== '') return null
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }

  const prefix = '/workspace/'
  if (!pathname.startsWith(prefix) || !IMAGE_FILE_EXTENSION.test(pathname)) return null

  const parts = pathname.slice(prefix.length).split('/')
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) return null

  const encodedPath = parts.map(encodeURIComponent).join('/')
  return (
    `${getApiBaseUrl()}/api/agents/${encodeURIComponent(agentSlug)}` +
    `/files/${encodedPath}?inline=true`
  )
}

/**
 * Per-message Markdown policy for embedded images. Links and ordinary images
 * retain the shared default policy. A blocked `file:` image is widened only
 * when it resolves to a verified tool-result alias or an authenticated file in
 * that agent's `/workspace`; arbitrary host/container paths stay blocked.
 */
export function createMarkdownUrlTransform(context: MarkdownImageContext = {}): UrlTransform {
  return (url, key, node) => {
    if (key === 'src' && typeof url === 'string') {
      const alias = context.aliases?.get(url)
      if (alias) return alias

      if (context.agentSlug) {
        const workspaceUrl = workspaceImageUrl(url, context.agentSlug)
        if (workspaceUrl) return workspaceUrl
      }
    }

    return markdownUrlTransform(url, key, node)
  }
}

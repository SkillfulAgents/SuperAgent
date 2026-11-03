import { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { isPreviewableImage } from './file-types'
import { agentFileHref, getAgentFileUrl, resolveAgentFilePath } from './workspace-file-url'

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
 * The href branch widens what links may point at. The src branch narrows what
 * images may load to absolute web URLs: a relative src would load from the
 * app's own origin with the user's session.
 */
export const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key === 'href' && typeof url === 'string') {
    return safeHref(url)
  }
  if (key === 'src' && typeof url === 'string') {
    return /^https?:\/\//i.test(url) ? url : ''
  }
  return defaultUrlTransform(url)
}

export interface MarkdownImageContext {
  /** Exact container paths proven to belong to image blocks in tool results. */
  aliases?: ReadonlyMap<string, string>
  /** Resolves agent file links and images through the authenticated file route. */
  agentSlug?: string
  /** Where a relative path resolves from: the open file's folder, `/workspace` by default, or null for nowhere. */
  folder?: string | null
}

/**
 * Per-message Markdown policy for agent files. A link or image the resolver
 * names as one of that agent's files becomes its canonical `file:` link or its
 * authenticated image URL. Everything else, tool-result aliases aside, keeps the
 * shared policy, so arbitrary host and container paths stay blocked.
 */
export function createMarkdownUrlTransform(context: MarkdownImageContext = {}): UrlTransform {
  const folder = context.folder === undefined ? '/workspace' : context.folder
  return (url, key, node) => {
    if (key === 'src' && typeof url === 'string') {
      const alias = context.aliases?.get(url)
      if (alias) return alias
    }

    if (context.agentSlug && (key === 'src' || key === 'href') && typeof url === 'string') {
      const filePath = resolveAgentFilePath(url, folder)
      if (filePath && key === 'href') return agentFileHref(filePath)
      if (filePath && isPreviewableImage(filePath)) return getAgentFileUrl(context.agentSlug, filePath, { inline: true })
    }

    return markdownUrlTransform(url, key, node)
  }
}

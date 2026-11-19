import { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { describeWorkspaceFile } from './workspace-file'
import { resolveAgentFilePath } from './workspace-file-url'

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

/** Whether a url names its scheme (`https:`, `mailto:`), as opposed to a path. */
export function hasUrlScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url)
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
  /** Opts in to this agent's files: never for text written outside the app, since resolving one reads it with the viewer's session. */
  agentSlug?: string
  /** Opts in to relative paths, resolved from this folder: the folder of the file being shown. */
  folder?: string
  /** Filled with each href this transform made for an agent file or folder, keyed to the path it names. */
  agentFileLinks?: Map<string, string>
}

/**
 * Per-message Markdown policy for agent files. A link the resolver names as
 * one of that agent's files gets the file's URL, and a folder link keeps its
 * path. An image gets its authenticated inline URL. Everything else, tool-result
 * aliases aside, keeps the shared policy, so arbitrary host and container paths
 * stay blocked.
 */
export function createMarkdownUrlTransform(context: MarkdownImageContext = {}): UrlTransform {
  return (url, key, node) => {
    if (key === 'src' && typeof url === 'string') {
      const alias = context.aliases?.get(url)
      if (alias) return alias
    }

    if (context.agentSlug && (key === 'src' || key === 'href') && typeof url === 'string') {
      const filePath = resolveAgentFilePath(url, context.folder)
      const file = filePath === null ? null : describeWorkspaceFile(filePath, context.agentSlug)
      if (file && key === 'href') {
        // A folder has no URL, so its link carries its path for the link to open.
        const href = file.downloadUrl ?? file.path
        context.agentFileLinks?.set(href, file.path)
        return href
      }
      if (file?.isImage) return file.inlineUrl
    }

    return markdownUrlTransform(url, key, node)
  }
}

import { defaultUrlTransform, type UrlTransform } from 'react-markdown'

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
  if (key === 'href' && typeof url === 'string' && EXTRA_ALLOWED_HREF_SCHEME.test(url)) {
    return url
  }
  return defaultUrlTransform(url)
}

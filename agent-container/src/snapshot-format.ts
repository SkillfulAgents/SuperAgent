/**
 * Snapshot scoping, full-text mode, iframe placeholders, and auto-degrade
 * (browser-tools audit P1 #10).
 *
 * The forced `-i -c` snapshot hard-failed the MCP token cap on ordinary
 * directory pages (66K chars on TAAFT, F7), blinding the agent at modal-
 * critical moments; it also strips ALL static text (validation errors,
 * prices, instructions — F5), and emits no marker for cross-origin iframes
 * whose fields are therefore invisible (Stripe Payment Element, P2). These
 * helpers add the scoping/full-text/url controls the CLI already supports but
 * the tool never exposed, surface iframe boundaries, and degrade gracefully
 * instead of erroring at the cap.
 */

/**
 * Auto-degrade threshold. The SDK tool-result token cap (~25k tokens) fires
 * around 62–74k chars of token-dense a11y text — nondeterministically at the
 * edge. Truncate well below that so a snapshot never hard-errors mid-flow.
 */
export const SNAPSHOT_SOFT_CAP_CHARS = 45_000

export interface IframeInfo {
  title: string
  host: string
  /** Contents reachable from the page's JS / merged into the snapshot. */
  sameOrigin: boolean
}

/** Parse the iframe-enumeration eval output (CLI double-JSON-encodes). */
export function parseIframeInfo(stdout: string): IframeInfo[] {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map(f => ({
        title: typeof f.title === 'string' ? f.title : '',
        host: typeof f.host === 'string' ? f.host : '',
        sameOrigin: f.sameOrigin === true,
      }))
  } catch {
    return []
  }
}

/**
 * Render placeholders for cross-origin iframes (whose fields the a11y snapshot
 * cannot see). Same-origin frames are already merged into the tree, so they
 * are omitted. Returns '' when there is nothing the agent is blind to.
 */
export function formatIframePlaceholders(iframes: IframeInfo[]): string {
  const opaque = iframes.filter(f => !f.sameOrigin && f.host)
  if (opaque.length === 0) return ''
  const lines = opaque.map(f => {
    const label = f.title ? `"${f.title}" ` : ''
    return `  - iframe ${label}(${f.host}) — contents NOT in this snapshot (cross-origin)`
  })
  return (
    `\n\nFrames on this page whose fields are not captured above:\n${lines.join('\n')}\n` +
    `If you need to fill a field inside one (e.g. card number in a payment frame), click into it by coordinates, then use browser_type.`
  )
}

/**
 * Cap snapshot text below the MCP token limit. When it would overflow, return
 * a truncated head plus guidance to scope — far better than the hard error
 * the cap produces (which leaves the agent with nothing).
 */
export function capSnapshot(text: string, scopeUsed: boolean): string {
  if (text.length <= SNAPSHOT_SOFT_CAP_CHARS) return text
  const scopeHint = scopeUsed
    ? 'Even scoped, this region is large — pass a tighter scope selector.'
    : 'Pass scope="<css selector>" (e.g. "form", "#main", ".modal", a dialog selector) to target just the region you need.'
  return (
    `${text.slice(0, SNAPSHOT_SOFT_CAP_CHARS)}\n` +
    `…[snapshot truncated — ${text.length} chars total, showing ${SNAPSHOT_SOFT_CAP_CHARS}. ${scopeHint}]`
  )
}

export const IFRAME_ENUM_SCRIPT =
  'JSON.stringify([...document.querySelectorAll("iframe")]' +
  '.filter(f=>f.offsetParent!==null)' +
  '.map(f=>{let host="";try{host=new URL(f.src).host}catch(e){}' +
  'let same=false;try{same=!!f.contentDocument}catch(e){}' +
  'return{title:f.title||"",host,sameOrigin:same}}))'

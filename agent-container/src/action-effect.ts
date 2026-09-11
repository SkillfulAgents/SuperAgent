/**
 * Post-action DOM effect (transcript-mining theme 3).
 *
 * The URL digest in browser-digest.ts is the only post-action state click,
 * press, select and hover return, and on a single-page app it reads
 * "URL unchanged" whether a dialog opened, a toast fired, a request failed or
 * the click was swallowed — 118 of 200 reviewed sessions either over-trusted
 * it or paid a snapshot per click. The tree diff was deferred because a
 * snapshot per action rotates the CLI's ref registry. This module gets the
 * effect without a snapshot: one eval before the action and one after the
 * settle, fingerprinting what a person would notice — open dialogs, live-
 * region announcements, the count of interactive elements, the page text,
 * the focused element, and any request that failed since the action.
 *
 * Failed requests come from PerformanceResourceTiming.responseStatus
 * (Chrome 109+). Cross-origin responses without Timing-Allow-Origin report 0
 * and are not counted, so the line is a floor, never a claim of "no errors".
 */

export interface TopLayerEntry {
  kind: string
  name: string
}

export interface FailedRequest {
  url: string
  status: number
  initiator: string
}

export interface Fingerprint {
  /** performance.now() at capture — the "after" read filters requests by it. */
  t: number
  url: string
  /** Visible interactive elements (DOM census, not refs — no snapshot involved). */
  interactive: number
  top: TopLayerEntry[]
  live: string[]
  textLen: number
  textHash: number
  focus: string
  failed: FailedRequest[]
}

const LIVE_SELECTOR = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output'
const INTERACTIVE_SELECTOR =
  'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],' +
  '[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],' +
  '[role="combobox"],[role="textbox"],[role="switch"],[role="slider"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
const TOP_LAYER_SELECTOR = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'
const TEXT_HASH_CAP = 100_000
const MAX_FAILED = 5

/**
 * Build the fingerprint eval. `since` (a performance.now() value) makes the
 * "after" read collect failed requests started after the action; the
 * "before" read (no `since`) clears the resource-timing buffer instead, so a
 * long SPA session cannot fill the default 250-entry buffer and hide a later
 * failure.
 */
export function fingerprintScript(since?: number): string {
  const sinceExpr = typeof since === 'number' && Number.isFinite(since) ? String(since) : 'null'
  return (
    '(function(){var o={t:0,url:"",interactive:0,top:[],live:[],textLen:0,textHash:0,focus:"",failed:[]};' +
    'var ws=function(s){return String(s||"").replace(/\\s+/g," ").trim()};' +
    // checkVisibility covers visibility:hidden / opacity:0, which is how many
    // dropdowns hide their closed state (Wikipedia's Vector menu keeps layout
    // boxes for hidden links, so getClientRects alone counted them as visible
    // and the menu opening read as "+0 interactive elements"). Both option
    // spellings are passed: Chrome renamed them in 2024.
    'var vis=function(el){try{if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,opacityProperty:true,checkVisibilityCSS:true,checkOpacity:true});return el.getClientRects().length>0}catch(e){return false}};' +
    'var since=' + sinceExpr + ';' +
    'try{o.t=performance.now()}catch(e){}' +
    'try{o.url=String(location.href||"")}catch(e){}' +
    'try{if(since===null){performance.clearResourceTimings()}else{var rs=performance.getEntriesByType("resource");' +
    'for(var i=0;i<rs.length&&o.failed.length<' + MAX_FAILED + ';i++){var r=rs[i];if(r.startTime>since&&r.responseStatus>=400){' +
    'var u=r.name;try{var p=new URL(u);u=(p.host===location.host?"":p.host)+p.pathname}catch(e){}' +
    'o.failed.push({url:u.slice(0,120),status:r.responseStatus,initiator:String(r.initiatorType||"")})}}}}catch(e){}' +
    'try{var els=document.querySelectorAll(' + JSON.stringify(INTERACTIVE_SELECTOR) + ');for(var j=0;j<els.length;j++){if(vis(els[j]))o.interactive++}}catch(e){}' +
    'try{var name=function(el){var n=el.getAttribute("aria-label")||"";' +
    'if(!n){var lb=el.getAttribute("aria-labelledby");if(lb){var le=document.getElementById(lb.split(" ")[0]);if(le)n=le.innerText}}' +
    'if(!n){var h=el.querySelector("h1,h2,h3,h4,[role=heading]");if(h)n=h.innerText}' +
    'if(!n)n=el.innerText;return ws(n).slice(0,80)};' +
    'var tops=[].slice.call(document.querySelectorAll(' + JSON.stringify(TOP_LAYER_SELECTOR) + '));' +
    'try{tops=tops.concat([].slice.call(document.querySelectorAll(":popover-open")))}catch(e){}' +
    'var seenT={};for(var k=0;k<tops.length&&o.top.length<6;k++){var el=tops[k];if(!vis(el))continue;' +
    'var kind=el.getAttribute("role")||(el.tagName==="DIALOG"?"dialog":el.matches(":popover-open")?"popover":"dialog");' +
    'var key=kind+"|"+name(el);if(seenT[key])continue;seenT[key]=1;o.top.push({kind:kind,name:name(el)})}}catch(e){}' +
    'try{var seen={};var ls=document.querySelectorAll(' + JSON.stringify(LIVE_SELECTOR) + ');' +
    'for(var m=0;m<ls.length&&o.live.length<8;m++){if(!vis(ls[m]))continue;var s=ws(ls[m].innerText);if(!s||seen[s])continue;seen[s]=1;o.live.push(s.slice(0,300))}}catch(e){}' +
    'try{var txt=ws(document.body&&document.body.innerText);o.textLen=txt.length;var hsh=5381;var lim=Math.min(txt.length,' + TEXT_HASH_CAP + ');' +
    'for(var q=0;q<lim;q++){hsh=((hsh<<5)+hsh+txt.charCodeAt(q))|0}o.textHash=hsh}catch(e){}' +
    'try{var a=document.activeElement;if(!a||a===document.body){o.focus="nothing focused"}else{' +
    'var tag=a.tagName.toLowerCase();var role=a.getAttribute("role");var an=a.getAttribute("aria-label")||(a.labels&&a.labels[0]&&a.labels[0].innerText)||a.getAttribute("placeholder")||a.getAttribute("name")||a.innerText||"";' +
    'var implied={a:"link",input:a.type==="checkbox"||a.type==="radio"||a.type==="submit"||a.type==="button"?a.type:"textbox",select:"combobox",textarea:"textbox"};' +
    'o.focus=(role||implied[tag]||tag)+(an?" "+JSON.stringify(ws(an).slice(0,60)):"")}}catch(e){}' +
    'return JSON.stringify(o)})()'
  )
}

/** Parse fingerprint eval output (CLI double-JSON-encodes). Null when the eval did not produce one. */
export function parseFingerprint(stdout: string): Fingerprint | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const p = parsed as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [])
    const top: TopLayerEntry[] = Array.isArray(p.top)
      ? p.top
          .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
          .map(e => ({ kind: str(e.kind) || 'dialog', name: str(e.name) }))
      : []
    const failed: FailedRequest[] = Array.isArray(p.failed)
      ? p.failed
          .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
          .map(e => ({ url: str(e.url), status: num(e.status), initiator: str(e.initiator) }))
          .filter(e => e.status >= 400)
      : []
    return {
      t: num(p.t),
      url: str(p.url),
      interactive: num(p.interactive),
      top,
      live: strs(p.live),
      textLen: num(p.textLen),
      textHash: num(p.textHash),
      focus: str(p.focus),
      failed,
    }
  } catch {
    return null
  }
}

export interface ActionEffect {
  opened: TopLayerEntry[]
  closed: TopLayerEntry[]
  interactiveDelta: number
  announced: string[]
  textChanged: boolean
  /** after.textLen − before.textLen; a size for "page text changed". */
  textDelta: number
  focus: string
  focusChanged: boolean
  failed: FailedRequest[]
}

const topKey = (e: TopLayerEntry): string => `${e.kind}|${e.name}`

/** What changed between the two reads. */
export function diffFingerprints(before: Fingerprint, after: Fingerprint): ActionEffect {
  const beforeTop = new Set(before.top.map(topKey))
  const afterTop = new Set(after.top.map(topKey))
  const beforeLive = new Set(before.live)
  return {
    opened: after.top.filter(e => !beforeTop.has(topKey(e))),
    closed: before.top.filter(e => !afterTop.has(topKey(e))),
    interactiveDelta: after.interactive - before.interactive,
    announced: after.live.filter(s => !beforeLive.has(s)),
    textChanged: after.textHash !== before.textHash || after.textLen !== before.textLen,
    textDelta: after.textLen - before.textLen,
    focus: after.focus,
    focusChanged: after.focus !== before.focus,
    failed: after.failed,
  }
}

export interface EffectFormatOptions {
  /** How long the harness waited before the "after" read. */
  settleMs: number
  /** 'click' | 'press' | 'select' | 'hover' — picks the no-change hint. */
  verb: 'click' | 'press' | 'select' | 'hover'
}

const NO_CHANGE_HINT: Record<EffectFormatOptions['verb'], string> = {
  click: 'the element may not be handling clicks (disabled, covered, or needs a different target). Check its state, or browser_wait for what you expect to appear.',
  press: 'the key may have been ignored by the focused element. Check what is focused, or browser_wait for what you expect to appear.',
  select: 'the page may not have reacted to the new value yet. browser_wait for what you expect to appear.',
  hover: 'nothing opened on hover. Try browser_click on the element instead.',
}

/**
 * One line describing the effect. Leads with what a person would notice
 * (dialog opened, announcement, failed request), then the census delta;
 * when nothing at all changed, says so with the time window, because a late
 * effect is the other explanation.
 */
export function formatActionEffect(effect: ActionEffect | null, opts: EffectFormatOptions): string {
  if (!effect) return ''
  const parts: string[] = []
  for (const e of effect.opened) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} opened`)
  for (const e of effect.closed) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} closed`)
  if (effect.announced.length > 0) parts.push(`announced: ${effect.announced.map(s => JSON.stringify(s)).join(' | ')}`)
  for (const f of effect.failed.slice(0, 3)) {
    parts.push(`failed request: ${f.initiator ? `${f.initiator} ` : ''}${f.url} → ${f.status}`)
  }
  if (effect.interactiveDelta !== 0) {
    parts.push(`${effect.interactiveDelta > 0 ? '+' : ''}${effect.interactiveDelta} interactive elements`)
  } else if (parts.length === 0 && effect.textChanged) {
    const d = effect.textDelta
    const size = d === 0 ? 'same length, different content' : `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} chars`
    parts.push(`page text changed (${size})`)
  }
  const focusNote = opts.verb === 'press' && effect.focus ? `focus: ${effect.focus}` : ''
  if (parts.length === 0 && !(opts.verb === 'press' && effect.focusChanged)) {
    return `\nEffect: no DOM change within ${opts.settleMs}ms — ${NO_CHANGE_HINT[opts.verb]}${focusNote ? ` (${focusNote})` : ''}`
  }
  if (focusNote) parts.push(focusNote)
  return `\nEffect: ${parts.join(' · ')}`
}

/** Settle before the "after" read on hover (menus animate open). */
export const HOVER_SETTLE_MS = 300

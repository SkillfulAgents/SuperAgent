/**
 * Page observer — the one page-side read every browser result is built from.
 *
 * One eval, one `PageObservation`: identity and readiness (URL, title, HTTP
 * status, readyState, content type, challenge wall, net error), the page's
 * text (length, opening words, and a hash of the content region), live
 * regions, cross-origin iframes, the visible interactive census and the
 * state of those controls, open dialogs, and the focused element with its
 * value.
 *
 * page-status.ts projects it into the status line that opens every snapshot
 * and open result; a before-versus-after diff of two observations is what an
 * action result can report (the interactive census, control state, content
 * hash, dialogs and focus are here for that).
 *
 * Everything here is an observation, never a verdict: the consumers state
 * what was seen (or that nothing was), and give advice only where the
 * observation leaves no doubt — a hint the agent could not have reached on
 * its own is a shortcut; a wrong one turns a recoverable run into a failed
 * one. Every part of the script is wrapped in its own try so a hostile page
 * cannot blank the others, and the script reads the page without touching
 * it: no globals, no wrapped APIs, no state left behind.
 */
import { z } from 'zod'

// --- Schema (the boundary between page JS, the server and the tools) --------

const topLayerEntrySchema = z.object({ kind: z.string().default('dialog'), name: z.string().default('') })
const iframeInfoSchema = z.object({ title: z.string().default(''), host: z.string().default(''), sameOrigin: z.boolean().default(false) })

export const pageObservationSchema = z.object({
  /** location.href — '' when the read could not run (dead browser, no page). */
  url: z.string().default(''),
  title: z.string().default(''),
  /** loading | interactive | complete */
  readyState: z.string().default(''),
  /** Navigation response status (Chrome 109+); 0 when unknown (cache, file:, old Chrome). */
  httpStatus: z.number().default(0),
  contentType: z.string().default(''),
  /** Visible text length of the whole page (body.innerText, whitespace-collapsed) — the footer's "text dropped" count. */
  textChars: z.number().default(0),
  /**
   * Length and hash of the content region's text: <main> (or role=main) when
   * the page has one, else body. Diffs use this rather than the whole body so a
   * header clock or footer ticker does not read as "the page changed".
   */
  contentChars: z.number().default(0),
  contentHash: z.number().default(0),
  /** Opening words of <main> (or body). */
  preview: z.string().default(''),
  /** Visible role=alert/status, aria-live (not off), <output> texts. */
  liveRegions: z.array(z.string()).default([]),
  iframes: z.array(iframeInfoSchema).default([]),
  /** Visible interactive elements (DOM census, not refs — no snapshot involved). */
  interactive: z.number().default(0),
  /**
   * Hash of the visible controls' state — checked, aria-checked/pressed/
   * expanded/selected, disabled, a select's chosen option — so a click that only
   * ticks a box or toggles a button is an observed change, not silence.
   */
  stateHash: z.number().default(0),
  /** Visible dialogs, alertdialogs, aria-modal containers and open popovers, with accessible names. */
  top: z.array(topLayerEntrySchema).default([]),
  /** Focused element as `role "name"`, or "nothing focused". */
  focus: z.string().default(''),
  /** Value of the focused field, capped — typing changes this, not the page text. '' for password and other secret fields. */
  focusValue: z.string().default(''),
  /** Bot-challenge vendor when the page is a challenge wall, or ''. */
  blocker: z.string().default(''),
  /** Chrome net-error code when the document is Chrome's error page, or ''. */
  netError: z.string().default(''),
})

export type PageObservation = z.infer<typeof pageObservationSchema>
export type TopLayerEntry = z.infer<typeof topLayerEntrySchema>
export type IframeInfo = z.infer<typeof iframeInfoSchema>

export const EMPTY_OBSERVATION: PageObservation = pageObservationSchema.parse({})

/** Parse observer output (the CLI double-JSON-encodes) or a forwarded observation. Never throws. */
export function parseObservation(stdout: string): PageObservation | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    const r = pageObservationSchema.safeParse(parsed)
    return r.success ? r.data : null
  } catch {
    return null
  }
}

// --- Tunables ------------------------------------------------------------------

export const PREVIEW_CHARS = 240
/** Preview length when the caller knows the tree is nearly empty — the text is all the agent has. */
export const THIN_TREE_PREVIEW_CHARS = 1500
const LIVE_REGION_MAX = 8
const LIVE_REGION_CHARS = 300
const TEXT_HASH_CAP = 100_000

const LIVE_SELECTOR = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output'
const INTERACTIVE_SELECTOR =
  'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],' +
  '[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],' +
  '[role="combobox"],[role="textbox"],[role="switch"],[role="slider"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
const TOP_LAYER_SELECTOR = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'
/** Attributes whose values feed `stateHash` — visible controls only. */
const STATE_ATTRS = ['checked', 'aria-checked', 'aria-pressed', 'aria-expanded', 'aria-selected', 'aria-disabled', 'disabled', 'open']
/** A focused field whose value must never be reported. */
const SECRET_AUTOCOMPLETE = 'current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp'

/**
 * Bot-challenge signatures: the wording of the challenge page itself, matched
 * case-insensitively against title + the first 3k chars of body text (and the
 * URL for Google's /sorry/). Product names are deliberately absent — "This
 * site is protected by reCAPTCHA" is printed on ordinary login forms, and a
 * page can mention Imperva or DataDome in prose. A match only counts on a
 * page with at most BLOCKER_MAX_CONTROLS visible controls or a 403/429/503
 * response: a challenge page is a wall, not a form.
 */
const BLOCKER_SIGNATURES: Array<[string, string]> = [
  ['Cloudflare', 'checking your browser before accessing|verify you are human|confirm you are human|cloudflare ray id|attention required.{0,40}cloudflare|cf-browser-verification|performing security verification'],
  ['Imperva/Incapsula', 'request unsuccessful\\. incapsula incident id|incapsula incident id'],
  ['Akamai', 'access denied.{0,160}permission to access.{0,200}reference #\\d+\\.[0-9a-f]+\\.\\d+'],
  ['Google', 'google\\.[a-z.]+/sorry/|unusual traffic from your computer network'],
  ['PerimeterX', 'press (&|and) hold to confirm you are a human|press (&|and) hold the button'],
  ['CAPTCHA', 'complete the security check to access|please verify you are a human|prove you are human|are you a robot'],
]
/** A challenge page has (almost) nothing to interact with; more than this and the match is prose on a real page. */
const BLOCKER_MAX_CONTROLS = 3
const BLOCKER_STATUSES = [403, 429, 503]

export interface ObserverOptions {
  previewChars?: number
}

/**
 * Build the observer eval: one IIFE returning JSON, reading the page and
 * changing nothing in it.
 */
export function observerScript(opts: ObserverOptions = {}): string {
  const previewChars = opts.previewChars ?? PREVIEW_CHARS
  const sigs = JSON.stringify(BLOCKER_SIGNATURES)
  return (
    '(function(){' +
    'var o={url:"",title:"",readyState:"",httpStatus:0,contentType:"",textChars:0,contentChars:0,contentHash:0,preview:"",liveRegions:[],iframes:[],interactive:0,stateHash:0,top:[],focus:"",focusValue:"",blocker:"",netError:""};' +
    'var ws=function(s){return String(s||"").replace(/\\s+/g," ").trim()};var body="";' +
    'var hash=function(s){var h=5381;var lim=Math.min(s.length,' + TEXT_HASH_CAP + ');for(var q=0;q<lim;q++){h=((h<<5)+h+s.charCodeAt(q))|0}return h};' +
    // checkVisibility covers visibility:hidden / opacity:0 — how many dropdowns hide
    // their closed state (Wikipedia's Vector menu keeps layout boxes for hidden
    // links, so getClientRects alone counted them). Both option spellings: Chrome
    // renamed them in 2024.
    'var vis=function(el){try{if(!el||el.nodeType!==1)return false;if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,opacityProperty:true,checkVisibilityCSS:true,checkOpacity:true});return el.getClientRects().length>0}catch(e){return false}};' +
    // Identity and readiness.
    'try{o.url=String(location.href||"")}catch(e){}' +
    'try{o.title=ws(document.title).slice(0,200);o.readyState=String(document.readyState||"");o.contentType=String(document.contentType||"")}catch(e){}' +
    'try{var nav=performance.getEntriesByType("navigation")[0];o.httpStatus=(nav&&nav.responseStatus)|0}catch(e){}' +
    // Text: the whole page for the footer's count; the content region for diffs and the preview.
    'try{body=ws(document.body&&document.body.innerText);o.textChars=body.length}catch(e){}' +
    'try{var m=document.querySelector("main,[role=main]");var ct=m?ws(m.innerText):body;o.contentChars=ct.length;o.contentHash=hash(ct);o.preview=ct.slice(0,' + previewChars + ')}catch(e){}' +
    // Live regions.
    'try{var seenL={};var ls=document.querySelectorAll(' + JSON.stringify(LIVE_SELECTOR) + ');' +
    'for(var i=0;i<ls.length&&o.liveRegions.length<' + LIVE_REGION_MAX + ';i++){if(!vis(ls[i]))continue;var s=ws(ls[i].innerText);if(!s||seenL[s])continue;seenL[s]=1;o.liveRegions.push(s.slice(0,' + LIVE_REGION_CHARS + '))}}catch(e){}' +
    // Iframes (offsetParent is fine here: frames are never position:fixed toasts).
    'try{o.iframes=[].slice.call(document.querySelectorAll("iframe")).filter(function(f){return f.offsetParent!==null})' +
    '.map(function(f){var host="";try{host=new URL(f.src).host}catch(e){}var same=false;try{same=!!f.contentDocument}catch(e){}return{title:f.title||"",host:host,sameOrigin:same}})}catch(e){}' +
    // Interactive census, and the state of every visible control.
    'try{var els=document.querySelectorAll(' + JSON.stringify(INTERACTIVE_SELECTOR) + ');var sa=' + JSON.stringify(STATE_ATTRS) + ';var st="";' +
    'for(var j=0;j<els.length;j++){var ce=els[j];if(!vis(ce))continue;o.interactive++;' +
    'for(var j2=0;j2<sa.length;j2++){var av=ce.getAttribute(sa[j2]);if(av!==null)st+=sa[j2]+"="+av+";"}' +
    'if(typeof ce.checked==="boolean")st+="c="+(ce.checked?1:0)+";";if(typeof ce.selectedIndex==="number")st+="s="+ce.selectedIndex+";";st+="|"}' +
    'o.stateHash=hash(st)}catch(e){}' +
    // Top layer.
    'try{var name=function(el){var n=el.getAttribute("aria-label")||"";' +
    'if(!n){var lb=el.getAttribute("aria-labelledby");if(lb){var le=document.getElementById(lb.split(" ")[0]);if(le)n=le.innerText}}' +
    'if(!n){var h=el.querySelector("h1,h2,h3,h4,[role=heading]");if(h)n=h.innerText}' +
    'if(!n)n=el.innerText;return ws(n).slice(0,80)};' +
    'var tops=[].slice.call(document.querySelectorAll(' + JSON.stringify(TOP_LAYER_SELECTOR) + '));' +
    'try{tops=tops.concat([].slice.call(document.querySelectorAll(":popover-open")))}catch(e){}' +
    'var seenT={};for(var k=0;k<tops.length&&o.top.length<6;k++){var el=tops[k];if(!vis(el))continue;' +
    'var kind=el.getAttribute("role")||(el.tagName==="DIALOG"?"dialog":el.matches(":popover-open")?"popover":"dialog");' +
    'var key=kind+"|"+name(el);if(seenT[key])continue;seenT[key]=1;o.top.push({kind:kind,name:name(el)})}}catch(e){}' +
    // Focus.
    'try{var a=document.activeElement;if(!a||a===document.body){o.focus="nothing focused"}else{' +
    'var tag=a.tagName.toLowerCase();var role=a.getAttribute("role");var an=a.getAttribute("aria-label")||(a.labels&&a.labels[0]&&a.labels[0].innerText)||a.getAttribute("placeholder")||a.getAttribute("name")||a.innerText||"";' +
    'var implied={a:"link",input:a.type==="checkbox"||a.type==="radio"||a.type==="submit"||a.type==="button"?a.type:"textbox",select:"combobox",textarea:"textbox"};' +
    'o.focus=(role||implied[tag]||tag)+(an?" "+JSON.stringify(ws(an).slice(0,60)):"");' +
    // Never the value of a secret field: the app autofills passwords the model must not see.
    'var secret=String(a.type||"").toLowerCase()==="password"||/^(' + SECRET_AUTOCOMPLETE + ')$/i.test(String(a.getAttribute("autocomplete")||""));' +
    'var fv=secret?"":typeof a.value==="string"?a.value:(a.isContentEditable?a.innerText:"");o.focusValue=ws(fv).slice(0,120)}}catch(e){}' +
    // Chrome's error document: full Chrome renders #main-frame-error with the ERR_
    // code in its text; the headless shell shows an empty page whose only tell is
    // the chrome-error:// URL (verified in the container image).
    'try{if(document.getElementById("main-frame-error")||/^chrome-error:/.test(o.url)){var em=/\\bERR_[A-Z_]{3,}\\b/.exec(body);o.netError=em?em[0]:"net error"}}catch(e){}' +
    'try{if(o.interactive<=' + BLOCKER_MAX_CONTROLS + '||' + JSON.stringify(BLOCKER_STATUSES) + '.indexOf(o.httpStatus)>=0){var hay=(o.title+" "+body.slice(0,3000)).toLowerCase();var sg=' + sigs + ';' +
    'for(var g=0;g<sg.length&&!o.blocker;g++){if(new RegExp(sg[g][1],"i").test(sg[g][0]==="Google"?o.url+" "+hay:hay))o.blocker=sg[g][0]}}}catch(e){}' +
    'return JSON.stringify(o)})()'
  )
}

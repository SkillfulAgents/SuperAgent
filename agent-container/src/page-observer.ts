/**
 * Page observer — the one page-side read every browser result is built from.
 *
 * One eval, one `PageObservation`: identity and readiness (URL, title, HTTP
 * status, readyState, content type, bot wall, net error), the page's text
 * (length, hash, opening words), live regions, cross-origin iframes, the
 * visible interactive census, open dialogs, the focused element and its
 * value, requests in flight and requests that failed, and the busy signals a
 * person would read as "the page is still working" (spinners, top bars,
 * skeletons, indeterminate progress bars, aria-busy, wait cursors).
 *
 * Two consumers project it: page-status.ts renders the status line that
 * opens every snapshot and open result; action-settle.ts diffs a before and
 * an after observation into the effect line that closes every action result.
 * A fact learned for one is available to the other for free.
 *
 * Instrumentation is installed once per document on the first read: a
 * transparent counter around fetch and XMLHttpRequest (in-flight and
 * completed, with status), and a baseline of the animations already running,
 * so "new since the action" is a diff and never a guess. Every part is
 * wrapped in its own try so a hostile page cannot blank the others.
 */
import { z } from 'zod'

// --- Schema (the boundary between page JS, the server and the tools) --------

const topLayerEntrySchema = z.object({ kind: z.string().default('dialog'), name: z.string().default('') })
const failedRequestSchema = z.object({ url: z.string().default(''), status: z.number().default(0), initiator: z.string().default('') })
const busyIndicatorSchema = z.object({
  /** progressbar | aria-busy | status | cursor | spinner | top-bar | skeleton | animation */
  kind: z.string(),
  name: z.string().default(''),
  count: z.number().default(1),
})
const iframeInfoSchema = z.object({ title: z.string().default(''), host: z.string().default(''), sameOrigin: z.boolean().default(false) })

export const pageObservationSchema = z.object({
  /** performance.now() at capture; the "after" read filters by it. */
  t: z.number().default(0),
  /** location.href — '' when the read could not run (dead browser, no page). */
  url: z.string().default(''),
  title: z.string().default(''),
  /** loading | interactive | complete */
  readyState: z.string().default(''),
  /** Navigation response status (Chrome 109+); 0 when unknown (cache, file:, old Chrome). */
  httpStatus: z.number().default(0),
  contentType: z.string().default(''),
  /** Visible text length (body.innerText, whitespace-collapsed) and a hash of it. */
  textChars: z.number().default(0),
  textHash: z.number().default(0),
  /** Opening words of <main> (or body). */
  preview: z.string().default(''),
  /** Visible role=alert/status, aria-live (not off), <output> texts. */
  liveRegions: z.array(z.string()).default([]),
  iframes: z.array(iframeInfoSchema).default([]),
  /** Visible interactive elements (DOM census, not refs — no snapshot involved). */
  interactive: z.number().default(0),
  /** Visible dialogs, alertdialogs, aria-modal containers and open popovers, with accessible names. */
  top: z.array(topLayerEntrySchema).default([]),
  /** Focused element as `role "name"`, or "nothing focused". */
  focus: z.string().default(''),
  /** Value of the focused field, capped — typing changes this, not the page text. */
  focusValue: z.string().default(''),
  /** Requests (fetch/XHR/resources) since `since` — or the last 5s — that failed. */
  failed: z.array(failedRequestSchema).default([]),
  /** fetch/XHR requests started since `since` (or the last 5s) that have not completed. */
  pending: z.number().default(0),
  /** Busy signals; for a read with `since`, animation kinds are only those that started after it. */
  busy: z.array(busyIndicatorSchema).default([]),
  /** Bot-challenge vendor from title/body signatures, or ''. */
  blocker: z.string().default(''),
  /** Chrome net-error code when the document is Chrome's error page, or ''. */
  netError: z.string().default(''),
})

export type PageObservation = z.infer<typeof pageObservationSchema>
export type TopLayerEntry = z.infer<typeof topLayerEntrySchema>
export type FailedRequest = z.infer<typeof failedRequestSchema>
export type BusyIndicator = z.infer<typeof busyIndicatorSchema>
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
/** Without a `since`, requests and animations younger than this count as busy (status line). */
export const RECENT_MS = 3000
const LIVE_REGION_MAX = 8
const LIVE_REGION_CHARS = 300
const TEXT_HASH_CAP = 100_000
const MAX_FAILED = 5
const MAX_BUSY = 6

const LIVE_SELECTOR = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output'
const INTERACTIVE_SELECTOR =
  'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],' +
  '[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],' +
  '[role="combobox"],[role="textbox"],[role="switch"],[role="slider"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
const TOP_LAYER_SELECTOR = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'
const LOADING_TEXT = 'loading|please wait|fetching|saving|processing|one moment'

/**
 * Bot-challenge signatures, matched case-insensitively against title + the
 * first 3k chars of body text (and the URL for Google's /sorry/). Kept to
 * vendor-specific phrases: a generic "access denied" is often the app's own
 * auth wall, which the HTTP status and the text already convey.
 */
const BLOCKER_SIGNATURES: Array<[string, string]> = [
  ['Cloudflare', 'just a moment|checking your browser|verify you are human|cloudflare ray id|attention required.{0,40}cloudflare|cf-browser-verification'],
  ['Imperva/Incapsula', 'incapsula|imperva|incident id|request unsuccessful\\.'],
  ['Akamai', 'reference #\\d+\\.[0-9a-f]+\\.\\d+|access denied.{0,120}permission to access'],
  ['Google', '/sorry/|unusual traffic from your computer network'],
  ['PerimeterX', 'press (&|and) hold|px-captcha|perimeterx'],
  ['DataDome', 'datadome'],
  ['CAPTCHA', 'hcaptcha|recaptcha|arkose|funcaptcha'],
]

export interface ObserverOptions {
  /** performance.now() of the "before" read: requests/animations count only from then. */
  since?: number
  previewChars?: number
  /** Record the currently running animations as the baseline the next read diffs against. */
  baseline?: boolean
}

/**
 * Build the observer eval. The script is one IIFE returning JSON; `since`
 * scopes the network and animation parts to "after the action", `baseline`
 * stores the animation set on the page for the next read.
 */
export function observerScript(opts: ObserverOptions = {}): string {
  const since = typeof opts.since === 'number' && Number.isFinite(opts.since) ? String(opts.since) : 'null'
  const previewChars = opts.previewChars ?? PREVIEW_CHARS
  const baseline = opts.baseline ? 'true' : 'false'
  const sigs = JSON.stringify(BLOCKER_SIGNATURES)
  return (
    '(function(){' +
    'var W=window,O=W.__gamutObs;' +
    // Install-once instrumentation: transparent counters around fetch and XHR.
    'if(!O){O=W.__gamutObs={inflight:new Map(),done:[],seq:0,baseAnim:[]};' +
    'try{var of=W.fetch;if(typeof of==="function"){W.fetch=function(input,init){var id=++O.seq;var url="";try{url=typeof input==="string"?input:(input&&input.url)||""}catch(e){}' +
    'var m=(init&&init.method)||(input&&input.method)||"GET";O.inflight.set(id,{start:performance.now(),url:String(url),method:String(m),kind:"fetch"});' +
    'var p=of.apply(this,arguments);Promise.resolve(p).then(function(r){var e=O.inflight.get(id);O.inflight.delete(id);if(e){e.end=performance.now();e.status=(r&&r.status)|0;O.done.push(e)}},' +
    'function(){var e=O.inflight.get(id);O.inflight.delete(id);if(e){e.end=performance.now();e.status=0;e.error=true;O.done.push(e)}});return p}}}catch(e){}' +
    'try{var XP=XMLHttpRequest.prototype,oo=XP.open,os=XP.send;XP.open=function(m,u){this.__gm=String(m);this.__gu=String(u);return oo.apply(this,arguments)};' +
    'XP.send=function(){var x=this,id=++O.seq;O.inflight.set(id,{start:performance.now(),url:x.__gu||"",method:x.__gm||"GET",kind:"xhr"});' +
    'x.addEventListener("loadend",function(){var e=O.inflight.get(id);O.inflight.delete(id);if(e){e.end=performance.now();e.status=x.status|0;e.error=x.status===0;O.done.push(e)}});return os.apply(this,arguments)}}catch(e){}' +
    'try{performance.setResourceTimingBufferSize(2000)}catch(e){}}' +
    'if(O.done.length>500)O.done.splice(0,O.done.length-500);' +
    'var now=performance.now();var since=' + since + ';var cut=since===null?now-' + RECENT_MS + ':since;' +
    'var o={t:now,url:"",title:"",readyState:"",httpStatus:0,contentType:"",textChars:0,textHash:0,preview:"",liveRegions:[],iframes:[],interactive:0,top:[],focus:"",focusValue:"",failed:[],pending:0,busy:[],blocker:"",netError:""};' +
    'var ws=function(s){return String(s||"").replace(/\\s+/g," ").trim()};var body="";' +
    // checkVisibility covers visibility:hidden / opacity:0 — how many dropdowns hide
    // their closed state (Wikipedia's Vector menu keeps layout boxes for hidden
    // links, so getClientRects alone counted them). Both option spellings: Chrome
    // renamed them in 2024.
    'var vis=function(el){try{if(!el||el.nodeType!==1)return false;if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,opacityProperty:true,checkVisibilityCSS:true,checkOpacity:true});return el.getClientRects().length>0}catch(e){return false}};' +
    'var shortUrl=function(u){try{var p=new URL(u,location.href);return ((p.host===location.host?"":p.host)+p.pathname).slice(0,120)}catch(e){return String(u).slice(0,120)}};' +
    // Identity and readiness.
    'try{o.url=String(location.href||"")}catch(e){}' +
    'try{o.title=ws(document.title).slice(0,200);o.readyState=String(document.readyState||"");o.contentType=String(document.contentType||"")}catch(e){}' +
    'var loadEnd=0;try{var nav=performance.getEntriesByType("navigation")[0];o.httpStatus=(nav&&nav.responseStatus)|0;loadEnd=(nav&&(nav.loadEventEnd||nav.domContentLoadedEventEnd))||0}catch(e){}' +
    // Text.
    'try{body=ws(document.body&&document.body.innerText);o.textChars=body.length;var hsh=5381;var lim=Math.min(body.length,' + TEXT_HASH_CAP + ');' +
    'for(var q=0;q<lim;q++){hsh=((hsh<<5)+hsh+body.charCodeAt(q))|0}o.textHash=hsh}catch(e){}' +
    'try{var m=document.querySelector("main,[role=main]")||document.body;o.preview=ws(m&&m.innerText).slice(0,' + previewChars + ')}catch(e){}' +
    // Live regions.
    'try{var seenL={};var ls=document.querySelectorAll(' + JSON.stringify(LIVE_SELECTOR) + ');' +
    'for(var i=0;i<ls.length&&o.liveRegions.length<' + LIVE_REGION_MAX + ';i++){if(!vis(ls[i]))continue;var s=ws(ls[i].innerText);if(!s||seenL[s])continue;seenL[s]=1;o.liveRegions.push(s.slice(0,' + LIVE_REGION_CHARS + '))}}catch(e){}' +
    // Iframes (offsetParent is fine here: frames are never position:fixed toasts).
    'try{o.iframes=[].slice.call(document.querySelectorAll("iframe")).filter(function(f){return f.offsetParent!==null})' +
    '.map(function(f){var host="";try{host=new URL(f.src).host}catch(e){}var same=false;try{same=!!f.contentDocument}catch(e){}return{title:f.title||"",host:host,sameOrigin:same}})}catch(e){}' +
    // Interactive census.
    'try{var els=document.querySelectorAll(' + JSON.stringify(INTERACTIVE_SELECTOR) + ');for(var j=0;j<els.length;j++){if(vis(els[j]))o.interactive++}}catch(e){}' +
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
    'var fv=typeof a.value==="string"?a.value:(a.isContentEditable?a.innerText:"");o.focusValue=ws(fv).slice(0,120)}}catch(e){}' +
    // Network: in flight and failed since the cut, from the counters plus resource timing.
    'try{var seenF={};var addF=function(u,st,kind){if(o.failed.length>=' + MAX_FAILED + ')return;var su=shortUrl(u);var fk=su+"|"+st;if(seenF[fk])return;seenF[fk]=1;o.failed.push({url:su,status:st,initiator:kind})};' +
    'O.inflight.forEach(function(e){if(e.start>=cut)o.pending++});' +
    'for(var d=0;d<O.done.length;d++){var de=O.done[d];if(de.start>=cut&&(de.error||de.status>=400))addF(de.url,de.status|0,de.kind)}' +
    'var rs=performance.getEntriesByType("resource");for(var r=0;r<rs.length;r++){var re=rs[r];if(re.startTime>=cut&&re.responseStatus>=400)addF(re.name,re.responseStatus,String(re.initiatorType||""))}}catch(e){}' +
    // Busy: semantic indicators first.
    'try{var addB=function(kind,nm,count){if(o.busy.length>=' + MAX_BUSY + ')return;o.busy.push({kind:kind,name:ws(nm||"").slice(0,60),count:count||1})};' +
    'var pbs=document.querySelectorAll(\'[role="progressbar"]:not([aria-valuenow]),progress:not([value])\');for(var b1=0;b1<pbs.length;b1++){if(vis(pbs[b1]))addB("progressbar",pbs[b1].getAttribute("aria-label")||"")}' +
    'var abs=document.querySelectorAll(\'[aria-busy="true"]\');var nab=0;for(var b2=0;b2<abs.length;b2++){if(vis(abs[b2]))nab++}if(nab)addB("aria-busy","",nab);' +
    'for(var b3=0;b3<o.liveRegions.length;b3++){if(/\\b(' + LOADING_TEXT + ')\\b/i.test(o.liveRegions[b3])){addB("status",o.liveRegions[b3]);break}}' +
    'var cur=getComputedStyle(document.body).cursor;if(cur==="wait"||cur==="progress")addB("cursor",cur)}catch(e){}' +
    // Busy: animations that started after the cut (or whose target was hidden at the baseline).
    'try{if(typeof document.getAnimations==="function"){var anims=document.getAnimations();var base=O.baseAnim||[];var nextBase=[];var skel=0;var spin=0,bars=0,other=0;' +
    'for(var a1=0;a1<anims.length;a1++){var an1=anims[a1];var ef=an1.effect;var tg=ef&&ef.target;if(!tg||an1.playState!=="running")continue;' +
    'var tm=ef.getTiming?ef.getTiming():null;if(!tm||tm.iterations!==Infinity)continue;if(!vis(tg))continue;nextBase.push(tg);' +
    // Without `since` (status line): young, and not part of the page as it loaded —
    // a decorative always-on animation started at load time is not a spinner.
    // With `since`: started after the action, or hidden at the baseline and visible now.
    'var age=an1.currentTime;var fresh=since===null?(age!==null&&age<=' + RECENT_MS + '&&(loadEnd===0||now-age>loadEnd+500)):((age!==null&&age<=now-since+50)||base.indexOf(tg)<0);if(!fresh)continue;' +
    'var rc=tg.getBoundingClientRect();var pb=tg.closest?tg.closest(\'[role="progressbar"]\'):null;' +
    'if(pb){continue}' +  // already reported as progressbar
    // A thin strip pinned to the top is a progress bar whatever its current width
    // (they animate width from 0); small and roughly square is a spinner; several
    // wide blocks are a skeleton.
    'if(rc.height<=8&&rc.top<=40)bars++;else if(rc.width<=80&&rc.height<=80)spin++;else if(rc.width>80)skel++;else other++}' +
    'if(bars)addB("top-bar","",bars);if(spin)addB("spinner","",spin);if(skel>=3)addB("skeleton","",skel);else if(skel)addB("animation","",skel);if(other)addB("animation","",other);' +
    'if(' + baseline + ')O.baseAnim=nextBase}}catch(e){}' +
    // Chrome's error document: full Chrome renders #main-frame-error with the ERR_
    // code in its text; the headless shell shows an empty page whose only tell is
    // the chrome-error:// URL (verified in the container image).
    'try{if(document.getElementById("main-frame-error")||/^chrome-error:/.test(o.url)){var em=/\\bERR_[A-Z_]{3,}\\b/.exec(body);o.netError=em?em[0]:"net error"}}catch(e){}' +
    'try{var hay=(o.title+" "+body.slice(0,3000)).toLowerCase();var sg=' + sigs + ';' +
    'for(var g=0;g<sg.length&&!o.blocker;g++){if(new RegExp(sg[g][1],"i").test(sg[g][0]==="Google"?hay+" "+o.url:hay))o.blocker=sg[g][0]}}catch(e){}' +
    'return JSON.stringify(o)})()'
  )
}

/** A stable key for a busy indicator, for before/after diffs. */
export const busyKey = (b: BusyIndicator): string => `${b.kind}|${b.name}`

/** Busy indicators of the kinds a wait should honour: transient by nature, never a permanent widget. */
export function transientBusy(obs: PageObservation): BusyIndicator[] {
  return obs.busy.filter(b => b.kind !== 'progressbar' && b.kind !== 'aria-busy')
}

/** Render busy indicators and pending requests as a short phrase: `spinner, top bar, 2 requests in flight`. */
export function describeBusy(busy: BusyIndicator[], pending: number): string {
  const parts = busy.map(b => {
    const label = b.kind === 'top-bar' ? 'top bar' : b.kind === 'aria-busy' ? 'aria-busy region' : b.kind === 'status' ? `status ${JSON.stringify(b.name)}` : b.kind === 'cursor' ? `${b.name} cursor` : b.kind
    return b.count > 1 ? `${b.count} ${label}s` : label
  })
  if (pending > 0) parts.push(`${pending} request${pending === 1 ? '' : 's'} in flight`)
  return parts.join(', ')
}

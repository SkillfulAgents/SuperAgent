/**
 * Page reader — the visible text of the current page as light markdown, for
 * browser_read.
 *
 * Reading used to mean `browser_snapshot(fullText)`: the accessibility tree
 * with its static text, refs and roles on every line. On an article that is
 * the wrong shape and the wrong size (Wikipedia's WWII page: 642 KB, ~1 s).
 * This is the text alone, with headings, list items and table rows marked so
 * a long document can be paged by section.
 *
 * agent-browser 0.30+ ships a `read` command, but it converts the document's
 * HTML, so text the page hides with CSS — a closed dialog, a collapsed menu,
 * the out-of-stock badge of another variant — reads like text on screen
 * (verified on 0.39.1: a closed <dialog>'s contents came out in the middle of
 * the page). This walk skips what is not rendered, using the browser's own
 * innerText for every block that has no structure of its own, so what comes
 * back is what a person could read on the page.
 *
 * The script reads the page without touching it, like the page observer.
 */

/** Stop walking once this much text is collected; the tool shows far less. */
const READ_COLLECT_LIMIT = 400_000

export interface ReadFrame {
  /** The frame's accessible name: aria-label, else title. */
  name: string
  host: string
  /** Share of the viewport the frame covers, 0–1 — an overlay covering the page is the one that matters. */
  cover: number
}

export interface ReadResult {
  text: string
  /** The walk stopped at READ_COLLECT_LIMIT. */
  truncated: boolean
  /** Visible iframes: the walk does not enter them, so their text is not in `text`. */
  frames: ReadFrame[]
}

/** Build the reader eval: one IIFE returning JSON `{text, truncated}`. */
export function readerScript(): string {
  return (
    '(function(){' +
    'var out=[];var n=0;var full=false;' +
    'var push=function(s){if(full)return;out.push(s);n+=s.length;if(n>' + READ_COLLECT_LIMIT + ')full=true};' +
    // Zero-width spaces are layout glue, not text (Meta's ad cards: 180 lines
    // of only U+200B). The joiner U+200D stays: it holds emoji together.
    'var zw=/[\\u200b\\u200c\\u2060\\ufeff]/g;' +
    'var ws=function(s){return String(s||"").replace(zw,"").replace(/\\s+/g," ").trim()};' +
    'var vis=function(el){try{if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,opacityProperty:true,checkVisibilityCSS:true,checkOpacity:true});return el.getClientRects().length>0}catch(e){return false}};' +
    // Block text as the browser lays it out: one line per line break, blank runs collapsed.
    'var blockText=function(el){return String(el.innerText||"").replace(zw,"").split("\\n").map(function(l){return l.replace(/[ \\t\\u00a0]+/g," ").trim()}).filter(function(l){return l}).join("\\n")};' +
    'var SKIP=/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|CANVAS|IFRAME|OBJECT|EMBED|HEAD|OPTION|DATALIST)$/;' +
    'var BLOCK=/^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|HR|MAIN|NAV|OL|P|SECTION|TABLE|THEAD|TBODY|TFOOT|UL|SUMMARY|CAPTION|LEGEND)$/;' +
    'var STRUCT="h1,h2,h3,h4,h5,h6,[role=heading],li,tr,pre";' +
    // Where the browser's innerText says the wrong thing, the walk goes in
    // instead (bench reviews): a <select> lists every option and not which is
    // chosen; screen-reader-only text gets a line of its own ("Delinquent"
    // beside "Date"); an icon's name is missing ("35,878" with no "star").
    'var SRONLY=".sr-only,.visually-hidden,.visuallyhidden,.screen-reader-text,.screenreader-only,.a-offscreen,.u-visually-hidden";' +
    // Also walked: live regions (often screen-reader-only status text such as
    // "No results returned." above 30 results), form controls (checked state,
    // typed values) and <time> (its machine date).
    'var SPECIAL="select,input,textarea,time[datetime],[aria-live],[role=status],[role=alert],svg[aria-label],[role=img][aria-label],img[alt],"+SRONLY;' +
    'var plain=function(el){return !cardAnc.has(el)&&!el.querySelector(STRUCT)&&!el.querySelector(SPECIAL)};' +
    // Cards: three or more sibling boxes of one tag and class (a results grid)
    // whose first holds more than one line. Their text runs together once
    // walked, so a line `---` goes between two neighbouring ones — which price
    // belongs to which product.
    // Found once up front: a container of cards is walked even when it has no
    // other structure (its innerText would run the cards together), and so is
    // every box that holds one.
    'var sig=function(c){var t=String(c.tagName).toUpperCase();var cl=c.getAttribute("class")||"";return /^(DIV|ARTICLE|SECTION|A)$/.test(t)&&(cl||t==="ARTICLE")?t+"."+cl:""};' +
    'var multi=function(c){return String(c.innerText||"").trim().indexOf("\\n")>=0};' +
    'var cardSigs=new Map();var cardAnc=new Set();' +
    'try{var groups=new Map();[].slice.call(document.body.querySelectorAll("div[class],article,section[class],a[class]")).forEach(function(c){var p=c.parentElement;var g=sig(c);if(!p||!g)return;var m=groups.get(p);if(!m){m={};groups.set(p,m)}(m[g]=m[g]||[]).push(c)});' +
    'groups.forEach(function(m,p){var ok={};var any=false;for(var g in m){if(m[g].length>=3&&multi(m[g][0])){ok[g]=1;any=true}}if(!any)return;cardSigs.set(p,ok);for(var a=p;a&&!cardAnc.has(a);a=a.parentElement)cardAnc.add(a)})}catch(e){}' +
    'var srOnly=function(el){try{if(el.matches(SRONLY))return true;var r=el.getBoundingClientRect();if(r.width<=1&&r.height<=1){var po=getComputedStyle(el).position;return po==="absolute"||po==="fixed"}}catch(e){}return false};' +
    'var walk=function(node,depth){if(full)return;' +
    'if(node.nodeType===3){var t=String(node.nodeValue||"").replace(zw,"").replace(/\\s+/g," ");if(t.trim())push(t);else if(t)push(" ");return}' +
    'if(node.nodeType!==1)return;var el=node;var tag=String(el.tagName||"").toUpperCase();if(SKIP.test(tag))return;' +
    // display:contents has no box of its own but its children render.
    'if(!vis(el)){var dc=false;try{dc=getComputedStyle(el).display==="contents"}catch(e){}if(!dc)return}' +
    // An icon is its name; a large image's alt is left out (a product photo repeats the product name).
    'var role=el.getAttribute?el.getAttribute("role"):null;' +
    'if(tag==="SVG"||tag==="IMG"||role==="img"){var il=tag==="IMG"?el.getAttribute("alt"):el.getAttribute("aria-label");var small=true;try{small=el.getBoundingClientRect().width<=48}catch(e){}if(il&&(tag!=="IMG"||small))push(" "+ws(il)+" ");return}' +
    'if(tag==="SELECT"){var so=el.options&&el.selectedIndex>=0?el.options[el.selectedIndex]:null;if(so)push(" "+ws(so.text)+" ");return}' +
    // A box's state and a field's value; never a password.
    'if(tag==="INPUT"){var ty=String(el.type||"").toLowerCase();if(ty==="checkbox"||ty==="radio"){push(el.checked?" [x] ":" [ ] ")}else if(ty!=="password"&&ty!=="hidden"&&ty!=="submit"&&ty!=="button"&&ty!=="image"&&el.value){push(" ["+ws(el.value).slice(0,200)+"] ")}return}' +
    'if(tag==="TEXTAREA"){if(el.value)push(" ["+ws(el.value).slice(0,500)+"] ");return}' +
    'if(srOnly(el))return;' +
    'if(tag==="BR"){push("\\n");return}' +
    'if(tag==="TIME"&&el.getAttribute("datetime")){var tt=ws(el.innerText);var dt=el.getAttribute("datetime");push(" "+tt+(tt.indexOf(dt)<0?" ["+dt+"]":"")+" ");return}' +
    // <h1>–<h6>, and ARIA headings by aria-level (Google's results use role=heading).
    'var hl=0;var h=/^H([1-6])$/.exec(tag);if(h)hl=+h[1];else if(el.getAttribute&&el.getAttribute("role")==="heading"){hl=parseInt(el.getAttribute("aria-level")||"2",10);if(!(hl>=1&&hl<=6))hl=2}' +
    // A heading in its source casing: text-transform is presentation, and a
    // quoted caption must match the page's text (BLS: "CHART 8. ANNUAL …").
    'if(hl){var ht=ws(el.innerText);try{if(getComputedStyle(el).textTransform!=="none")ht=ws(el.textContent)}catch(e){}if(ht)push("\\n\\n"+"######".slice(0,hl)+" "+ht+"\\n\\n");return}' +
    'if(tag==="PRE"){push("\\n\\n```\\n"+String(el.innerText||"").replace(/\\s+$/,"")+"\\n```\\n\\n");return}' +
    // A row of a data table is one line of cells; a layout table's row (one
    // holding a table of its own — Hacker News, old forums) is walked instead.
    'if(tag==="TR"){if(el.querySelector("table")){push("\\n\\n");for(var r=el.firstChild;r;r=r.nextSibling)walk(r,depth);push("\\n\\n");return}' +
    'var cs=[].slice.call(el.cells||[]).filter(vis).map(function(c){return ws(c.innerText)});if(cs.join("")!=="")push("\\n| "+cs.join(" | ")+" |");return}' +
    'if(tag==="LI"){var pre="\\n"+new Array(Math.max(0,depth)+1).join("  ")+"- ";' +
    'if(plain(el)){var lt=blockText(el).split("\\n").join(" · ");if(lt)push(pre+lt);return}' +
    'push(pre);for(var c=el.firstChild;c;c=c.nextSibling)walk(c,depth);return}' +
    'var block=BLOCK.test(tag);' +
    'if(plain(el)){var bt=block?blockText(el):ws(el.innerText);if(bt)push(block?"\\n\\n"+bt+"\\n\\n":" "+bt+" ");return}' +
    'if(block)push("\\n\\n");var d2=(tag==="UL"||tag==="OL")?depth+1:depth;var cc=cardSigs.get(el);var prev="";' +
    // Only between neighbours: anything visible in between (a heading, a
    // paragraph — GitHub's README code blocks share one class) ends the run.
    'for(var k=el.firstChild;k;k=k.nextSibling){if(cc){if(k.nodeType===1&&vis(k)){var g2=sig(k);if(g2&&cc[g2]){if(prev===g2)push("\\n\\n---\\n\\n");prev=g2}else prev=""}else if(k.nodeType===3&&String(k.nodeValue||"").trim())prev=""}walk(k,d2)}if(block)push("\\n\\n")};' +
    'try{if(document.body)walk(document.body,-1)}catch(e){}' +
    'var md=out.join("").split("\\n").map(function(l){return /^\\s*- /.test(l)?l.replace(/\\s+$/,""):l.replace(/[ \\t]+/g," ").trim()}).join("\\n").replace(/\\n{3,}/g,"\\n\\n").trim();' +
    // The frames the walk skipped, and how much of the viewport each covers
    // (bench, Target: a PerimeterX "Human verification challenge" frame over
    // the whole page read as an empty search result).
    'var frames=[];try{var vw=(typeof innerWidth==="number"&&innerWidth)||1,vh=(typeof innerHeight==="number"&&innerHeight)||1;[].slice.call(document.querySelectorAll("iframe")).forEach(function(f){if(!vis(f)||frames.length>=12)return;var r=f.getBoundingClientRect();' +
    'var w=Math.max(0,Math.min(r.right,vw)-Math.max(r.left,0)),h=Math.max(0,Math.min(r.bottom,vh)-Math.max(r.top,0));var host="";try{host=new URL(f.src,location.href).host}catch(e){}' +
    'frames.push({name:ws(f.getAttribute("aria-label")||f.title||""),host:host,cover:Math.round(w*h/(vw*vh)*100)/100})})}catch(e){}' +
    'return JSON.stringify({text:md,truncated:full,frames:frames})})()'
  )
}

/** Parse reader output (the CLI double-JSON-encodes). Null when it did not run. */
export function parseReadResult(stdout: string): ReadResult | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    const o = parsed as Record<string, unknown>
    if (typeof o?.text !== 'string') return null
    const frames = Array.isArray(o.frames)
      ? (o.frames as unknown[]).filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null).map(f => ({
        name: typeof f.name === 'string' ? f.name : '',
        host: typeof f.host === 'string' ? f.host : '',
        cover: typeof f.cover === 'number' ? f.cover : 0,
      }))
      : []
    return { text: o.text, truncated: o.truncated === true, frames }
  } catch {
    return null
  }
}

const GLYPHS_ONLY = /^\s*[•·●○◦▪▫■□]+(\s+[•·●○◦▪▫■□]+)*\s*$/

/**
 * Join a list marker left alone on its line (an item whose content starts
 * with a block — GitHub's nav menus) with the line it introduces. Code
 * blocks are kept as they are.
 */
export function tidyRead(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '```') {
      // A closing fence followed (past blank lines) by an opening one: one
      // code block, not many — a code viewer renders a <pre> per line.
      if (inFence) {
        let j = i + 1
        while (j < lines.length && lines[j].trim() === '') j++
        if (j < lines.length && lines[j] === '```') { i = j; continue }
      }
      inFence = !inFence
      out.push(lines[i])
      continue
    }
    if (inFence) { out.push(lines[i]); continue }
    const marker = /^(\s*)-\s*$/.exec(lines[i])
    if (marker) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length && !/^\s*(- |#|\||```)/.test(lines[j])) {
        out.push(`${marker[1]}- ${lines[j].trim()}`)
        i = j
        continue
      }
      continue
    }
    // Lines of nothing but bullet glyphs (carousel dots: 799 of 1,689 lines on
    // a Craigslist results page) go.
    if (GLYPHS_ONLY.test(lines[i])) continue
    out.push(lines[i])
  }
  // Leading blank lines go; a first line's indentation is part of its list.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '').trimEnd()
}

/**
 * A line under the read naming the iframes it did not enter. Facts only: the
 * frame's name, host, and how much of the viewport it covers — a frame over
 * most of the page means the page text above may be under it.
 */
export function formatUnreadFrames(frames: ReadFrame[]): string {
  const shown = frames.filter(f => f.cover > 0).sort((a, b) => b.cover - a.cover).slice(0, 6)
  if (shown.length === 0) return ''
  const items = shown.map(f => {
    const label = f.name ? JSON.stringify(f.name.slice(0, 80)) : 'unnamed'
    const pct = Math.round(f.cover * 100)
    return `${label}${f.host ? ` (${f.host})` : ''} · covers ${pct < 1 ? '<1' : pct}% of the viewport`
  })
  const more = frames.filter(f => f.cover > 0).length - shown.length
  return `\n\nIframes on the page, not included above (browser_snapshot reads into them): ${items.join('; ')}${more > 0 ? `; … ${more} more` : ''}`
}

/** A section longer than this comes back as its start plus its sub-headings. */
export const SECTION_CAP_CHARS = 6000

/**
 * A long section — typically the page's h1, which spans the whole page
 * (bench, Google Hotels: ~10 KB per hotel when ~500 chars were needed) —
 * as its opening part and the list of sub-headings to narrow to.
 */
export function capSection(section: string): string {
  if (section.length <= SECTION_CAP_CHARS) return section
  const nl = section.lastIndexOf('\n', SECTION_CAP_CHARS)
  const at = nl > SECTION_CAP_CHARS * 0.6 ? nl : SECTION_CAP_CHARS
  const subs = headings(section.split('\n')).slice(1)
  const outline = subs.length > 0 ? `; its sub-headings (pass one as section to read just it):\n${subs.map(h => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.title}`).join('\n')}` : ''
  return `${section.slice(0, at)}\n…[this section continues for ${section.length - at} more chars${outline}]`
}

interface Heading { line: number; level: number; title: string }

function headings(lines: string[]): Heading[] {
  const out: Heading[] = []
  let inFence = false
  lines.forEach((l, i) => {
    if (l.startsWith('```')) inFence = !inFence
    if (inFence) return
    const m = /^(#{1,6}) (.+)$/.exec(l)
    if (m) out.push({ line: i, level: m[1].length, title: m[2].trim() })
  })
  return out
}

/** The page's headings as an indented list — a map for picking a section. */
export function outlineOf(text: string): string {
  const hs = headings(text.split('\n'))
  if (hs.length === 0) return ''
  return hs.map(h => `${'  '.repeat(h.level - 1)}- ${h.title}`).join('\n')
}

/**
 * The sections whose heading is `needle` (case-insensitive) — or, when none
 * is exactly that, whose heading contains it — each up to the next heading of
 * the same or a higher level. '' when no heading matches.
 */
export function sectionOf(text: string, needle: string): string {
  const want = needle.trim().toLowerCase()
  if (!want) return ''
  const lines = text.split('\n')
  const hs = headings(lines)
  const exact = hs.some(h => h.title.toLowerCase() === want)
  const matches = (title: string): boolean => exact ? title.toLowerCase() === want : title.toLowerCase().includes(want)
  const parts: Array<{ text: string; parent: string }> = []
  let coveredTo = -1
  hs.forEach((h, i) => {
    if (h.line < coveredTo || !matches(h.title)) return
    const next = hs.slice(i + 1).find(o => o.level <= h.level)
    const end = next ? next.line : lines.length
    coveredTo = end
    const parent = hs.slice(0, i).reverse().find(o => o.level < h.level)
    parts.push({ text: lines.slice(h.line, end).join('\n').trim(), parent: parent?.title ?? '' })
  })
  // Several matches ("Specifications" under each product): name the heading
  // each one sits under, so they cannot be mixed up.
  if (parts.length > 1) return parts.map(p => (p.parent ? `(under "${p.parent}")\n${p.text}` : p.text)).join('\n\n')
  return parts.map(p => p.text).join('\n\n')
}

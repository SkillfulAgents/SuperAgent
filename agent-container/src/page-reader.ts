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

export interface ReadResult {
  text: string
  /** The walk stopped at READ_COLLECT_LIMIT. */
  truncated: boolean
}

/** Build the reader eval: one IIFE returning JSON `{text, truncated}`. */
export function readerScript(): string {
  return (
    '(function(){' +
    'var out=[];var n=0;var full=false;' +
    'var push=function(s){if(full)return;out.push(s);n+=s.length;if(n>' + READ_COLLECT_LIMIT + ')full=true};' +
    'var ws=function(s){return String(s||"").replace(/\\s+/g," ").trim()};' +
    'var vis=function(el){try{if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,opacityProperty:true,checkVisibilityCSS:true,checkOpacity:true});return el.getClientRects().length>0}catch(e){return false}};' +
    // Block text as the browser lays it out: one line per line break, blank runs collapsed.
    'var blockText=function(el){return String(el.innerText||"").split("\\n").map(function(l){return l.replace(/[ \\t\\u00a0]+/g," ").trim()}).filter(function(l){return l}).join("\\n")};' +
    'var SKIP=/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|EMBED|HEAD|SELECT|OPTION|DATALIST)$/;' +
    'var BLOCK=/^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|HR|MAIN|NAV|OL|P|SECTION|TABLE|THEAD|TBODY|TFOOT|UL|SUMMARY|CAPTION|LEGEND)$/;' +
    'var STRUCT="h1,h2,h3,h4,h5,h6,li,tr,pre";' +
    'var walk=function(node,depth){if(full)return;' +
    'if(node.nodeType===3){var t=String(node.nodeValue||"").replace(/\\s+/g," ");if(t.trim())push(t);return}' +
    'if(node.nodeType!==1)return;var el=node;var tag=String(el.tagName||"").toUpperCase();if(SKIP.test(tag))return;' +
    // display:contents has no box of its own but its children render.
    'if(!vis(el)){var dc=false;try{dc=getComputedStyle(el).display==="contents"}catch(e){}if(!dc)return}' +
    'var h=/^H([1-6])$/.exec(tag);if(h){var ht=ws(el.innerText);if(ht)push("\\n\\n"+"######".slice(0,+h[1])+" "+ht+"\\n\\n");return}' +
    'if(tag==="PRE"){push("\\n\\n```\\n"+String(el.innerText||"").replace(/\\s+$/,"")+"\\n```\\n\\n");return}' +
    // A row of a data table is one line of cells; a layout table's row (one
    // holding a table of its own — Hacker News, old forums) is walked instead.
    'if(tag==="TR"){if(el.querySelector("table")){push("\\n\\n");for(var r=el.firstChild;r;r=r.nextSibling)walk(r,depth);push("\\n\\n");return}' +
    'var cs=[].slice.call(el.cells||[]).filter(vis).map(function(c){return ws(c.innerText)});if(cs.join("")!=="")push("\\n| "+cs.join(" | ")+" |");return}' +
    'if(tag==="LI"){var pre="\\n"+new Array(Math.max(0,depth)+1).join("  ")+"- ";' +
    'if(!el.querySelector(STRUCT)){var lt=blockText(el).split("\\n").join(" · ");if(lt)push(pre+lt);return}' +
    'push(pre);for(var c=el.firstChild;c;c=c.nextSibling)walk(c,depth);return}' +
    'var block=BLOCK.test(tag);' +
    'if(!el.querySelector(STRUCT)){var bt=block?blockText(el):ws(el.innerText);if(bt)push(block?"\\n\\n"+bt+"\\n\\n":" "+bt+" ");return}' +
    'if(block)push("\\n\\n");var d2=(tag==="UL"||tag==="OL")?depth+1:depth;for(var k=el.firstChild;k;k=k.nextSibling)walk(k,d2);if(block)push("\\n\\n")};' +
    'try{if(document.body)walk(document.body,-1)}catch(e){}' +
    'var md=out.join("").split("\\n").map(function(l){return /^\\s*- /.test(l)?l.replace(/\\s+$/,""):l.replace(/[ \\t]+/g," ").trim()}).join("\\n").replace(/\\n{3,}/g,"\\n\\n").trim();' +
    'return JSON.stringify({text:md,truncated:full})})()'
  )
}

/** Parse reader output (the CLI double-JSON-encodes). Null when it did not run. */
export function parseReadResult(stdout: string): ReadResult | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    const o = parsed as Record<string, unknown>
    if (typeof o?.text !== 'string') return null
    return { text: o.text, truncated: o.truncated === true }
  } catch {
    return null
  }
}

/**
 * Join a list marker left alone on its line (an item whose content starts
 * with a block — GitHub's nav menus) with the line it introduces.
 */
export function tidyRead(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
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
    out.push(lines[i])
  }
  // Leading blank lines go; a first line's indentation is part of its list.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '').trimEnd()
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
  const parts: string[] = []
  let coveredTo = -1
  hs.forEach((h, i) => {
    if (h.line < coveredTo || !matches(h.title)) return
    const next = hs.slice(i + 1).find(o => o.level <= h.level)
    const end = next ? next.line : lines.length
    coveredTo = end
    parts.push(lines.slice(h.line, end).join('\n').trim())
  })
  return parts.join('\n\n')
}

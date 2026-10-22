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

/** Build the reader eval: one IIFE returning JSON `{text, truncated, frames}`. */
export function readerScript(): string {
  return (
    '(function(){' +
    'var out=[];var n=0;var full=false;' +
    'var push=function(s){if(full)return;out.push(s);n+=s.length;if(n>' + READ_COLLECT_LIMIT + ')full=true};' +
    // Zero-width spaces are layout glue, not text (Meta's ad cards: 180 lines
    // of only U+200B). The joiner U+200D stays: it holds emoji together.
    'var zw=/[\\u200b\\u200c\\u2060\\ufeff]/g;' +
    'var ws=function(s){return String(s||"").replace(zw,"").replace(/\\s+/g," ").trim()};' +
    'var VW=(typeof innerWidth==="number"&&innerWidth)||1,VH=(typeof innerHeight==="number"&&innerHeight)||1;' +
    // Rendered at all: display, content-visibility, visibility. Opacity and
    // position are decided by the pre-pass below.
    'var shown=function(el){try{if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,checkVisibilityCSS:true});return el.getClientRects().length>0}catch(e){return false}};' +
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
    // Screen-reader text that stands for a picture a person sees (a star rating) is kept.
    'var RATING=/\\b(rated|rating|out of \\d|stars?)\\b/i;' +
    // Also walked: live regions (often screen-reader-only status text such as
    // "No results returned." above 30 results), form controls and ARIA
    // checkboxes (checked state, typed values), <time> (its machine date) and
    // slots (shadow DOM).
    'var SPECIAL="select,input,textarea,time[datetime],relative-time,slot,[aria-live],[role=status],[role=alert],[role=checkbox],[role=radio],[role=switch],svg[aria-label],[role=img][aria-label],img[alt],"+SRONLY;' +
    // One pass over every element up front (~20 ms on a 17,000-element page).
    // hidden: what a person cannot see but innerText would read — opacity 0
    // (an inactive carousel slide; not below the fold, where it is usually
    // waiting for a fade-in on scroll), screen-reader-only boxes (1px,
    // clipped), and a fixed panel that is itself outside the viewport (a
    // closed cart drawer), with everything inside them — not what a visible
    // fixed overlay holds past the viewport's edge (a scrolled modal). deep: boxes whose innerText
    // cannot be trusted — they hold hidden text, a shadow root (innerText
    // does not enter it) or cards — so the walk goes into them.
    'var hidden=new Set(),deep=new Set(),groups=new Map(),srBox=new Set();' +
    'var parentOf=function(e){return e.parentElement||(e.parentNode&&e.parentNode.host)||null};' +
    'var markUp=function(e){for(var a=e;a&&!deep.has(a);a=parentOf(a))deep.add(a)};' +
    // Cards: three or more sibling boxes of one tag and class (a results grid)
    // whose first holds a few lines. Their text runs together once walked, so
    // a line `---` goes between neighbouring ones — which price belongs to
    // which product.
    'var sig=function(c){var t=String(c.tagName).toUpperCase();var cl=c.getAttribute("class")||"";return /^(DIV|ARTICLE|SECTION|A)$/.test(t)&&(cl||t==="ARTICLE")?t+"."+cl:""};' +
    // A card links somewhere (a product, a listing); a form group or a
    // label/value pair does not, and is not set apart.
    'var multi=function(c){var t=String(c.innerText||"").replace(zw,"").replace(/\\n\\s*(?=\\n)/g,"").trim();return t.length>=20&&t.indexOf("\\n")>=0&&(c.matches("a[href]")||!!c.querySelector("a[href]"))};' +
    // Screen-reader headings are structure (BLS: a chart's title over its SVG).
    'var HEAD=/^H[1-6]$/;var isHead=function(e){return HEAD.test(String(e.tagName).toUpperCase())||(e.getAttribute&&e.getAttribute("role")==="heading")};' +
    // A link or button with no visible text of its own: its screen-reader
    // text, all of it, is its name (an icon link: "Instagram", "(opens in a
    // new tab)").
    // No text of its own outside screen-reader boxes. An image link like
    // that is named by its image (a logo link), unless the card around it
    // already says the same.
    'var noOwnText=function(h){var tw=document.createTreeWalker(h,4);for(var t=tw.nextNode();t;t=tw.nextNode()){if(!ws(t.nodeValue))continue;var hid=false;for(var a=t.parentElement;a&&a!==h.parentElement;a=a.parentElement){if(srLike(a)){hid=true;break}}if(!hid)return false}return true};' +
    'var srLike=function(x){try{if(x.matches(SRONLY))return true;var r=x.getBoundingClientRect();if(r.width<=1&&r.height<=1){var c=getComputedStyle(x);return c.position==="absolute"||c.position==="fixed"}}catch(e){}return false};' +
    'var onlyName=function(e){try{var h=e.parentElement&&e.parentElement.closest("a,button,[role=button],[role=link]");if(!h||!ws(e.textContent)||srLike(h))return false;var hr=h.getBoundingClientRect();if(hr.width<=1||hr.height<=1||hr.right<=0||hr.bottom+(window.scrollY||0)<=0)return false;return noOwnText(h)}catch(x){return false}};' +
    'var box=function(e,ty){return e.tagName==="INPUT"&&(ty==="checkbox"||ty==="radio")};' +
    'var scan=function(root){var all=root.querySelectorAll("*");for(var i=0;i<all.length;i++){var e=all[i];var p=parentOf(e);' +
    'if(p&&hidden.has(p)){hidden.add(e)}else{var cs=null;try{cs=getComputedStyle(e)}catch(x){}' +
    'if(cs){var fx=cs.position==="fixed";var r=null;var gone=false;' +
    // A styled-away native checkbox (opacity 0 under a custom box) still has a state.
    'if(cs.opacity==="0"&&!box(e,String(e.type||"").toLowerCase())){r=e.getBoundingClientRect();if(r.top<VH)gone=true}' +
    'if(!gone&&fx){r=r||e.getBoundingClientRect();if(r.width>0&&r.height>0&&(r.right<=0||r.left>=VW||r.bottom<=0||r.top>=VH))gone=true}' +
    // A box with no width or height says nothing about where its content
    // shows (Wikipedia's MediaViewer: a 0-high wrapper at the top of the page).
    'if(!gone&&cs.position==="absolute"){r=r||e.getBoundingClientRect();if(r.width>1&&r.height>1&&(r.right<=0||r.bottom+(window.scrollY||0)<=0)&&!onlyName(e))gone=true}' +
    'if(!gone&&(cs.position==="absolute"||cs.position==="fixed")){r=r||e.getBoundingClientRect();if(r.width<=1&&r.height<=1&&(cs.overflow==="hidden"||cs.clip!=="auto"||cs.clipPath!=="none")&&!RATING.test(e.textContent||"")&&!onlyName(e)&&!isHead(e)){gone=true;srBox.add(e)}}' +
    'if(gone){hidden.add(e);if(p&&String(e.textContent||"").trim())markUp(p)}}}' +
    'if(e.shadowRoot&&!hidden.has(e)){markUp(e);scan(e.shadowRoot)}' +
    'var g=p?sig(e):"";if(g&&!hidden.has(e)){var m=groups.get(p);if(!m){m={};groups.set(p,m)}(m[g]=m[g]||[]).push(e)}}};' +
    'try{if(document.body)scan(document.body)}catch(x){}' +
    'var cardSigs=new Map();' +
    'try{groups.forEach(function(m,p){var ok={};var any=false;for(var g in m){if(m[g].length>=3&&multi(m[g][0])){ok[g]=1;any=true}}if(!any)return;cardSigs.set(p,ok);markUp(p)})}catch(x){}' +
    'var vis=function(el){return shown(el)&&!hidden.has(el)};' +
    'var plain=function(el){return el.tagName!=="SLOT"&&!deep.has(el)&&!el.querySelector(STRUCT)&&!el.querySelector(SPECIAL)};' +
    // The rendered children: a shadow root's for its host, the assigned nodes for a slot.
    'var kids=function(el){if(el.shadowRoot)return el.shadowRoot.childNodes;if(el.tagName==="SLOT"&&el.assignedNodes){var a=el.assignedNodes({flatten:true});if(a.length)return a}return el.childNodes};' +
    // A field whose text is painted transparent is a code editor's input layer, not a value.
    'var clear=function(el){try{var c=getComputedStyle(el);var f=String(c.webkitTextFillColor||c.color);return f==="transparent"||/^rgba\\([^)]*,\\s*0\\)$/.test(f)}catch(e){return false}};' +
    // Text in the composed tree: through shadow roots and the nodes assigned to
    // slots, which innerText and textContent do not reach (a web component's
    // <h1><slot></slot></h1>), hidden boxes left out, a box (not inline text)
    // set apart by spaces as the page lays it out ("Releases" beside its "43").
    'var composed=function(el){return !!el.querySelector("slot")||deep.has(el)};' +
    'var flatText=function(el,code){var s="";var go=function(n){if(n.nodeType===3){s+=n.nodeValue;return}if(n.nodeType!==1||hidden.has(n))return;var t=String(n.tagName).toUpperCase();if(SKIP.test(t))return;' +
    'var d2="";try{d2=getComputedStyle(n).display}catch(e){}if(!shown(n)&&d2!=="contents")return;if(t==="BR"){s+="\\n";return}var gap=!code&&d2!=="inline"&&d2!=="contents"?" ":"";s+=gap;var k=kids(n);for(var i=0;i<k.length;i++)go(k[i]);s+=gap};var k0=kids(el);for(var j=0;j<k0.length;j++)go(k0[j]);return s.replace(zw,"")};' +
    'var bigAlts=[];' +
    // Rows of one table share the cells a rowspan carries down.
    'var spans=new Map();' +
    'var CTRL="select,input,textarea,[role=checkbox],[role=radio],[role=switch],svg[aria-label],[role=img][aria-label],img[alt]";' +
    'var cellText=function(c){if(c.querySelector(CTRL)||composed(c)){var keep=out;out=[];var ck=kids(c);for(var q=0;q<ck.length;q++)walk(ck[q],0);var w=ws(out.join("").split("\\n").map(function(l){return l.replace(/^\\s*(#{1,6}|-)\\s+/,"")}).join(" "));out=keep;return w}var t=ws(c.innerText);var lis=c.querySelectorAll("li");if(lis.length>1){var li=[].slice.call(lis).filter(vis).map(function(l){return ws(l.innerText)}).filter(Boolean);if(li.join("").replace(/\\s/g,"")===t.replace(/\\s/g,""))return li.join(" · ")}return t};' +
    'var SEP="\\n\\n---\\n\\n";' +
    'var walk=function(node,depth){if(full)return;' +
    'if(node.nodeType===3){var t=String(node.nodeValue||"").replace(zw,"").replace(/\\s+/g," ");if(t.trim())push(t);else if(t)push(" ");return}' +
    'if(node.nodeType!==1)return;var el=node;var tag=String(el.tagName||"").toUpperCase();if(SKIP.test(tag))return;' +
    'if(hidden.has(el)){if(srBox.has(el)){var shs=el.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]");for(var si2=0;si2<shs.length;si2++){var sh=shs[si2];var shl=/^H([1-6])$/.exec(String(sh.tagName).toUpperCase());var lv=shl?+shl[1]:parseInt(sh.getAttribute("aria-level")||"2",10)||2;var stx=ws(sh.textContent);if(stx)push("\\n\\n"+"######".slice(0,Math.min(6,Math.max(1,lv)))+" "+stx+"\\n\\n")}}return}' +
    'if(tag==="INPUT"){var ty=String(el.type||"").toLowerCase();if(ty==="checkbox"||ty==="radio"){if(shown(el))push(el.checked?" [x] ":" [ ] ");return}}' +
    // display:contents has no box of its own but its children render.
    'if(!shown(el)){var dc=false;try{dc=getComputedStyle(el).display==="contents"}catch(e){}if(!dc)return}' +
    'if(el.matches&&el.matches(SRONLY)&&!isHead(el)){if(RATING.test(el.textContent||"")||onlyName(el))push(" "+ws(el.textContent)+" ");return}' +
    'var role=el.getAttribute?el.getAttribute("role"):null;' +
    'if(role==="checkbox"||role==="radio"||role==="switch"){var ac=el.getAttribute("aria-checked");push(ac==="true"?" [x] ":ac==="mixed"?" [-] ":" [ ] ")}' +
    // An icon is its name; a large image's alt is left out (a product photo
    // repeats the product name) unless the page has no text at all.
    'if(tag==="SVG"||tag==="IMG"||(role==="img"&&!ws(el.innerText))){var il=tag==="IMG"?el.getAttribute("alt"):el.getAttribute("aria-label");var small=true;try{small=el.getBoundingClientRect().width<=48}catch(e){}var lk=tag==="IMG"?el.closest("a,button"):null;if(il&&small){var ctx=tag==="IMG"?(el.closest("a,button,li,td")||el.parentElement):null;if(!(ctx&&ws(ctx.innerText).indexOf(ws(il))>=0))push(" "+ws(il)+" ")}else if(il&&lk&&noOwnText(lk)&&!((lk.parentElement&&lk.parentElement.closest("li,article,div")||document.body).innerText||"").includes(ws(il)))push(" "+ws(il)+" ");else if(il)bigAlts.push(ws(il));return}' +
    'if(tag==="SELECT"){var so=el.options&&el.selectedIndex>=0?el.options[el.selectedIndex]:null;if(so)push(" "+ws(so.text)+" ");return}' +
    // A field's value; never a password.
    'if(tag==="INPUT"){if(ty!=="password"&&ty!=="hidden"&&ty!=="submit"&&ty!=="button"&&ty!=="image"&&el.value&&!clear(el)){push(" ["+ws(el.value).slice(0,200)+"] ")}return}' +
    'if(tag==="TEXTAREA"){if(el.value&&!clear(el))push(" ["+ws(el.value).slice(0,500)+"] ");return}' +
    'if(tag==="BR"){push("\\n");return}' +
    'if((tag==="TIME"||tag==="RELATIVE-TIME")&&el.getAttribute("datetime")){var tt=ws(el.innerText)||ws(el.shadowRoot&&el.shadowRoot.textContent);var dt=el.getAttribute("datetime");push(" "+tt+(tt.indexOf(dt)<0?" ["+dt+"]":"")+" ");return}' +
    // <h1>–<h6>, and ARIA headings by aria-level (Google's results use role=heading).
    'var hl=0;var h=/^H([1-6])$/.exec(tag);if(h)hl=+h[1];else if(role==="heading"){hl=parseInt(el.getAttribute("aria-level")||"2",10);if(!(hl>=1&&hl<=6))hl=2}' +
    // A heading in its source casing: text-transform is presentation, and a
    // quoted caption must match the page's text (BLS: "CHART 8. ANNUAL …").
    'if(hl){var ht=ws(el.innerText);try{if(composed(el))ht=ws(flatText(el));else if(getComputedStyle(el).textTransform!=="none")ht=ws(el.textContent)}catch(e){}if(ht)push("\\n\\n"+"######".slice(0,hl)+" "+ht+"\\n\\n");return}' +
    // Code as written: the source text when it has the same lines as the
    // rendered text (highlighters that lay each line out as a flex row double
    // innerText's line breaks); without its own line breaks, the rendered
    // text, every other line dropped when every other line is empty.
    'if(tag==="PRE"){var it=String(el.innerText||"").replace(zw,"");var tc=composed(el)?flatText(el,true):String(el.textContent||"").replace(zw,"");if(composed(el))it=tc;var nb=function(s){return s.split("\\n").filter(function(l){return l.trim()}).length};' +
    'var code=tc.indexOf("\\n")>=0&&nb(tc)===nb(it)?tc:it;var ls=code.replace(/^\\n+/,"").replace(/\\s+$/,"").split("\\n");if(ls.length>=3&&ls.every(function(l,i){return i%2===0||l===""}))ls=ls.filter(function(l,i){return i%2===0});' +
    'push("\\n\\n```\\n"+ls.join("\\n")+"\\n```\\n\\n");return}' +
    // A row of a data table is one line of cells, a rowspan's cell repeated
    // on the rows it covers and a colspan's columns kept (Nobel laureates:
    // "Name" spans two columns); a layout table's row (one holding a table of
    // its own — Hacker News, old forums) is walked instead.
    'if(tag==="TR"){if(el.querySelector("table")){push("\\n\\n");var rk=kids(el);for(var ri=0;ri<rk.length;ri++)walk(rk[ri],depth);push("\\n\\n");return}' +
    'var tb=el.closest("table");var carry=spans.get(tb)||[];var row=[];var col=0;' +
    'var take=function(){while(carry[col]&&carry[col].n>0){row.push(carry[col].t);carry[col].n--;col++}};' +
    'var cells=[].slice.call(el.cells||[]);for(var ci=0;ci<cells.length;ci++){var c=cells[ci];if(!vis(c))continue;take();var ct=cellText(c);var rs=Math.max(1,c.rowSpan||1);var csp=Math.min(20,Math.max(1,c.colSpan||1));' +
    'for(var si=0;si<csp;si++){row.push(si===0?ct:"");if(rs>1)carry[col]={t:si===0?ct:"",n:rs-1};col++}}take();spans.set(tb,carry);' +
    'if(row.join("")!=="")push("\\n| "+row.join(" | ")+" |");return}' +
    'if(tag==="LI"){var pre="\\n"+new Array(Math.max(0,depth)+1).join("  ")+"- ";' +
    'if(plain(el)){var lt=blockText(el).split("\\n").join(" · ");if(lt)push(pre+lt);return}' +
    'push(pre);var lk=kids(el);for(var li2=0;li2<lk.length;li2++)walk(lk[li2],depth);return}' +
    'var block=BLOCK.test(tag);' +
    // Inline text is joined as the page joins it; a box (inline-block, flex
    // item) is set apart by spaces.
    'if(plain(el)){var bt=block?blockText(el):ws(el.innerText);var inl=false;if(!block){try{inl=getComputedStyle(el).display==="inline"}catch(e){}}if(bt)push(block?"\\n\\n"+bt+"\\n\\n":inl?bt:" "+bt+" ");return}' +
    'if(block)push("\\n\\n");var d2=(tag==="UL"||tag==="OL")?depth+1:depth;var cc=cardSigs.get(el);var prev="";var had=false;var ks=kids(el);' +
    // Only between neighbours that both read as something: anything visible
    // in between (a heading, a paragraph — GitHub's README code blocks share
    // one class) ends the run.
    'for(var ki=0;ki<ks.length;ki++){var k=ks[ki];if(cc){if(k.nodeType===1&&vis(k)){var g2=sig(k);if(g2&&cc[g2]){var at=out.length;walk(k,d2);var got=out.slice(at).join("").trim()!=="";' +
    'if(got&&had&&prev===g2&&!full){out.splice(at,0,SEP);n+=SEP.length}if(got)had=true;prev=g2;continue}prev="";had=false}else if(k.nodeType===3&&String(k.nodeValue||"").trim()){prev="";had=false}}walk(k,d2)}' +
    'if(block)push("\\n\\n")};' +
    'try{if(document.body)walk(document.body,-1)}catch(e){}' +
    // Lines tidied outside code blocks only: indentation inside them is the code.
    'var inF=false;var md=out.join("").split("\\n").map(function(l){if(/^```/.test(l)){inF=!inF;return l}if(inF)return l.replace(/\\s+$/,"");' +
    'if(/^\\s*- /.test(l))return l.replace(/^(\\s*- )\\s+/,"$1").replace(/(\\S)[ \\t]{2,}/g,"$1 ").replace(/\\s+$/,"");return l.replace(/[ \\t]+/g," ").trim().replace(/ +([.,;:!?])(?=\\s|$)/g,"$1")}).join("\\n").replace(/\\n{3,}/g,"\\n\\n").trim();' +
    'if(!md&&bigAlts.length)md=bigAlts.join("\\n");' +
    // The frames the walk skipped, and how much of the viewport each covers
    // (bench, Target: a PerimeterX "Human verification challenge" frame over
    // the whole page read as an empty search result).
    'var frames=[];try{[].slice.call(document.querySelectorAll("iframe")).forEach(function(f){if(!vis(f)||frames.length>=12)return;var r=f.getBoundingClientRect();' +
    'var w=Math.max(0,Math.min(r.right,VW)-Math.max(r.left,0)),h=Math.max(0,Math.min(r.bottom,VH)-Math.max(r.top,0));var host="";try{host=new URL(f.src,location.href).host}catch(e){}' +
    'frames.push({name:ws(f.getAttribute("aria-label")||f.title||""),host:host,cover:Math.round(w*h/(VW*VH)*100)/100})})}catch(e){}' +
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
      if (j < lines.length && !/^\s*(- |#|\||```)/.test(lines[j]) && !/^\s*-\s*$/.test(lines[j])) {
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
 * the same or a higher level, each capped (capSection). '' when no heading
 * matches.
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
  // Several matches ("Specifications" under each product): number them and
  // name the heading each sits under, so they cannot be mixed up; each is
  // capped on its own, so a long first one cannot hide the second.
  if (parts.length > 1) {
    return parts.map((p, i) => `(match ${i + 1} of ${parts.length}${p.parent ? `, under "${p.parent}"` : ''})\n${capSection(p.text)}`).join('\n\n')
  }
  return parts.map(p => capSection(p.text)).join('\n\n')
}

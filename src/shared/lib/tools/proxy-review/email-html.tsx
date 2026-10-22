import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useIsDark } from '@renderer/hooks/use-theme'

/**
 * Dark mode as mail apps do it: the email keeps its white page and its own colors, then the whole page is
 * inverted and hue-rotated, and images are flipped back. Light boxes with no text color stay readable.
 * The page starts at #e0e0e0 so it inverts to the card's #1f1f1f.
 */
const EMAIL_HTML_DARK = 'html{background:#e0e0e0;filter:invert(1) hue-rotate(180deg)}img,video,picture{filter:invert(1) hue-rotate(180deg)}'

/** The widget card frame's policy: no scripts, no network. An image the email carries as data: still draws. */
const EMAIL_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

/**
 * Points each `cid:` image at the part the email carries, and hides every other image, so none draws as broken.
 * A parsed document runs no scripts and loads nothing.
 */
export function withImages(html: string, images: ReadonlyMap<string, string>): string {
  const page = new DOMParser().parseFromString(html, 'text/html')
  for (const image of page.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    const drawn = src.startsWith('cid:') ? images.get(src.slice(4)) : src.startsWith('data:') ? src : undefined
    image.removeAttribute('srcset')
    if (drawn) {
      image.setAttribute('src', drawn)
    } else {
      image.removeAttribute('src')
      image.style.visibility = 'hidden'
    }
  }
  return page.documentElement.outerHTML
}

/**
 * Gmail's default body font, and wrapping for what would otherwise scroll sideways: the frame takes no input, so its scrollbars cannot be used.
 * As the chat HTML frame: the body's height is the content height, and viewport-sized html/body would grow the frame with every measure.
 */
const EMAIL_HTML_STYLE = 'html,body{margin:0;overflow:hidden;height:auto!important;min-height:0!important}body{display:flow-root;position:relative;padding:12px;font:small Arial,Helvetica,sans-serif;overflow-wrap:anywhere}pre{white-space:pre-wrap}img,table{max-width:100%}'

/**
 * The HTML part as the recipient's mail app draws it, on the white page emails assume. The frame runs no scripts and loads nothing, so
 * remote images stay blank until the recipient opens the mail. It takes no clicks, so a link cannot navigate it.
 * The policy cannot stop a meta refresh from loading another page into the frame, so every meta tag is renamed to one the browser ignores.
 * Same-origin, with scripts off, only so the card can read the document's height.
 */
export function EmailHtml({ html }: { html: string }) {
  const dark = useIsDark()
  const srcDoc = useMemo(() => `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${EMAIL_HTML_CSP}"><style>${EMAIL_HTML_STYLE}${dark ? EMAIL_HTML_DARK : ''}</style></head><body>${html.replace(/<meta\b/gi, '<x-meta')}`, [html, dark])
  const [height, setHeight] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  useEffect(() => () => observer.current?.disconnect(), [])
  const onLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget
    const body = frame.contentDocument?.body
    const view = frame.contentWindow
    if (!body || !view) return
    // As the chat HTML frame: growth reported right after the frame only got taller follows the frame (100vh), so it is not content.
    let lastWidth = view.innerWidth
    let followsFrame = false
    view.addEventListener('resize', () => {
      followsFrame = view.innerWidth === lastWidth
      lastWidth = view.innerWidth
      requestAnimationFrame(() => requestAnimationFrame(() => { followsFrame = false }))
    })
    // The frame grows with its content, so it never scrolls inside. A long body is clamped around it instead.
    const measure = () => setHeight((current) => (followsFrame && body.scrollHeight > current ? current : body.scrollHeight))
    measure()
    observer.current?.disconnect()
    if (typeof ResizeObserver === 'undefined') return
    observer.current = new ResizeObserver(measure)
    observer.current.observe(body)
  }, [])
  return (
    <iframe
      srcDoc={srcDoc}
      title="Email body"
      sandbox="allow-same-origin"
      onLoad={onLoad}
      style={{ height: height || undefined }}
      className="pointer-events-none block w-full rounded border-0 bg-white dark:bg-[#1f1f1f]"
      data-testid="email-html"
    />
  )
}

const BODY_PREVIEW_HEIGHT = 220

/** A long body shows its start with a fade, like Gmail trims long messages, and expands in place. */
export function ClampedBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setOverflows(element.scrollHeight > BODY_PREVIEW_HEIGHT))
    observer.observe(element.firstElementChild ?? element)
    return () => observer.disconnect()
  }, [])
  const clamped = overflows && !expanded
  return (
    <div>
      <div
        ref={ref}
        style={clamped ? { maxHeight: BODY_PREVIEW_HEIGHT } : undefined}
        className={clamped ? 'overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : undefined}
      >
        {children}
      </div>
      {clamped && (
        <button type="button" onClick={() => setExpanded(true)} className="mt-1 text-[13px] text-[#1a73e8] hover:underline dark:text-[#8ab4f8]">
          Show full email
        </button>
      )}
    </div>
  )
}

/** Every web address the HTML names: links, images, and refreshes, as the recipient's mail app would follow or load them. */
export function webAddresses(html: string): string[] {
  const found = html.match(/\bhttps?:\/\/[^\s"'<>()\\`]+/gi) ?? []
  return [...new Set(found.map((address) => address.replace(/&amp;/g, '&').replace(/[.,;:!?]+$/, '')))]
}

/** Named as text, so none of them opens or loads here. */
export function WebAddresses({ addresses }: { addresses: string[] }) {
  if (addresses.length === 0) return null
  return (
    <section className="mt-4 border-t border-dotted border-[#dadce0] pt-3 dark:border-[#5f6368]" data-testid="email-web-addresses">
      <h4 className="text-sm font-medium">Web addresses in this email</h4>
      <ul className="mt-2 break-all text-xs leading-5 text-[#5f6368] dark:text-[#9aa0a6]">
        {addresses.map((address) => <li key={address}>{address}</li>)}
      </ul>
    </section>
  )
}

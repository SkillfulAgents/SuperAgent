import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useIsDark } from '@renderer/hooks/use-theme'
import { CodeCopyButton } from './code-copy-button'

// Scripts and styles are inline; nothing is fetched, posted, or framed. The app's web font
// would need a network exception a script could leak data through, so text uses the font stack's fallbacks.
// CSP doesn't cover WebRTC, so a script can still reach a STUN host by peer connection.
const HTML_BLOCK_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

const HEIGHT_MESSAGE = 'superagent:html-block-height'
const WHEEL_MESSAGE = 'superagent:html-block-wheel'
const INITIAL_HEIGHT = 160
const MAX_HEIGHT = 1200
const MAX_REMEMBERED_HEIGHTS = 200

// Remembered per block so switching back to a session doesn't reflow from the initial height.
const measuredHeights = new Map<string, number>()

function rememberHeight(source: string, height: number): void {
  measuredHeights.delete(source)
  measuredHeights.set(source, height)
  if (measuredHeights.size > MAX_REMEMBERED_HEIGHTS) measuredHeights.delete(measuredHeights.keys().next().value!)
}

const THEME_TOKENS = [
  'background', 'foreground', 'card', 'card-foreground', 'primary', 'primary-foreground',
  'muted', 'muted-foreground', 'accent', 'destructive', 'border', 'ring', 'radius',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
]

/** The app's live theme tokens plus a base style, so authored HTML looks like the chat around it. */
function themeStyle(): string {
  const computed = getComputedStyle(document.documentElement)
  const vars = THEME_TOKENS.map((name) => `--${name}:${computed.getPropertyValue(`--${name}`).trim()}`).join(';')
  const fontFamily = getComputedStyle(document.body).fontFamily
  return (
    `:root{${vars}}` +
    'html{overflow:hidden;scrollbar-width:thin}' +
    // flow-root keeps child margins inside body, so its height is the content height.
    // Positioned, so absolute content hanging below it (tooltips, legends) counts toward its height.
    'body{display:flow-root;position:relative}' +
    // The frame's height follows its content, so viewport-sized html/body (100vh, 100%) would grow it to the cap.
    'html,body{height:auto!important;min-height:0!important}' +
    "html,body{margin:0;background:transparent;color:hsl(var(--foreground));" +
    // Same size and line height as chat prose (prose-sm).
    `font:14px/1.7142857 ${fontFamily}}` +
    // Focus rings follow the app's ring color; mouse clicks show none.
    ':focus-visible{outline:2px solid hsl(var(--ring))!important;outline-offset:2px}' +
    ':focus:not(:focus-visible){outline:none!important}'
  )
}

// Reports the content height, and shows a scrollbar only past the cap. Wheel input the page
// can't use scrolls the chat instead; the chat's scroll engine never sees it, so it's forwarded.
const FRAME_SCRIPT = `(() => {
  const root = document.documentElement
  const post = () => {
    const height = document.body ? document.body.scrollHeight : root.scrollHeight
    root.style.overflowY = height > ${MAX_HEIGHT} ? 'auto' : 'hidden'
    parent.postMessage({ type: '${HEIGHT_MESSAGE}', height }, '*')
  }
  const observer = new ResizeObserver(post)
  observer.observe(root)
  addEventListener('DOMContentLoaded', () => observer.observe(document.body))
  addEventListener('load', post)
  // Non-passive: Chromium skips passive wheel listeners in a frame that can't scroll. Never prevented.
  document.addEventListener('wheel', (event) => {
    const canScroll = event.deltaY < 0 ? root.scrollTop > 0 : root.scrollTop < root.scrollHeight - root.clientHeight - 1
    if (root.style.overflowY !== 'auto' || !canScroll) parent.postMessage({ type: '${WHEEL_MESSAGE}', deltaY: event.deltaY }, '*')
  }, { passive: false })
})()`

/** The document as the chat renders it: policy, theme, and frame script come before authored markup. */
function renderHtmlBlockDocument(source: string, scheme: 'light' | 'dark'): string {
  return (
    `<!DOCTYPE html><html data-theme="${scheme}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${HTML_BLOCK_CSP}">` +
    `<meta name="color-scheme" content="${scheme}">` +
    `<style>${themeStyle()}</style>` +
    `<script>${FRAME_SCRIPT}</script>${source}`
  )
}

export function HtmlBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
  const scheme = useIsDark() ? 'dark' : 'light'
  const srcDoc = useMemo(() => renderHtmlBlockDocument(source, scheme), [source, scheme])
  const getSource = useCallback(() => source, [source])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(() => measuredHeights.get(source) ?? INITIAL_HEIGHT)
  const loadedDoc = useRef<string | null>(null)
  const [navigatedAway, setNavigatedAway] = useState(false)

  // The CSP can't stop the frame loading another page into itself, and that page has no CSP.
  // A second load of the same document means it did, so show the source instead.
  // A new document (theme switch) starts fresh, even if it matches one whose load never finished.
  useEffect(() => {
    loadedDoc.current = null
  }, [srcDoc])
  const onLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    const doc = event.currentTarget.srcdoc
    if (loadedDoc.current === doc) setNavigatedAway(true)
    loadedDoc.current = doc
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown; deltaY?: unknown } | null
      if (data?.type === WHEEL_MESSAGE && typeof data.deltaY === 'number' && Number.isFinite(data.deltaY)) {
        // A script can post these on its own; only scroll the chat while the pointer is on the preview.
        if (frame.matches(':hover')) frame.dispatchEvent(new WheelEvent('wheel', { deltaY: data.deltaY, bubbles: true }))
        return
      }
      if (data?.type !== HEIGHT_MESSAGE || typeof data.height !== 'number' || !Number.isFinite(data.height)) return
      const next = Math.min(Math.max(Math.ceil(data.height), 1), MAX_HEIGHT)
      rememberHeight(source, next)
      setHeight(next)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [source])

  if (navigatedAway) return fallback

  return (
    <div className="relative group my-3" data-testid="html-block">
      <iframe
        ref={frameRef}
        srcDoc={srcDoc}
        title="HTML preview"
        onLoad={onLoad}
        // Scripts run in an opaque origin: no app cookies, storage, or same-origin APIs.
        sandbox="allow-scripts"
        // Matching the document's color-scheme keeps the frame transparent instead of a default canvas.
        style={{ height, colorScheme: scheme }}
        className="block w-full border-0 bg-transparent"
      />
      <CodeCopyButton getText={getSource} />
    </div>
  )
}

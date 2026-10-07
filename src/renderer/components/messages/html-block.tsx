import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useIsDark } from '@renderer/hooks/use-theme'
import { CodeCopyButton } from './code-copy-button'

// The same Inter stylesheet the app loads (src/renderer/index.html).
const APP_FONT_STYLESHEET = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'

// Scripts and styles are inline; only the app's Google font may load. Nothing else is fetched, posted, or framed.
const HTML_BLOCK_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data:; font-src data: https://fonts.gstatic.com; form-action 'none'; base-uri 'none'"

const HEIGHT_MESSAGE = 'superagent:html-block-height'
const WHEEL_MESSAGE = 'superagent:html-block-wheel'
const INITIAL_HEIGHT = 160
const MAX_HEIGHT = 1200

// Remembered per block so switching back to a session doesn't reflow from the initial height.
const measuredHeights = new Map<string, number>()

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
    'body{display:flow-root}' +
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
    `<link rel="stylesheet" href="${APP_FONT_STYLESHEET}">` +
    `<style>${themeStyle()}</style>` +
    `<script>${FRAME_SCRIPT}</script>${source}`
  )
}

export function HtmlBlock({ source }: { source: string }) {
  const scheme = useIsDark() ? 'dark' : 'light'
  const srcDoc = useMemo(() => renderHtmlBlockDocument(source, scheme), [source, scheme])
  const getSource = useCallback(() => source, [source])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(() => measuredHeights.get(source) ?? INITIAL_HEIGHT)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown; deltaY?: unknown } | null
      if (data?.type === WHEEL_MESSAGE && typeof data.deltaY === 'number' && Number.isFinite(data.deltaY)) {
        frame.dispatchEvent(new WheelEvent('wheel', { deltaY: data.deltaY, bubbles: true }))
        return
      }
      if (data?.type !== HEIGHT_MESSAGE || typeof data.height !== 'number' || !Number.isFinite(data.height)) return
      const next = Math.min(Math.max(Math.ceil(data.height), 1), MAX_HEIGHT)
      measuredHeights.set(source, next)
      setHeight(next)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [source])

  return (
    <div className="relative group my-3" data-testid="html-block">
      <iframe
        ref={frameRef}
        srcDoc={srcDoc}
        title="HTML preview"
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

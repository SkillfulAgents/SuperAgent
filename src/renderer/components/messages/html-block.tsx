import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useIsDark } from '@renderer/hooks/use-theme'
import { CodeCopyButton } from './code-copy-button'

// Scripts and styles may only be inline; nothing can be fetched, posted, or framed.
const HTML_BLOCK_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

const HEIGHT_MESSAGE = 'superagent:html-block-height'
const INITIAL_HEIGHT = 160
const MAX_HEIGHT = 1200

const HEIGHT_REPORTER = `(() => {
  const post = () => parent.postMessage({ type: '${HEIGHT_MESSAGE}', height: document.documentElement.scrollHeight }, '*')
  new ResizeObserver(post).observe(document.documentElement)
  addEventListener('load', post)
})()`

/** The document as the chat renders it: policy, theme, and height reporter parsed before authored markup. */
function renderHtmlBlockDocument(source: string, scheme: 'light' | 'dark'): string {
  return (
    `<!DOCTYPE html><html data-theme="${scheme}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${HTML_BLOCK_CSP}">` +
    `<meta name="color-scheme" content="${scheme}">` +
    `<script>${HEIGHT_REPORTER}</script>${source}`
  )
}

export function HtmlBlock({ source }: { source: string }) {
  const scheme = useIsDark() ? 'dark' : 'light'
  const srcDoc = useMemo(() => renderHtmlBlockDocument(source, scheme), [source, scheme])
  const getSource = useCallback(() => source, [source])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(INITIAL_HEIGHT)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (data?.type !== HEIGHT_MESSAGE || typeof data.height !== 'number' || !Number.isFinite(data.height)) return
      setHeight(Math.min(Math.max(Math.ceil(data.height), 1), MAX_HEIGHT))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

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
        className="block w-full rounded-md border border-border/60 bg-transparent"
      />
      <CodeCopyButton getText={getSource} />
    </div>
  )
}

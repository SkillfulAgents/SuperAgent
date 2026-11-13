import { useMemo, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { useVendorFavicon, vendorFaviconHref } from '@renderer/components/ui/site-favicon'
import { cn } from '@shared/lib/utils/cn'
import { getPathName } from '@shared/lib/utils/workspace-path'
import { mediaCallOf, mediaKind, type MediaKind } from './media-call'
import { Field } from '../ui/shared'
import { ExpandedView as TerminalView } from './renderer'
import type { CollapsedContentProps, ToolRendererProps } from '../renderer-types'

const MAX_PREVIEWS = 4

// Outputs load from the service's own file host only; any other link the agent printed stays a link and needs a click.
const OUTPUT_HOST = /(^|\.)replicate\.delivery$/

function outputHref(url: string): string | null {
  const href = vendorFaviconHref(url)
  return href && OUTPUT_HOST.test(new URL(href).hostname) ? href : null
}

/** The outputs the card can draw, in print order. */
function drawableOutputs(outputUrls: string[]): Array<{ url: string; src: string; kind: MediaKind }> {
  return outputUrls.flatMap((url) => {
    const src = outputHref(url)
    const kind = mediaKind(url)
    return src && kind ? [{ url, src, kind }] : []
  })
}

function nameOf(url: string): string {
  return getPathName(url.split(/[?#]/)[0])
}

function MediaPreview({ src, kind }: { src: string; kind: MediaKind }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground"
      >
        <ImageOff className="h-3.5 w-3.5 shrink-0" />
        <span>Couldn&apos;t load {nameOf(src)}. The link may have expired.</span>
      </div>
    )
  }

  const onError = () => setFailed(true)
  if (kind === 'image') {
    return <img src={src} alt={nameOf(src)} loading="lazy" onError={onError} className="block max-h-80 max-w-full rounded border" />
  }
  if (kind === 'video') {
    // Generated media has no caption track to offer.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video src={src} controls preload="metadata" onError={onError} className="block max-h-80 max-w-full rounded border bg-black" />
  }
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <audio src={src} controls preload="metadata" onError={onError} className="block w-full dark:[color-scheme:dark]" />
}

/** The first image the job made, as a small thumbnail on the collapsed row. */
export function MediaThumbnail({ input, result, isError }: CollapsedContentProps) {
  const src = useMemo(() => {
    const call = mediaCallOf(input, result, isError)
    return call ? drawableOutputs(call.outputUrls).find(({ kind }) => kind === 'image')?.src : undefined
  }, [input, result, isError])
  const { href, onError } = useVendorFavicon(src)
  if (!href) return null
  return <img src={href} alt="" loading="lazy" onError={onError} className="h-5 w-8 shrink-0 rounded-sm border object-cover" />
}

/**
 * What a media generation call did: model, prompt, status and output, each only when the call
 * proves it. A call that proves none of them, or failed to run, keeps the terminal.
 */
export function MediaCallView(props: ToolRendererProps) {
  const { input, result, isError } = props
  const [showRaw, setShowRaw] = useState(false)
  const call = useMemo(() => mediaCallOf(input, result, isError), [input, result, isError])

  if (!call) return <TerminalView {...props} />

  // Past the fourth preview, outputs are links so every one stays reachable.
  const previews = drawableOutputs(call.outputUrls).slice(0, MAX_PREVIEWS)
  const links = call.outputUrls.filter((url) => !previews.some((preview) => preview.url === url))
  const failed = call.status === 'failed' || call.status === 'canceled'

  return (
    <div className="space-y-2" data-testid="media-call">
      {(call.model || call.status) && (
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          {call.model && <span className="font-mono font-medium">{call.model}</span>}
          {call.status && (
            <span
              className={cn(failed ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}
              data-testid="media-call-status"
            >
              {call.status[0].toUpperCase() + call.status.slice(1)}
            </span>
          )}
        </div>
      )}
      {call.prompt && (
        <Field label="Prompt" className="whitespace-pre-wrap break-words max-h-32 overflow-y-auto card-scrollbar">
          {call.prompt}
        </Field>
      )}
      {call.error && (
        <Field label="Error" className="text-red-800 dark:text-red-200 whitespace-pre-wrap break-words">
          {call.error}
        </Field>
      )}
      {previews.map(({ src, kind }) => (
        <MediaPreview key={src} src={src} kind={kind} />
      ))}
      {links.map((url) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {nameOf(url)}
        </a>
      ))}
      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline"
      >
        {showRaw ? 'Hide raw command' : 'Show raw command'}
      </button>
      {showRaw && <TerminalView {...props} />}
    </div>
  )
}

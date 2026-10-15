import { defineToolRenderer } from '../renderer-types'
import { Mic, Sparkles, Terminal, Users } from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { cn } from '@shared/lib/utils/cn'
import { bashDef, type BashInput } from './definition'
import { identifyServiceCall, type BuiltInService } from './service-call'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from '../renderer-types'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { command } = bashDef.parseInput(input)

  return (
    <div className="rounded-md bg-black overflow-hidden" data-testid="bash-terminal">
      <div className="p-3 font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto">
        {/* Command line */}
        {command && (
          <pre className="text-white font-bold whitespace-pre-wrap break-all m-0">
            <span className="text-gray-500 select-none">$ </span>
            {command}
          </pre>
        )}

        {/* Output */}
        {result && (
          <pre
            className={`mt-2 whitespace-pre-wrap break-all m-0 ${
              isError ? 'text-red-400' : 'text-gray-400'
            }`}
          >
            {result}
          </pre>
        )}
      </div>
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: BashInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming, show raw
  }

  return (
    <div className="rounded-md bg-black overflow-hidden" data-testid="bash-terminal">
      <div className="p-3 font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto">
        {parsed.description && (
          <div className="text-gray-500 mb-1">{parsed.description}</div>
        )}
        <pre className="text-white font-bold whitespace-pre-wrap break-all m-0">
          <span className="text-gray-500 select-none">$ </span>
          {parsed.command || <span className="text-gray-600 italic">...</span>}
          <span className="animate-pulse text-gray-400">|</span>
        </pre>
      </div>
    </div>
  )
}

const terminalRenderer = defineToolRenderer(bashDef, {
  icon: Terminal,
  ExpandedView,
  StreamingView,
})

// Many brand logos are dark glyphs; in dark mode they sit on the same light tile as chat favicon tiles (TileStack).
function brandIcon(slug: string): NonNullable<ToolRenderer['icon']> {
  function BrandIcon({ className }: { className?: string }) {
    return (
      <span className={cn('flex items-center justify-center rounded-[3px] dark:bg-zinc-200 dark:text-zinc-600', className)}>
        <ServiceIcon slug={slug} fallback="request" className="h-[85%] w-[85%]" />
      </span>
    )
  }
  return BrandIcon
}

const BUILT_IN_ICONS: Record<BuiltInService, NonNullable<ToolRenderer['icon']>> = {
  replicate: Sparkles,
  apollo: Users,
  openai: Mic,
  x: brandIcon('twitter'),
}

// Cached so a row's icon component keeps its identity across renders.
const serviceRenderers = new Map<string, ToolRenderer>()

/** A platform service call keeps the terminal body; the row names the service. */
function serviceCallVariant(command: string): ToolRenderer | undefined {
  const call = identifyServiceCall(command)
  if (!call) return undefined
  const key = call.kind === 'built-in' ? `built-in:${call.service}` : `connected-account:${call.toolkit}`
  let renderer = serviceRenderers.get(key)
  if (!renderer) {
    renderer = {
      ...terminalRenderer,
      displayName: call.name,
      icon: call.kind === 'built-in' ? BUILT_IN_ICONS[call.service] : brandIcon(call.toolkit),
    }
    serviceRenderers.set(key, renderer)
  }
  return renderer
}

/** Most specific first; the first variant that matches wins, and no match keeps the terminal. */
const VARIANTS = [serviceCallVariant]

export const bashRenderer = {
  ...terminalRenderer,
  resolve(input: unknown): ToolRenderer | undefined {
    const { command } = bashDef.parseInput(input)
    if (typeof command !== 'string') return undefined
    for (const variant of VARIANTS) {
      const renderer = variant(command)
      if (renderer) return renderer
    }
    return undefined
  },
}

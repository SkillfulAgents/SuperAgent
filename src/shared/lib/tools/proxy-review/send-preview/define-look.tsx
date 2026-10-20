import { useMemo, type ComponentType, type ReactNode } from 'react'
import type { z } from 'zod'

/** A registered look: the kind it draws, and a renderer that draws only data that kind accepts. */
export interface SendPreviewLook {
  kind: string
  render: (data: unknown, agentSlug: string) => ReactNode
}

/** Pairs a look's component with its kind's schema, so it never draws data the schema rejects. */
export function defineLook<T>(kind: string, schema: z.ZodType<T>, Look: ComponentType<{ data: T; agentSlug: string }>): SendPreviewLook {
  // Parsed once per payload: the parse returns a new object, which would defeat the look's own memos on every render.
  function Checked({ data, agentSlug }: { data: unknown; agentSlug: string }) {
    const parsed = useMemo(() => schema.safeParse(data), [data])
    return parsed.success ? <Look data={parsed.data} agentSlug={agentSlug} /> : null
  }
  return { kind, render: (data, agentSlug) => <Checked data={data} agentSlug={agentSlug} /> }
}

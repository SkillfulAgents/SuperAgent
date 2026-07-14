import { useParams } from '@tanstack/react-router'
import { TriangleAlert, ArrowUpRight } from 'lucide-react'
import type { ApiInformational } from '@shared/lib/types/api'
import { AppLink } from '@renderer/components/ui/app-link'

interface InformationalItemProps {
  item: ApiInformational
}

/** The SDK's hook-feedback banners all carry this phrasing (e.g.
 * "UserPromptSubmit operation blocked by hook: ..."). */
function isHookBlock(content: string): boolean {
  return /blocked by hook/i.test(content)
}

/**
 * Host-persisted warning banner from the agent loop. The load-bearing case is
 * a workspace-authored hook blocking a prompt: the model never saw the
 * message, so without this card the session reads as the agent silently
 * ignoring the user.
 */
export function InformationalItem({ item }: InformationalItemProps) {
  const params = useParams({ strict: false }) as { slug?: string }
  const hookBlock = isHookBlock(item.content)

  return (
    <div
      className="rounded-[12px] border border-amber-300/70 dark:border-amber-700/60 bg-amber-50/60 dark:bg-amber-950/20 p-4"
      data-testid="informational-item"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
          <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">
            {hookBlock ? 'Message blocked by a hook' : 'Agent notice'}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {item.content}
          </p>
          {hookBlock && (
            <p className="mt-2 text-xs text-muted-foreground">
              A hook configured in this agent&apos;s workspace intercepted the message before the
              agent could see it.
              {params.slug && (
                <>
                  {' '}
                  <AppLink
                    to="/agents/$slug"
                    params={{ slug: params.slug }}
                    className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
                  >
                    Review hooks
                    <ArrowUpRight className="h-3 w-3" />
                  </AppLink>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

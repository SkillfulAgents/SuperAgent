import { useMemo } from 'react'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import { resolvePresentationMarkdown } from '@shared/lib/llm-provider/error-presentation'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'

// Fills the presentation's {orgId} link placeholder from the connected platform
// org, or strips the link to plain text when there is no org context.
export function useResolvedErrorPresentation(
  presentation: ProviderErrorPresentation,
): ProviderErrorPresentation {
  const { data: platformAuth } = usePlatformAuthStatus()

  return useMemo(
    () => ({
      ...presentation,
      message: resolvePresentationMarkdown(presentation.message, platformAuth),
    }),
    [platformAuth, presentation],
  )
}

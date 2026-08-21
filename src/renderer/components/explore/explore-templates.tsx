import { useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useDialogs } from '@renderer/context/dialog-context'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * The template roster for every Explore surface, with the one gate they all
 * need.
 *
 * `useDiscoverableAgents` is `enabled: hasSkillsets`, so with no skillset
 * configured it never runs: `isLoading` is false, `data` stays `undefined`
 * forever, and a page that branches on `data === undefined` renders a skeleton
 * that never resolves. Branch on `hasSkillsets` FIRST — that state is an empty
 * state, not a loading one.
 *
 * While the skillset list itself is still loading the answer is unknown, so
 * `hasSkillsets` optimistically reads true and `isLoading` covers the wait —
 * flashing "connect a skillset" at someone who has one is worse than a beat of
 * skeleton.
 */
export function useExploreTemplates(): {
  templates: ApiDiscoverableAgent[]
  hasSkillsets: boolean
  isLoading: boolean
} {
  const { data: skillsets } = useSkillsets()
  const { data: discoverableAgents, isLoading } = useDiscoverableAgents()

  const hasSkillsets = skillsets === undefined || skillsets.length > 0
  return {
    templates: useMemo(() => discoverableAgents ?? [], [discoverableAgents]),
    hasSkillsets,
    isLoading:
      skillsets === undefined || (hasSkillsets && (isLoading || discoverableAgents === undefined)),
  }
}

/** Shown wherever the roster is empty because nothing supplies templates. */
export function NoTemplatesEmptyState() {
  const { openSettings } = useDialogs()
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="explore-empty">
      <p className="text-sm text-muted-foreground">
        No agent templates available. Connect a skillset with agent templates to get started.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => openSettings('skillsets')}>
        Manage skillsets
      </Button>
    </div>
  )
}

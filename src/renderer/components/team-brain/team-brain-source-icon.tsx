import { cn } from '@shared/lib/utils/cn'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { teamBrainSource } from '@renderer/lib/team-brain/team-brain-sources'
import type { TeamBrainSourceId } from '@renderer/lib/team-brain/team-brain-schema'

/** A source's logo, with the dark-mode treatment its mark needs. */
export function TeamBrainSourceIcon({ id, className }: { id: TeamBrainSourceId; className?: string }) {
  const source = teamBrainSource(id)
  return <ServiceIcon slug={source.iconSlug} className={cn(className, source.iconClassName)} />
}

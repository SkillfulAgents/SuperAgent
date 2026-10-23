import { Fragment, useMemo } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import type { TeamBrainSchedule } from '@renderer/lib/team-brain/team-brain-schema'
import type { TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'
import { teamBrainSource } from '@renderer/lib/team-brain/team-brain-sources'
import { TEAM_BRAIN_SYNCS, syncSummaryParts, type TeamBrainSync } from '@renderer/lib/team-brain/team-brain-syncs'
import { formatSyncDay, formatSyncTime, syncTimes } from '@renderer/lib/team-brain/team-brain-format'
import { TeamBrainSourceIcon } from './team-brain-source-icon'
import type { OpenFile } from './team-brain-radial-parts'

type Page = { node: TeamBrainNode; path: string; folder?: TeamBrainNode }

/** Every page in the drive by the path a summary links it with: `Customers/Acme Corp`, no `.md`. */
function pagesByPath(drive: readonly TeamBrainNode[]): Map<string, Page> {
  const pages = new Map<string, Page>()
  const walk = (list: readonly TeamBrainNode[], at: string, folder?: TeamBrainNode) => {
    for (const node of list) {
      const path = `${at}/${node.name}`
      if (node.kind === 'file') pages.set(path.slice(1).replace(/\.md$/, ''), { node, path, folder })
      else walk(node.children ?? [], path, node)
    }
  }
  walk(drive, '')
  return pages
}

const pageCount = (n: number) => `${n} page${n === 1 ? '' : 's'}`

/** "3 pages added, 9 updated", the way a release has its number. */
function countLabel({ added, updated }: TeamBrainSync): string {
  if (added && updated) return `${pageCount(added)} added, ${updated} updated`
  return added ? `${pageCount(added)} added` : `${pageCount(updated)} updated`
}

/**
 * What each sync filed, newest first, laid out like the Gamut changelog: the
 * day on the left, a rule down the middle with a dot per sync (the latest in
 * blue), and on the right what changed: a few sentences on what mattered, then
 * the rest a line each. A page named in one opens in the drawer; one left out
 * of the drive reads as plain text. A line an agent filed itself is credited
 * to an agent that can write to Team Brain, and left out when none can.
 */
export function TeamBrainSyncSummaries({
  drive,
  schedule,
  lastSyncAt,
  writer,
  onOpenFile,
}: {
  drive: readonly TeamBrainNode[]
  schedule: TeamBrainSchedule
  lastSyncAt: string | null
  writer: ApiAgent | null
  onOpenFile: OpenFile
}) {
  const pages = useMemo(() => pagesByPath(drive), [drive])
  const times = syncTimes(schedule, lastSyncAt, TEAM_BRAIN_SYNCS.length)

  const prose = (text: string) =>
    syncSummaryParts(text).map((part, i) => {
      if ('text' in part) return <Fragment key={i}>{part.text}</Fragment>
      if ('agent' in part)
        return (
          writer && (
            <span key={i} className="inline-flex items-baseline gap-1 text-foreground">
              <span className="self-center">
                <AgentAvatar agent={writer} size={14} />
              </span>
              {writer.name}
            </span>
          )
        )
      const name = part.page.split('/').pop()
      const page = pages.get(part.page)
      if (!page) return <span key={i} className="text-foreground">{name}</span>
      return (
        <button
          key={i}
          type="button"
          onClick={() => onOpenFile(page.node, { path: page.path, folder: page.folder })}
          className="rounded-[2px] text-foreground underline decoration-foreground/20 underline-offset-[3px] transition-colors hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`team-brain-sync-page-${page.node.id}`}
          data-drawer-opener
        >
          {name}
        </button>
      )
    })

  return (
    // Narrower than the page, centred under the tree, so the lines stay a comfortable length to read.
    <section aria-labelledby="team-brain-syncs-title" className="mx-auto w-full max-w-[720px]" data-testid="team-brain-syncs">
      <h2 id="team-brain-syncs-title" className="mb-6 text-base font-medium">
        Sync summaries
      </h2>
      <ol>
        {TEAM_BRAIN_SYNCS.map((sync, index) => {
          const at = times[index]
          const day = formatSyncDay(at)
          const time = formatSyncTime(at)
          const changes = sync.changes.filter((line) => writer || !line.includes('{agent}'))
          const from = sync.sources.map((id) => teamBrainSource(id).name).join(', ')
          const last = index === TEAM_BRAIN_SYNCS.length - 1
          return (
            <li key={sync.id} className="md:grid md:grid-cols-[8rem_1fr] md:gap-x-8" data-testid={`team-brain-sync-${sync.id}`}>
              <div className="md:sticky md:top-6 md:self-start">
                <time dateTime={at.toISOString()} className="hidden text-sm tabular-nums text-muted-foreground md:block">
                  {day}
                  <span className="block text-xs">{time}</span>
                </time>
              </div>
              <div className={cn('relative md:border-l md:border-black/[0.07] md:pl-8 md:dark:border-white/10', last ? 'pb-2' : 'pb-12')}>
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute -left-[4.5px] top-[7px] hidden size-2 rounded-full ring-4 ring-background md:block',
                    index === 0 ? 'bg-[#0099ff]' : 'bg-foreground',
                  )}
                />
                <header className="flex flex-wrap items-center gap-2.5">
                  <h3 className="text-base font-normal tracking-[-0.0075em]">{countLabel(sync)}</h3>
                  {index === 0 && (
                    <span className="rounded-[7px] bg-[#e5f4ff] px-1.5 py-0.5 text-xs font-medium text-[#006bb8] dark:bg-sky-500/15 dark:text-sky-300">
                      Latest
                    </span>
                  )}
                  <span className="flex items-center gap-1" role="img" aria-label={`From ${from}`} title={`From ${from}`}>
                    {sync.sources.map((id) => (
                      <TeamBrainSourceIcon key={id} id={id} className="size-3.5" />
                    ))}
                  </span>
                </header>
                <time dateTime={at.toISOString()} className="mt-0.5 block text-xs tabular-nums text-muted-foreground md:hidden">
                  {day} · {time}
                </time>
                <div className="mt-3 max-w-2xl">
                  {sync.highlights.map((highlight) => (
                    <Fragment key={highlight.title}>
                      <h4 className="mb-1 mt-5 text-[15px] font-normal tracking-[-0.0075em] first:mt-0">{highlight.title}</h4>
                      <p className="text-sm/6 text-muted-foreground">{prose(highlight.body)}</p>
                    </Fragment>
                  ))}
                  {changes.length > 0 && (
                    <>
                      {sync.highlights.length > 0 && <h4 className="mb-1.5 mt-5 text-[15px] font-normal tracking-[-0.0075em]">Also filed</h4>}
                      <ul className="list-disc space-y-1 pl-5 text-sm/6 text-muted-foreground marker:text-muted-foreground/50">
                        {changes.map((line) => (
                          <li key={line}>{prose(line)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

import { Fragment } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { syncSummaryParts, type TeamBrainSync } from '@renderer/lib/team-brain/team-brain-syncs'
import { formatSyncDay, formatSyncTime, syncCountLabel } from '@renderer/lib/team-brain/team-brain-format'
import { openExternalUrl } from '@renderer/lib/open-external'
import type { OpenFile } from './team-brain-radial-parts'


/**
 * What each sync filed, newest first, laid out like the Gamut changelog: the
 * day on the left, a rule down the middle with a dot per sync (the latest in
 * blue), and on the right what changed: a few sentences on what mattered, then
 * the rest a line each. A page named in one opens from the drive in the
 * drawer. The latest also lists what needs a person, since only the latest
 * run says what is still open. Its title opens the run's session.
 */
export function TeamBrainSyncSummaries({
  syncs,
  unreadable = false,
  onOpenFile,
  onOpenSession,
}: {
  syncs: readonly TeamBrainSync[]
  /** The summaries' folder couldn't be read, so none showing doesn't mean none ran. */
  unreadable?: boolean
  onOpenFile: OpenFile
  /** Opens the session a sync ran in; without it, a sync's title is plain. */
  onOpenSession?: (sessionId: string) => void
}) {

  // A page opens from the drive in the drawer, a web link in the browser.
  const prose = (text: string, summary: string) =>
    syncSummaryParts(text, summary.slice(0, summary.lastIndexOf('/'))).map((part, i) => {
      if ('text' in part) return <Fragment key={i}>{part.text}</Fragment>
      const page = 'page' in part ? part.page : null
      return (
        <button
          key={i}
          type="button"
          onClick={() =>
            page
              ? onOpenFile({ id: page, name: page.slice(page.lastIndexOf('/') + 1), kind: 'file', sources: [] }, { path: `/${page}` })
              : 'url' in part && void openExternalUrl(part.url)
          }
          className="rounded-[2px] text-foreground underline decoration-foreground/20 underline-offset-[3px] transition-colors hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={page ? `team-brain-sync-page-${page}` : undefined}
          data-drawer-opener={page ? true : undefined}
        >
          {part.label}
        </button>
      )
    })

  return (
    // Narrower than the page, centred under the tree, so the lines stay a comfortable length to read.
    <section aria-labelledby="team-brain-syncs-title" className="mx-auto w-full max-w-[720px]" data-testid="team-brain-syncs">
      <h2 id="team-brain-syncs-title" className="mb-6 text-base font-medium">
        Sync summaries
      </h2>
      {syncs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {unreadable ? "Couldn't read the sync summaries. They show here once the drive can be read." : 'No syncs yet. Each upkeep run sums up what it filed here.'}
        </p>
      )}
      <ol>
        {syncs.map((sync, index) => {
          const at = new Date(sync.at)
          const day = formatSyncDay(at)
          const time = formatSyncTime(at)
          const { changes } = sync
          const from = sync.sources.join(', ')
          const last = index === syncs.length - 1
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
                  <h3 className="text-base font-normal tracking-[-0.0075em]">
                    {sync.session && onOpenSession ? (
                      <button
                        type="button"
                        onClick={() => sync.session && onOpenSession?.(sync.session)}
                        className="rounded-[2px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`team-brain-sync-session-${sync.id}`}
                      >
                        {syncCountLabel(sync)}
                      </button>
                    ) : (
                      syncCountLabel(sync)
                    )}
                  </h3>
                  {index === 0 && (
                    <span className="rounded-[7px] bg-[#e5f4ff] px-1.5 py-0.5 text-xs font-medium text-[#006bb8] dark:bg-sky-500/15 dark:text-sky-300">
                      Latest
                    </span>
                  )}
                  <span className="flex items-center gap-1" role="img" aria-label={`From ${from}`} title={`From ${from}`}>
                    {sync.sources.map((id) => (
                      <ServiceIcon key={id} slug={id} className="size-3.5" />
                    ))}
                  </span>
                </header>
                <time dateTime={at.toISOString()} className="mt-0.5 block text-xs tabular-nums text-muted-foreground md:hidden">
                  {day} · {time}
                </time>
                {/* A long link or path breaks rather than running out of the column. */}
                <div className="mt-3 max-w-2xl [overflow-wrap:anywhere]">
                  {sync.highlights.map((highlight, i) => (
                    <Fragment key={i}>
                      <h4 className="mb-1 mt-5 text-[15px] font-normal tracking-[-0.0075em] first:mt-0">{highlight.title}</h4>
                      <p className="text-sm/6 text-muted-foreground">{prose(highlight.body, sync.id)}</p>
                    </Fragment>
                  ))}
                  {changes.length > 0 && (
                    <>
                      {sync.highlights.length > 0 && <h4 className="mb-1.5 mt-5 text-[15px] font-normal tracking-[-0.0075em]">Also filed</h4>}
                      <ul className="list-disc space-y-1 pl-5 text-sm/6 text-muted-foreground marker:text-muted-foreground/50">
                        {changes.map((line, i) => (
                          <li key={i}>{prose(line, sync.id)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {index === 0 && sync.needsYou.blocked.length + sync.needsYou.toDecide.length > 0 && (
                    <div data-testid="team-brain-sync-needs-you">
                      <h4 className="mb-1.5 mt-5 text-[15px] font-normal tracking-[-0.0075em]">Needs you</h4>
                      {(
                        [
                          ['Blocked', sync.needsYou.blocked],
                          ['To decide', sync.needsYou.toDecide],
                        ] as const
                      ).map(
                        ([label, items]) =>
                          items.length > 0 && (
                            <Fragment key={label}>
                              <p className="mt-3 text-xs font-medium text-muted-foreground first:mt-0">{label}</p>
                              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm/6 text-muted-foreground marker:text-muted-foreground/50">
                                {items.map((line, i) => (
                                  <li key={i}>{prose(line, sync.id)}</li>
                                ))}
                              </ul>
                            </Fragment>
                          ),
                      )}
                    </div>
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

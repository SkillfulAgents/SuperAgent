import { Fragment, useMemo, useRef, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { useCommentBox } from '@renderer/components/file-preview/comments/use-comment-box'
import { sendComments } from '@renderer/components/file-preview/comments/comment-bar'
import { agentHomeId, useDraftsStore } from '@renderer/context/drafts-context'
import { rehypeCommentLines } from '@renderer/lib/rehype-comment-lines'
import { summaryLink, type TeamBrainSync } from '@renderer/lib/team-brain/team-brain-syncs'
import { formatSyncDay, formatSyncTime, syncCountLabel } from '@renderer/lib/team-brain/team-brain-format'
import type { OpenFile } from './team-brain-radial-parts'


/**
 * What each sync filed, newest first, laid out like the Gamut changelog: the
 * day on the left, a rule down the middle with a dot per sync (the latest in
 * blue), and on the right what changed: a few sentences on what mattered, then
 * the rest a line each, drawn as agent text is everywhere else. A page named
 * in one opens from the drive in the drawer. The latest also lists what needs
 * a person, since only the latest run says what is still open. Its title opens
 * the run's session. Text in a summary takes a comment, as a file in the
 * drawer does, which goes straight to the composer.
 */
export function TeamBrainSyncSummaries({
  syncs,
  unreadable = false,
  agentSlug,
  onOpenFile,
  onOpenSession,
}: {
  syncs: readonly TeamBrainSync[]
  /** The summaries' folder couldn't be read, so none showing doesn't mean none ran. */
  unreadable?: boolean
  /** The Team Brain agent's. */
  agentSlug: string
  onOpenFile: OpenFile
  onOpenSession: (sessionId: string) => void
}) {

  // A page opens from the drive in the drawer. Any other link keeps the shared link policy.
  const prose = (markdown: string, summary: string) => (
    <div className="prose prose-sm max-w-none text-sm/6 text-muted-foreground marker:text-muted-foreground/50 dark:prose-invert prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-1 [&_[data-comment-lines]]:relative [&_p+p]:mt-2">
      <AgentMarkdown
        text={markdown}
        mode="settled"
        rehypePlugins={REHYPE_PLUGINS}
        link={(href, children) => {
          const to = summaryLink(href, summary.slice(0, summary.lastIndexOf('/')))
          if (to === 'web') return null
          if (to === 'text') return <>{children}</>
          const { page } = to
          return (
            // A link, not a button: a button never wraps, so text after it at the end of a line drops to its own line.
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault()
                onOpenFile({ id: page, name: page.slice(page.lastIndexOf('/') + 1), kind: 'file', sources: [] }, { path: `/${page}` })
              }}
              // A middle click would open the relative href in the browser.
              onAuxClick={(event) => event.preventDefault()}
              className="rounded-[2px] font-normal text-foreground underline decoration-foreground/20 underline-offset-[3px] transition-colors hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`team-brain-sync-page-${page}`}
              data-drawer-opener
            >
              {children}
            </a>
          )
        }}
      />
    </div>
  )

  return (
    // Narrower than the page, centred under the tree, so the lines stay a comfortable length to read.
    <section aria-labelledby="team-brain-syncs-title" className="mx-auto w-full max-w-[720px]" data-testid="team-brain-syncs">
      <h2 id="team-brain-syncs-title" className="mb-6 text-sm font-normal text-muted-foreground">
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
            <SummaryComments key={sync.id} sync={sync} agentSlug={agentSlug} className="md:grid md:grid-cols-[8rem_1fr] md:gap-x-8">
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
                    {sync.session ? (
                      <button
                        type="button"
                        onClick={() => sync.session && onOpenSession(sync.session)}
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
                      <h4 className="relative mb-1 mt-5 text-[15px] font-normal tracking-[-0.0075em] first:mt-0" data-comment-lines={`${highlight.line}-${highlight.line}`}>
                        {/* Its own node, so a new title doesn't overwrite a comment pin drawn in the heading. */}
                        <span>{highlight.title}</span>
                      </h4>
                      {prose(highlight.body, sync.id)}
                    </Fragment>
                  ))}
                  {changes.length > 0 && (
                    <>
                      {sync.highlights.length > 0 && <h4 className="mb-1.5 mt-5 text-[15px] font-normal tracking-[-0.0075em]">Also filed</h4>}
                      {prose(changes, sync.id)}
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
                              <div className="mt-1">{prose(items, sync.id)}</div>
                            </Fragment>
                          ),
                      )}
                    </div>
                  )}
                </div>
              </div>
            </SummaryComments>
          )
        })}
      </ol>
    </section>
  )
}

const REHYPE_PLUGINS = [rehypeCommentLines]

/**
 * A summary's entry as its file's viewer: its parts are on their lines in the file, so a comment takes text selected in
 * the entry, or the line under the mouse, as in the drawer, and goes straight to the composer. Never the whole file: the
 * page shows several.
 */
function SummaryComments({ sync, agentSlug, className, children }: { sync: TeamBrainSync; agentSlug: string; className: string; children: ReactNode }) {
  const containerRef = useRef<HTMLLIElement>(null)
  const draftsStore = useDraftsStore()
  // A new read replaces the blocks, so markers and highlights re-read them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const surface = useMemo(() => ({ text: { blocks: containerRef }, file: null }), [sync])
  const { box } = useCommentBox(containerRef, surface, sync.id, agentSlug, (comment) => sendComments(draftsStore, agentHomeId(agentSlug), sync.id, [comment]))
  return (
    // Selectable whole, date and headings too: the app turns selection off element by element, as for `.prose *`.
    <li ref={containerRef} className={cn('relative select-text [&_*]:select-text', className)} data-testid={`team-brain-sync-${sync.id}`}>
      {children}
      {box}
    </li>
  )
}

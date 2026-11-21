import { useMemo } from 'react'
import { ArrowUp, SquareArrowRight, Gauge, Play, SquareTerminal } from 'lucide-react'
import { TRAY_BODY_CLASS } from './tray-card'
import { collectSessionFiles } from './session-files'
import { subagentCalls } from './subagents-tray-content'
import { collectBackgroundTasks } from './background-tasks'
import { collectAgentCalls } from './agent-calls'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { useMessages } from '@renderer/hooks/use-messages'
import { describeWorkspaceFile } from '@renderer/lib/workspace-file'
import { SubagentAvatar } from '@renderer/components/agents/agent-avatar/subagent-avatar'

interface TrayEmptyStateProps {
  agentSlug: string
  sessionId: string
  /** Open one of the session's files. */
  onOpenFile: (filePath: string, description?: string) => void
  onOpenSubagents: () => void
  onOpenContext: () => void
  onOpenBackground: () => void
  /** Open the sessions this one called on other agents. */
  onOpenAgentSessions: () => void
}

const CARD = 'flex flex-col items-start gap-3 rounded-card bg-muted/60 p-4 text-left text-sm text-foreground transition-colors hover:bg-muted'

/**
 * A New tab: what a person can open themselves without waiting for the agent
 * (the context window, the subagents, background tasks, the agents it called),
 * then the session's files.
 */
export function TrayEmptyState({ agentSlug, sessionId, onOpenFile, onOpenSubagents, onOpenContext, onOpenBackground, onOpenAgentSessions }: TrayEmptyStateProps) {
  const { data: messages } = useMessages(sessionId, agentSlug)
  const { backgroundTasks } = useMessageStream(sessionId, agentSlug, ['backgroundTasks'])
  // How many of each the session has had, for a quiet count on its tile.
  const counts = useMemo(() => ({
    subagents: subagentCalls(messages).length,
    background: collectBackgroundTasks(messages, backgroundTasks ?? []).length,
    invoked: collectAgentCalls(messages, agentSlug).filter(call => call.sessionId).length,
  }), [messages, backgroundTasks, agentSlug])
  // Pictures and videos show as thumbnails; everything else as a named row.
  const { media, others } = useMemo(() => {
    const described = collectSessionFiles(messages).map(entry => ({ entry, file: describeWorkspaceFile(entry.filePath, agentSlug) }))
    const isMedia = ({ file }: (typeof described)[number]) => (file.isImage || file.preview === 'video') && !!file.inlineUrl
    return { media: described.filter(isMedia), others: described.filter(item => !isMedia(item)) }
  }, [messages, agentSlug])
  return (
    <div className={TRAY_BODY_CLASS} data-testid="tray-new-tab-body">
      {/* The drawer's own width, less a 32px gutter: capped only so a full-screen drawer keeps tiles and thumbnails
          a readable size. */}
      <div className="flex flex-1 min-h-0 flex-col overflow-auto px-8">
        <div className="mx-auto w-full max-w-xl pb-10 pt-6">
          <h2 className="text-xs text-muted-foreground">Session utilities</h2>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" className={CARD} onClick={onOpenContext} data-testid="tray-empty-context">
              <Gauge className="h-4 w-4 text-muted-foreground" />
              Context
            </button>
            <button type="button" className={CARD} onClick={onOpenSubagents} data-testid="tray-empty-subagents">
              <SubagentAvatar size={16} />
              <TileLabel count={counts.subagents}>Subagents</TileLabel>
            </button>
            <button type="button" className={CARD} onClick={onOpenBackground} data-testid="tray-empty-background">
              <SquareTerminal className="h-4 w-4 text-muted-foreground" />
              <TileLabel count={counts.background}>Background tasks</TileLabel>
            </button>
            <button type="button" className={CARD} onClick={onOpenAgentSessions} data-testid="tray-empty-agent-sessions">
              <SquareArrowRight className="h-4 w-4 text-muted-foreground" />
              <TileLabel count={counts.invoked}>Invoked agents</TileLabel>
            </button>
          </div>
          {(media.length > 0 || others.length > 0) && (
            <h2 className="mt-10 text-xs text-muted-foreground" data-testid="tray-session-assets">Session files</h2>
          )}
          {media.length > 0 && (
            <section className="mt-3" aria-label="Images and videos" data-testid="tray-session-media">
              <ul className="grid grid-cols-4 gap-2">
                {media.map(({ entry, file }) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => onOpenFile(entry.filePath, entry.description)}
                      title={entry.uploaded ? `${file.relativePath} · Uploaded by you` : file.relativePath}
                      aria-label={entry.uploaded ? `${file.name}, uploaded by you` : file.name}
                      className="group relative block aspect-square w-full overflow-hidden rounded-item border border-black/5 bg-muted/60 dark:border-white/5"
                      data-testid="tray-session-thumbnail"
                    >
                      {file.preview === 'video' ? (
                        <>
                          {/* The first frame, fetched without playing: metadata only, muted. */}
                          <video src={file.inlineUrl ?? undefined} preload="metadata" muted playsInline className="h-full w-full object-cover" />
                          <span className="absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white">
                            <Play className="h-2.5 w-2.5 fill-current" />
                          </span>
                        </>
                      ) : (
                        <img src={file.inlineUrl ?? undefined} alt="" loading="lazy" className="h-full w-full object-cover" />
                      )}
                      <span className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
                      {entry.uploaded && (
                        // Yours, not the agent's: said on hover only, so the grid stays pictures and nothing on it
                        // looks like a button.
                        <span
                          className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-4 text-left text-[11px] leading-tight text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                          data-testid="tray-session-uploaded"
                        >
                          <ArrowUp className="h-3 w-3 shrink-0" />
                          Uploaded
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {others.length > 0 && (
            <section className={media.length > 0 ? 'mt-5' : 'mt-3'} aria-label="Files" data-testid="tray-session-files">
              <ul className="-mx-2">
                {others.map(({ entry, file }) => {
                  const folder = file.relativePath.includes('/') ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : null
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        onClick={() => onOpenFile(entry.filePath, entry.description)}
                        title={file.relativePath}
                        className="flex w-full items-center gap-2.5 rounded-item px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60"
                        data-testid="tray-session-file"
                      >
                        <FileTypeIcon filename={file.name} size="sm" />
                        <span className="min-w-0 truncate">{file.name}</span>
                        {folder && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{folder}</span>}
                        {entry.uploaded && (
                          <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[11px] text-muted-foreground" data-testid="tray-session-uploaded">
                            You
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

/** A tile's name, with how many the session has had after it: low-key, and only once there is one. */
function TileLabel({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5">
      {children}
      {count > 0 && <span className="text-xs tabular-nums text-muted-foreground/60" data-testid="tray-tile-count">{count}</span>}
    </span>
  )
}

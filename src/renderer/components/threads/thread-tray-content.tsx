import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Forward, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@shared/lib/utils/cn'
import type { ApiMessage } from '@shared/lib/types/api'
import type { Mention } from '@shared/lib/utils/mentions'
import { parseUserMessageParts } from '@shared/lib/utils/user-message-parts'
import { THREAD_REPLY_MAX, type ThreadPerson } from '@shared/lib/session-threads/thread-schema'
import { formatThreadForAgent } from '@shared/lib/session-threads/thread-share'
import { MarkdownBlock, PROSE_CLASS } from '@renderer/components/messages/message-item'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { fillSessionComposer } from '@renderer/components/messages/composer-focus'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ComposerActionButton } from '@renderer/components/messages/composer-action-button'
import { SentAttachmentChip } from '@renderer/components/messages/sent-attachment-chip'
import { AttachedImages } from '@renderer/components/messages/attached-images'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { isPreviewableImage } from '@renderer/lib/file-types'
import { useThreadReplyAttachments } from '@renderer/hooks/use-thread-reply-attachments'
import { formatMessageTimeExact, formatShortAgo } from '@renderer/lib/message-time'
import { appendAttachedFiles, parseAttachedFiles } from '@shared/lib/utils/attached-files'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { useOptionalThread } from '@renderer/context/thread-context'
import { useSendThreadReply, useThreadReplies } from '@renderer/hooks/use-session-threads'

interface ThreadTrayContentProps {
  agentSlug: string
  sessionId: string
  onClose: () => void
}

const NO_MENTIONS: readonly Mention[] = []
const NO_FILES: readonly string[] = []
const ignore = () => {}
const UNKNOWN_PERSON: ThreadPerson = { id: 'unknown', name: 'Former member' }

function ThreadEntry({ person, createdAt, text, files = NO_FILES, mentions = NO_MENTIONS, agentSlug, testId }: {
  person: ThreadPerson
  createdAt: Date | string
  text: string
  /** Workspace paths it was sent with, drawn as a message bubble draws them. */
  files?: readonly string[]
  mentions?: readonly Mention[]
  agentSlug: string
  testId: string
}) {
  const at = new Date(createdAt)
  const fileChips = files.filter((path) => !isPreviewableImage(path))
  const images = files.filter(isPreviewableImage)
  return (
    <div className="flex gap-2.5 px-4 py-2" data-testid={testId}>
      <UserAvatar user={person} size={28} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{person.name}</span>
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={at.toISOString()} title={formatMessageTimeExact(at)}>
            {formatShortAgo(at)}
          </time>
        </div>
        {text && (
          <div dir="auto" className={PROSE_CLASS}>
            <MarkdownBlock text={text} agentSlug={agentSlug} mentions={mentions} />
          </div>
        )}
        {fileChips.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2" data-testid="thread-files">
            {/* Keyed by position too: the same file can be attached twice. */}
            {fileChips.map((path, index) => (
              <SentAttachmentChip key={`${path}#${index}`} filePath={path} agentSlug={agentSlug} />
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="mt-1.5">
            <AttachedImages
              images={images.map((path, index) => ({ key: `${path}#${index}`, filePath: path }))}
              agentSlug={agentSlug}
              align="start"
              data-testid="thread-images"
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** How soon the header buttons name themselves on hover. */
const HEADER_TOOLTIP_DELAY_MS = 150

/**
 * A 28px icon button in the drawer header, named by a tooltip that shows
 * quickly. The trigger is a span so a disabled button still explains itself
 * (a disabled button gets no pointer events).
 */
function HeaderIconButton({ icon, label, tooltip = label, onClick, disabled = false, testId }: {
  icon: ReactNode
  label: string
  /** When it differs from the label, e.g. why it is disabled. */
  tooltip?: string
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon={icon}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className="w-7 px-0 text-muted-foreground"
            data-testid={testId}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** A reply's typed text and the files it carries, from the attached-files block it ends with. */
function replyParts(text: string) {
  const { cleanText, attachedFiles } = parseAttachedFiles(text)
  return { text: cleanText, files: attachedFiles }
}

/**
 * The thread drawer, as Slack's thread pane: the message the thread is on,
 * its replies, and a reply box. Replies stay out of the agent's transcript;
 * "Send thread to agent" (in its header) puts the whole thread in the session
 * composer, to send as one message.
 */
export function ThreadTrayContent({ agentSlug, sessionId, onClose }: ThreadTrayContentProps) {
  const thread = useOptionalThread()
  const parent = thread?.parent ?? null
  if (!parent) return null
  return <ThreadPane key={parent.id} parent={parent} agentSlug={agentSlug} sessionId={sessionId} onClose={onClose} openCount={thread?.openCount ?? 0} canReply={thread?.canReply ?? false} />
}

function ThreadPane({ parent, agentSlug, sessionId, onClose, openCount, canReply }: ThreadTrayContentProps & { parent: ApiMessage; openCount: number; canReply: boolean }) {
  const parts = useMemo(() => parseUserMessageParts(parent.content.text), [parent.content.text])
  const parentPerson: ThreadPerson = parent.sender ?? (parts.sender ? { id: parts.sender, name: parts.sender } : UNKNOWN_PERSON)
  const taggedUserIds = useMemo(
    () => parts.mentions.flatMap((mention) => (mention.kind === 'user' ? [mention.id] : [])),
    [parts.mentions],
  )

  const repliesQuery = useThreadReplies(agentSlug, sessionId, parent.id)
  const replies = useMemo(() => repliesQuery.data ?? [], [repliesQuery.data])
  const sendReply = useSendThreadReply(agentSlug, sessionId)

  const [draft, setDraft] = useState('')
  const files = useThreadReplyAttachments(agentSlug, sessionId)
  const [scrolled, setScrolled] = useState(false)
  const inputRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Held at the bottom, as a chat is, until the person scrolls up. Opening a
  // thread, and sending a reply, hold it there again. While held, anything
  // that grows the thread (replies loading, images, the drawer sliding open
  // and rewrapping the text) keeps the bottom in view.
  const pinnedRef = useRef(true)
  const scrollToEnd = useCallback(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [])
  const pinToEnd = useCallback(() => {
    pinnedRef.current = true
    scrollToEnd()
  }, [scrollToEnd])

  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToEnd()
    })
    observer.observe(scroller)
    observer.observe(content)
    return () => observer.disconnect()
  }, [scrollToEnd])

  // A click anywhere outside the drawer closes it, as a popover does. Not
  // outside: the drawer's own edges, the menus and dialogs it opens (portalled
  // out of it), toasts, and the buttons that open a thread (they switch it).
  const rootRef = useRef<HTMLDivElement>(null)
  // On the click, not the press: closing reflows the page, and on the press it
  // would move what was clicked (the session's Send) out from under it.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (rootRef.current?.closest('[data-tray-drawer]')?.contains(target)) return
      if (target.closest('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [data-sonner-toaster], [data-opens-thread]')) return
      onClose()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [onClose])

  // Opening (or re-opening) a thread shows its latest reply and puts the
  // cursor in its reply box, without the focus scrolling the drawer.
  useEffect(() => {
    pinToEnd()
    inputRef.current?.focus({ preventScroll: true })
  }, [openCount, pinToEnd])

  const text = draft.trim()
  // A reply can be just files; Send waits for their uploads, as the session composer does.
  const hasContent = text.length > 0 || files.attachments.length > 0
  const canSend = hasContent && text.length <= THREAD_REPLY_MAX && !files.uploading && !files.failed && !sendReply.isPending

  const send = () => {
    if (!canSend) return
    sendReply.mutate(
      { parentMessageUuid: parent.id, text: appendAttachedFiles(text, files.uploadedPaths()), taggedUserIds },
      {
        onSuccess: () => {
          pinToEnd()
          setDraft('')
          files.clearAttachments()
        },
        onError: () => toast.error('Your reply was not sent. Try again.'),
      },
    )
  }

  // Enter sends, as in the session composer; on touch it is a new line and
  // the send button sends, so autocorrect's Return never fires a reply.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    if (window.matchMedia?.('(pointer: coarse)').matches) return
    event.preventDefault()
    send()
  }

  const share = () => {
    const content = formatThreadForAgent(
      { name: parentPerson.name, text: parts.text, files: parts.attachedFiles },
      replies.map((reply) => ({ name: (reply.sender ?? UNKNOWN_PERSON).name, ...replyParts(reply.text) })),
    )
    // Into the session composer, after anything already typed, to edit and
    // send from there: nothing reaches the agent until the person sends it.
    if (!fillSessionComposer(sessionId, content)) toast.error('Open the session to send the thread to the agent.')
  }

  const replyCount = replies.length
  return (
    <div ref={rootRef} className="contents" data-testid="thread-tray">
      <div
        className={cn(
          'flex shrink-0 select-none items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground transition-colors',
          // A rule under the header only once the thread scrolls beneath it.
          scrolled ? 'border-border/40' : 'border-transparent',
        )}
      >
        <span className="flex-1 truncate text-sm font-medium text-foreground">Thread</span>
        <TooltipProvider delayDuration={HEADER_TOOLTIP_DELAY_MS}>
          <div className="flex items-center gap-0.5">
            {canReply && (
              <HeaderIconButton
                icon={<Forward />}
                label="Send thread to agent"
                tooltip={replyCount === 0 ? 'Reply first, then send the thread to the agent' : 'Send thread to agent'}
                onClick={share}
                disabled={replyCount === 0}
                testId="thread-share-with-agent"
              />
            )}
            <HeaderIconButton icon={<X />} label="Close thread" onClick={onClose} />
          </div>
        </TooltipProvider>
      </div>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto pt-2"
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
          setScrolled(scrollTop > 0)
          pinnedRef.current = scrollHeight - scrollTop - clientHeight < 8
        }}
      >
        <div ref={contentRef}>
          <ThreadEntry
            person={parentPerson}
            createdAt={parent.createdAt}
            text={parts.text}
            files={parts.attachedFiles}
            mentions={parts.mentions}
            agentSlug={agentSlug}
            testId="thread-parent"
          />

          {replies.map((reply) => {
            const { text: replyText, files: replyFiles } = replyParts(reply.text)
            return (
              <ThreadEntry
                key={reply.id}
                person={reply.sender ?? UNKNOWN_PERSON}
                createdAt={reply.createdAt}
                text={replyText}
                files={replyFiles}
                agentSlug={agentSlug}
                testId="thread-reply"
              />
            )
          })}

          {/* The reply box follows the last reply, as in Slack, and scrolls
              with the thread rather than pinning to the drawer's foot. */}
          {canReply && (
            <div className="px-3 pb-3 pt-2">
              {/* The session composer's box and send button, without its
                  attachments, model picker or voice: a reply is text. */}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  send()
                }}
                className={cn(files.isDragOver && 'rounded-xl ring-2 ring-inset ring-primary')}
                {...files.dragHandlers}
              >
                <ChatComposerBox
                  attachments={files.attachments}
                  onRemoveAttachment={files.removeAttachment}
                  onRetryAttachment={files.retryAttachment}
                  textareaRef={inputRef}
                  value={draft}
                  onChange={setDraft}
                  onKeyDown={onKeyDown}
                  placeholder="Reply…"
                  rows={2}
                  autoFocus
                  enterKeyHint="send"
                  dataTestId="thread-reply-input"
                  // Tighter than the session composer: it sits in a narrow drawer.
                  className="rounded-xl px-2 py-2"
                  textareaClassName="max-h-40"
                  leftActions={(
                    <AttachmentPicker
                      onFileSelect={files.handleFileSelect}
                      onFolderSelect={files.handleFolderSelect}
                      onRecentFileAttach={(file) => files.addFiles([{ file }])}
                      popoverAlign="start"
                      buttonClassName="h-7 w-7 shrink-0 p-0 [&_svg]:size-3.5"
                    />
                  )}
                  rightActions={(
                    <ComposerActionButton
                      isActive={false}
                      isWaitingBackground={false}
                      canSubmit={canSend}
                      isSending={sendReply.isPending || files.uploading}
                      isInterrupting={false}
                      onInterrupt={ignore}
                      compact
                    />
                  )}
                />
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useLayoutEffect, useRef } from 'react'
import type { VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'
import { cn } from '@shared/lib/utils'

const TRANSCRIPT_MASK = 'linear-gradient(to bottom, transparent 0, black 40px, black calc(100% - 44px), transparent 100%)'
/** Within this many pixels of the bottom counts as reading the latest words. */
const FOLLOW_SLACK_PX = 24

/**
 * The spoken conversation, following new words at the bottom. It scrolls:
 * scrolling up to reread something earlier holds the view there, and
 * scrolling back to the bottom resumes following.
 */
export function VoiceConversationPreview({ transcript, agentName = 'Agent' }: { transcript: VoiceTranscriptEntry[]; agentName?: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  // Whether the person is at the bottom (following) or has scrolled up to read.
  const following = useRef(true)

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const followLatest = () => { if (following.current) element.scrollTop = element.scrollHeight }
    followLatest()
    const observer = new ResizeObserver(followLatest)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = viewport.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [transcript])

  return (
    <div
      ref={viewport}
      className="h-full overflow-y-auto break-words text-sm leading-5 text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      // Older lines fade out at the top as they scroll away, and new words
      // come in through a fade at the bottom. The newest line rests on
      // padding that keeps it in the upper, legible part of that fade.
      style={{ maskImage: TRANSCRIPT_MASK, WebkitMaskImage: TRANSCRIPT_MASK }}
      onScroll={(event) => {
        const el = event.currentTarget
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
      }}
      data-testid="voice-mode-transcript"
      role="log"
      aria-label="Voice conversation"
      aria-live="polite"
      aria-relevant="additions text"
    >
      <div className="pb-6 pt-6">
        {/* Your words sit left, the agent's right, so the two voices read apart at a glance. */}
        {transcript.map(({ role, text }, index) => (
          <div key={index} data-speaker={role} className={cn(index > 0 && 'mt-1.5', role === 'assistant' && 'text-right')}>
            {/* The speaker on its own line, lightly: the words carry the weight. */}
            <span className="block text-xs text-muted-foreground/60">{role === 'user' ? 'You' : agentName}</span>
            <span className="block">{text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

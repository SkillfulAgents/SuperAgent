import { useLayoutEffect, useRef } from 'react'
import type { VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'

/** Two lines of the latest spoken conversation, following new words at the bottom. */
export function VoiceConversationPreview({ transcript }: { transcript: VoiceTranscriptEntry[] }) {
  const viewport = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const followLatest = () => { element.scrollTop = element.scrollHeight }
    followLatest()
    const observer = new ResizeObserver(followLatest)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = viewport.current
    if (element) element.scrollTop = element.scrollHeight
  }, [transcript])

  return (
    <div
      ref={viewport}
      className="mx-auto h-10 max-w-md overflow-hidden break-words px-2 text-center text-sm leading-5"
      data-testid="voice-mode-transcript"
      role="log"
      aria-label="Voice conversation"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {transcript.map(({ role, text }, index) => (
        <span
          key={index}
          data-speaker={role}
          className={role === 'user' ? 'block text-sky-700 dark:text-sky-300' : 'block text-orange-700 dark:text-orange-300'}
        >
          <span className="font-medium">{role === 'user' ? 'You: ' : 'Agent: '}</span>
          {text}
        </span>
      ))}
    </div>
  )
}

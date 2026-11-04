import { useCallback, useEffect, useRef } from 'react'
import { apiFetch } from '@renderer/lib/api'
import type { VoiceTranscriptEntry } from '@shared/lib/voice/conversation-types'

/** How often the page hands the host the call's speech. */
export const SPEECH_RELAY_INTERVAL_MS = 1000
/** Pieces per request; speech that piled up while the host was away goes in several. */
export const SPEECH_PIECES_PER_REQUEST = 500

interface SpeechPiece extends VoiceTranscriptEntry { at: number }

/**
 * Hands the host every piece of the call's speech the voice engine
 * transcribes: what the room said and what the bot said aloud, stamped with
 * when it was heard, so the host can keep the meeting's transcript file.
 * Pieces go in order, about once a second. A batch the host could not be
 * reached for is sent again; one it refused is dropped.
 */
export function useMeetingSpeechRelay(meetingId: string, token: string): (piece: VoiceTranscriptEntry) => void {
  const pending = useRef<SpeechPiece[]>([])
  useEffect(() => {
    let sending = false
    // `last`: the page is going away (the call ended), so the request must outlive it.
    const send = async (last = false) => {
      if (sending || pending.current.length === 0) return
      sending = true
      const pieces = pending.current.slice(0, SPEECH_PIECES_PER_REQUEST)
      try {
        const response = await apiFetch(`/api/meeting-participant/${encodeURIComponent(meetingId)}/speech?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: last,
          body: JSON.stringify({ sentAt: Date.now(), pieces }),
        })
        if (response.status < 500) pending.current.splice(0, pieces.length)
      } catch {
        // The host is unreachable for now; the pieces wait for the next send.
      } finally {
        sending = false
      }
    }
    const timer = setInterval(() => { void send() }, SPEECH_RELAY_INTERVAL_MS)
    return () => { clearInterval(timer); void send(true) }
  }, [meetingId, token])
  return useCallback((piece: VoiceTranscriptEntry) => { pending.current.push({ at: Date.now(), role: piece.role, text: piece.text }) }, [])
}

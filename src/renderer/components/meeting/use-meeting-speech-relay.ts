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
 * reached for is sent again; one it refused is dropped. When the page goes
 * away (closed, or the call page unmounted), whatever no request carries yet
 * goes in one last request that outlives the page.
 */
export function useMeetingSpeechRelay(meetingId: string, token: string): (piece: VoiceTranscriptEntry) => void {
  const pending = useRef<SpeechPiece[]>([])
  useEffect(() => {
    // Pieces a request is carrying now; they stay pending until it succeeds.
    const inFlight = new Set<SpeechPiece>()
    const send = async (last = false) => {
      // One regular request at a time keeps the pieces in order; the last one goes regardless.
      if (!last && inFlight.size > 0) return
      const pieces = pending.current.filter(piece => !inFlight.has(piece)).slice(0, SPEECH_PIECES_PER_REQUEST)
      if (pieces.length === 0) return
      for (const piece of pieces) inFlight.add(piece)
      try {
        const response = await apiFetch(`/api/meeting-participant/${encodeURIComponent(meetingId)}/speech?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: last,
          body: JSON.stringify({ sentAt: Date.now(), pieces }),
        })
        if (response.status < 500) {
          const sent = new Set(pieces)
          pending.current = pending.current.filter(piece => !sent.has(piece))
        }
      } catch {
        // The host is unreachable for now; the pieces wait for the next send.
      } finally {
        for (const piece of pieces) inFlight.delete(piece)
      }
    }
    const timer = setInterval(() => { void send() }, SPEECH_RELAY_INTERVAL_MS)
    // Closing the page does not unmount it, so its going away is heard here.
    const onPageHide = () => { void send(true) }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', onPageHide)
      void send(true)
    }
  }, [meetingId, token])
  return useCallback((piece: VoiceTranscriptEntry) => { pending.current.push({ at: Date.now(), role: piece.role, text: piece.text }) }, [])
}

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useIsVoiceConfigured, useVoiceInput } from '@renderer/hooks/use-voice-input'
import { isComposing } from '@renderer/lib/enter-key'
import { useIsAnyVoiceModeActive } from '@renderer/lib/voice-mode-handoff'

/**
 * The comment box's mic: the chat box's dictation, started on open when
 * `autoListen` is set, stopped by Escape from anywhere, and yielding to voice mode.
 */
export function useCommentMic(setText: Dispatch<SetStateAction<string>>, autoListen: boolean) {
  // A mic that heard nothing reports empty text; keep what was typed instead.
  const keepTypedText = useCallback((text: string) => setText((typed) => text || typed), [setText])
  const voiceInput = useVoiceInput({ onTranscriptUpdate: keepTypedText })
  const { startRecording, stopRecording } = voiceInput
  const hasVoiceConfigured = useIsVoiceConfigured()
  const voiceModeOn = useIsAnyVoiceModeActive()
  const listening = voiceInput.isRecording || voiceInput.isConnecting
  const listenOnOpen = useRef(autoListen && voiceInput.isSupported && hasVoiceConfigured && !voiceModeOn)

  // Deferred, so StrictMode's remount cancels the first start instead of racing it.
  useEffect(() => {
    if (!listenOnOpen.current) return
    const id = setTimeout(() => {
      listenOnOpen.current = false
      void startRecording('')
    })
    return () => clearTimeout(id)
  }, [startRecording])

  useEffect(() => {
    if (voiceModeOn) void stopRecording()
  }, [voiceModeOn, stopRecording])

  // Capture phase, so a dialog that handles Escape still lets it reach the mic.
  useEffect(() => {
    if (!listening) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isComposing(e)) return
      e.preventDefault()
      void stopRecording()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [listening, stopRecording])

  return { voiceInput, listening, voiceModeOn }
}

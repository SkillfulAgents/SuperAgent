import { useCallback, useEffect, useRef, useState } from 'react'
import { useMessageStream } from './use-message-stream'
import { useInterruptSession } from './use-messages'
import { createVoiceConversation } from '@renderer/lib/voice/registry/conversation'
import { VoiceAgentCoordinator } from '@renderer/lib/voice/conversation/coordinator'
import { holdSound } from '@renderer/lib/voice/shared/speech/hold-sound'
import type { VoiceHistory } from '@shared/lib/voice/conversation-types'
import type { VoiceAgentSnapshot, VoiceAgentState, VoiceConversationAdapter, VoiceConversationEngine, VoiceConversationSnapshot } from '@renderer/lib/voice/contracts/conversation'

export interface UseVoiceModeArgs {
  sessionId: string
  agentSlug: string
  active: boolean
  send(text: string): Promise<boolean>
  startWithAgentTurn?: boolean
  paused?: boolean
  history?: VoiceHistory
}
export interface VoiceModeResult extends VoiceConversationSnapshot {
  engine: VoiceConversationEngine | null
  working: boolean
  speechActive: boolean
  capabilities: VoiceConversationAdapter['capabilities']
  error: string | null
  clearError(): void
  pressMic(): void
  getAnalyser(): AnalyserNode | null
}
const IDLE: VoiceConversationSnapshot = {
  phase: 'listening', ready: false, userSpeaking: false, assistantSpeaking: false,
  utterance: '', hold: { allowed: false, delayMs: 700 },
}
const IDLE_AGENT: VoiceAgentState = { active: false, awaiting: false, toolsUsed: false }

/** One React integration, one stream subscription, and one selected voice engine. */
export function useConversationMode(args: UseVoiceModeArgs, engine: VoiceConversationEngine | null): VoiceModeResult {
  const { sessionId, agentSlug, active, paused = false } = args
  const stream = useMessageStream(active && engine ? sessionId : null, active && engine ? agentSlug : null)
  const interrupt = useInterruptSession()
  const latest = useRef({ args, stream, interrupt })
  latest.current = { args, stream, interrupt }
  const adapter = useRef<VoiceConversationAdapter | null>(null)
  const coordinator = useRef<VoiceAgentCoordinator | null>(null)
  // Unlike the adapter, the home-page handoff belongs to the session. Keep its
  // acknowledgment across voice restarts and Fast Refresh effect replays.
  const initialHandoff = useRef<{ sessionId: string; agentSlug: string; pending: boolean } | null>(null)
  const [snapshot, setSnapshot] = useState(IDLE)
  const [agent, setAgent] = useState(IDLE_AGENT)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [agentIssue, setAgentIssue] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<VoiceConversationAdapter['capabilities']>({ speechSpeed: false, spokenTranscript: false })

  useEffect(() => {
    setSnapshot(IDLE)
    setAgent(IDLE_AGENT)
    setProviderError(null)
    setAgentIssue(null)
    if (!active || !engine) return
    if (initialHandoff.current?.sessionId !== sessionId || initialHandoff.current.agentSlug !== agentSlug) {
      initialHandoff.current = { sessionId, agentSlug, pending: latest.current.args.startWithAgentTurn ?? false }
    }
    const handoff = initialHandoff.current
    let disposed = false
    let speechActive = false
    const getAgentSnapshot = (): VoiceAgentSnapshot => {
      const value = latest.current.stream
      return {
        active: value.isActive, text: value.streamingMessage ?? '', startedAt: value.activeStartTime ?? null,
        toolsRunning: (value.streamingToolUses?.length ?? 0) > 0, error: value.error ?? null,
      }
    }
    const conversation = createVoiceConversation(engine, { sessionId, agentSlug, history: latest.current.args.history ?? [] }, {
      onCommand: (command) => turns.command(command),
      onSnapshot: (next) => {
        if (disposed) return
        const talking = next.userSpeaking || next.assistantSpeaking
        // The person's voice cuts the loop at once; the reply becoming
        // audible fades it out under the first words, as it always has.
        if (talking && !speechActive) {
          if (next.userSpeaking) holdSound.stopImmediately()
          else holdSound.stop()
        }
        speechActive = talking
        setSnapshot(previous => previous.phase === next.phase && previous.ready === next.ready
          && previous.userSpeaking === next.userSpeaking && previous.assistantSpeaking === next.assistantSpeaking
          && previous.utterance === next.utterance && previous.transcript === next.transcript
          && previous.hold.allowed === next.hold.allowed && previous.hold.delayMs === next.hold.delayMs
          ? previous : next)
      },
      onError: (message) => { if (!disposed) setProviderError(message) },
    })
    const turns = new VoiceAgentCoordinator({
      snapshot: getAgentSnapshot,
      send: (text) => latest.current.args.send(text),
      interrupt: async (signal) => { await latest.current.interrupt.mutateAsync({ sessionId, agentSlug, signal }) },
      onEvent: (event) => conversation.acceptAgentEvent(event),
      onState: (state) => {
        if (disposed) return
        if (!state.awaiting) handoff.pending = false
        setAgent(previous => previous.active === state.active && previous.awaiting === state.awaiting
          && previous.toolsUsed === state.toolsUsed ? previous : state)
      },
      onIssue: (message) => { if (!disposed) setAgentIssue(message) },
    }, conversation.turnPolicy)
    adapter.current = conversation
    coordinator.current = turns
    setCapabilities(conversation.capabilities)
    conversation.setPaused(latest.current.args.paused ?? false)
    turns.setPaused(latest.current.args.paused ?? false)
    turns.start(handoff.pending)
    void conversation.start().catch((error: unknown) => {
      if (!disposed) setProviderError(error instanceof Error ? error.message : 'Could not start voice mode.')
    })
    return () => {
      disposed = true
      turns.close()
      conversation.close()
      if (adapter.current === conversation) adapter.current = null
      if (coordinator.current === turns) coordinator.current = null
    }
  }, [active, engine, sessionId, agentSlug])

  useEffect(() => {
    // Pause the adapter first so nothing new reaches a paused coordinator;
    // resume the coordinator first so words held through the card can go out.
    if (paused) {
      adapter.current?.setPaused(true)
      coordinator.current?.setPaused(true)
    } else {
      coordinator.current?.setPaused(false)
      adapter.current?.setPaused(false)
    }
  }, [paused])

  useEffect(() => {
    coordinator.current?.update({
      active: stream.isActive, text: stream.streamingMessage ?? '', startedAt: stream.activeStartTime ?? null,
      toolsRunning: (stream.streamingToolUses?.length ?? 0) > 0, error: stream.error ?? null,
    })
  }, [stream.isActive, stream.streamingMessage, stream.activeStartTime, stream.streamingToolUses, stream.error])

  const pressMic = useCallback(() => adapter.current?.pressMic(), [])
  const getAnalyser = useCallback(() => adapter.current?.analyser ?? null, [])
  const clearError = useCallback(() => { setProviderError(null); setAgentIssue(null) }, [])
  return {
    ...snapshot, engine, capabilities,
    working: active && !paused && snapshot.ready && agent.active,
    speechActive: snapshot.userSpeaking || snapshot.assistantSpeaking,
    error: agentIssue ?? providerError, clearError, pressMic, getAnalyser,
  }
}

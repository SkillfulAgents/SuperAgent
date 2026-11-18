import { useId, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { recallSettingsPatchSchema, type RecallSettings } from '@shared/lib/meeting-integrations/recall/config'
import { DEFAULT_MEETING_MODE, MEETING_INSTRUCTIONS_MAX_CHARS, MEETING_MODE_DESCRIPTIONS, MEETING_MODE_LABELS, MEETING_MODES, meetingModeSchema, type MeetingMode } from '@shared/lib/meeting-integrations/schemas'
import { useLiveVoices } from '@renderer/hooks/use-voice-input'
import type { TtsVoiceInfo } from '@shared/lib/voice/tts-preferences'

const asText = (value: unknown): string => typeof value === 'string' ? value : ''
const asMode = (value: unknown): MeetingMode => { const parsed = meetingModeSchema.safeParse(value); return parsed.success ? parsed.data : DEFAULT_MEETING_MODE }
/** The select needs a value for "no voice picked"; it is never stored. */
const DEFAULT_VOICE_OPTION = '__default__'

/**
 * The voices the configured voice provider's Live engine offers (the host
 * reports them; a provider without a Live engine offers none). A stored voice
 * the current provider does not know shows as the default and is cleared on save.
 */
function MeetingVoiceSelect({ id, value, onChange, disabled, voices, defaultVoice }: {
  id: string; value: string | null; onChange: (voice: string | null) => void; disabled?: boolean
  voices: readonly TtsVoiceInfo[]; defaultVoice: string | undefined
}) {
  const offered = (voice: string | null): voice is string => !!voice && voices.some(option => option.id === voice)
  const current = offered(value) ? value : DEFAULT_VOICE_OPTION
  const defaultLabel = voices.find(voice => voice.id === defaultVoice)?.label ?? defaultVoice ?? 'provider default'
  return <Select value={current} onValueChange={next => onChange(next === DEFAULT_VOICE_OPTION ? null : next)} disabled={disabled}>
    <SelectTrigger id={id} className="mt-1"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value={DEFAULT_VOICE_OPTION}>Default ({defaultLabel})</SelectItem>
      {voices.filter(voice => voice.id !== defaultVoice).map(voice => <SelectItem key={voice.id} value={voice.id}>
        {voice.label}<span className="text-muted-foreground ml-2">({voice.description})</span>
      </SelectItem>)}
    </SelectContent>
  </Select>
}

export function MeetingModeSelect({ id, value, onChange, disabled }: { id: string; value: MeetingMode; onChange: (mode: MeetingMode) => void; disabled?: boolean }) {
  return <Select value={value} onValueChange={next => onChange(asMode(next))} disabled={disabled}>
    <SelectTrigger id={id} className="mt-1"><SelectValue /></SelectTrigger>
    <SelectContent>
      {MEETING_MODES.map(mode => <SelectItem key={mode} value={mode}>{MEETING_MODE_LABELS[mode]}</SelectItem>)}
    </SelectContent>
  </Select>
}

/**
 * How the agent shows up in calls, how it takes part, and what it is told
 * before each one. All of it takes effect from the next meeting it joins; a
 * call already under way keeps what it started with.
 */
export function MeetingSettingsCard({ integration }: { integration: PublicAgentIntegration }) {
  const nameId = useId()
  const instructionsId = useId()
  const modeId = useId()
  const voiceId = useId()
  // The card is mounted for the recall provider only; its settings are RecallSettings or a legacy shape.
  const stored = integration.settings as Partial<RecallSettings>
  const [botName, setBotName] = useState(asText(stored.botName))
  const [instructions, setInstructions] = useState(asText(stored.instructions))
  const [mode, setMode] = useState<MeetingMode>(asMode(stored.mode))
  const live = useLiveVoices()
  // The voice list arrives after mount, so the stored voice is derived on each render
  // and only a choice made here overrides it; otherwise a saved voice would read as
  // the default until the list loaded and be cleared by the next save.
  const storedVoice = typeof stored.voice === 'string' && live.voices.some(option => option.id === stored.voice) ? stored.voice : null
  const [chosenVoice, setVoice] = useState<string | null | undefined>(undefined)
  const voice = chosenVoice === undefined ? storedVoice : chosenVoice
  const [error, setError] = useState<string | null>(null)
  const update = useUpdateAgentIntegration()
  const dirty = botName.trim() !== asText(stored.botName) || instructions.trim() !== asText(stored.instructions)
    || mode !== asMode(stored.mode) || voice !== storedVoice

  return <DetailCard label="Meeting Settings">
    <form className="space-y-3" onSubmit={event => {
      event.preventDefault()
      setError(null)
      const parsed = recallSettingsPatchSchema.safeParse({ botName: botName.trim() || null, instructions: instructions.trim() || null, mode, voice })
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the meeting settings'); return }
      update.mutate({ id: integration.id, config: parsed.data })
    }}>
      <div>
        <label htmlFor={nameId} className="text-xs text-muted-foreground">Name in calls</label>
        <Input id={nameId} className="mt-1" placeholder="The agent's name" value={botName} onChange={event => setBotName(event.target.value)} maxLength={100} disabled={update.isPending} />
      </div>
      <div>
        <label htmlFor={modeId} className="text-xs text-muted-foreground">In meetings</label>
        <MeetingModeSelect id={modeId} value={mode} onChange={setMode} disabled={update.isPending} />
        <p className="mt-1 text-xs text-muted-foreground">{MEETING_MODE_DESCRIPTIONS[mode]} Can be changed for each meeting when joining.</p>
      </div>
      {live.voices.length > 0 && <div>
        <label htmlFor={voiceId} className="text-xs text-muted-foreground">Voice</label>
        <MeetingVoiceSelect id={voiceId} value={voice} onChange={setVoice} disabled={update.isPending} voices={live.voices} defaultVoice={live.defaultVoice} />
      </div>}
      <div>
        <label htmlFor={instructionsId} className="text-xs text-muted-foreground">Instructions for every meeting</label>
        <Textarea id={instructionsId} className="mt-1" rows={4} placeholder="Introduce yourself when asked. Keep answers under two sentences. Track action items with owners." value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={MEETING_INSTRUCTIONS_MAX_CHARS} disabled={update.isPending} />
        <p className="mt-1 text-xs text-muted-foreground">Added to the brief of every meeting this agent joins, before whatever is asked for a specific call.</p>
      </div>
      {(error || update.isError) && <p role="alert" className="text-xs text-destructive">{error ?? update.error?.message}</p>}
      {!error && update.isSuccess && !dirty && <p role="status" className="text-xs text-muted-foreground">Meeting settings saved.</p>}
      <Button size="sm" type="submit" disabled={update.isPending || !dirty}>Save meeting settings</Button>
    </form>
  </DetailCard>
}

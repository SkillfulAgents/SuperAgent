import { SpeedSelect } from '@renderer/components/ui/speed-select'
import { PLAYBACK_RATES } from './use-media-keys'

const OPTIONS = PLAYBACK_RATES.map(r => ({ value: r, label: `${r}×` }))

/** Playback speed next to the player's clock. */
export function PlaybackSpeedSelect({ rate, onChange }: { rate: number; onChange: (rate: number) => void }) {
  return (
    <SpeedSelect
      value={rate}
      options={OPTIONS}
      onChange={onChange}
      label="Playback speed"
      title="Playback speed (Shift+, / Shift+.)"
      testId="playback-speed"
    />
  )
}

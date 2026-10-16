import { useEffect, useState, type RefObject } from 'react'
import { Volume2, VolumeOff } from 'lucide-react'

/** Mute toggle and volume slider for a preview's media element. */
export function VolumeControl({ mediaRef }: { mediaRef: RefObject<HTMLMediaElement | null> }) {
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    const sync = () => {
      setVolume(media.volume)
      setMuted(media.muted)
    }
    sync()
    media.addEventListener('volumechange', sync)
    return () => media.removeEventListener('volumechange', sync)
  }, [mediaRef])

  const silent = muted || volume === 0

  const toggleMute = () => {
    const media = mediaRef.current
    if (!media) return
    // Unmuting from a zero slider would stay silent, so bring the level back up.
    if (silent && media.volume === 0) media.volume = 1
    media.muted = !silent
  }

  const changeVolume = (value: number) => {
    const media = mediaRef.current
    if (!media) return
    media.volume = value
    media.muted = value === 0
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={toggleMute}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1]"
        title={silent ? 'Unmute' : 'Mute'}
        aria-label={silent ? 'Unmute' : 'Mute'}
        data-testid="media-mute"
      >
        {silent ? <VolumeOff className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={e => changeVolume(Number(e.target.value))}
        aria-label="Volume"
        className="w-16 min-w-0 accent-primary cursor-pointer"
        data-testid="media-volume"
      />
    </div>
  )
}

import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'

// Each color is [topColor, bottomColor] for a macOS-style top-down gradient
const COLORS: [string, string][] = [
  ['#f87171', '#dc2626'], ['#fb923c', '#ea580c'], ['#fbbf24', '#d97706'], ['#facc15', '#ca8a04'],
  ['#a3e635', '#65a30d'], ['#4ade80', '#16a34a'], ['#34d399', '#059669'], ['#2dd4bf', '#0d9488'],
  ['#22d3ee', '#0891b2'], ['#38bdf8', '#0284c7'], ['#60a5fa', '#2563eb'], ['#818cf8', '#4f46e5'],
  ['#a78bfa', '#7c3aed'], ['#c084fc', '#9333ea'], ['#e879f9', '#c026d3'], ['#f472b6', '#db2777'],
  ['#fb7185', '#e11d48'], ['#a8a29e', '#57534e'], ['#9ca3af', '#4b5563'], ['#94a3b8', '#334155'],
]

const EMOJIS = [
  '📊', '📈', '📉', '🎯', '💡', '🔧', '⚡', '🚀',
  '🎨', '📋', '📌', '🔍', '🌍', '💰', '🏠', '❤️',
  '⭐', '🔔', '📱', '💻', '🎮', '🎵', '📷', '🎬',
  '✈️', '🚗', '🍕', '☕', '🌟', '🔥', '💎', '🏆',
  '🧪', '🔬', '🌡️', '⏰', '📅', '💬', '📧', '🛒',
  '🎁', '🌈', '🦊', '🐱', '🐶', '🌸', '🍀', '🎄',
]

interface AddToDockDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  dashboardSlug: string
  dashboardName: string
}

function renderIcon(canvas: HTMLCanvasElement, emoji: string, bgColor: [string, string], size: number) {
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  // macOS applies its own rounded-rect mask to dock icons, so we inset the
  // visible content by ~10% on each side to avoid it looking oversized.
  const padding = size * 0.1
  const inner = size - padding * 2
  const radius = inner * 0.22

  ctx.clearRect(0, 0, size, size)
  ctx.beginPath()
  ctx.roundRect(padding, padding, inner, inner, radius)

  const gradient = ctx.createLinearGradient(0, padding, 0, padding + inner)
  gradient.addColorStop(0, bgColor[0])
  gradient.addColorStop(1, bgColor[1])
  ctx.fillStyle = gradient
  ctx.fill()

  ctx.font = `${inner * 0.55}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(emoji, size / 2, size / 2 + inner * 0.03)
}

export function AddToDockDialog({
  open,
  onOpenChange,
  agentSlug,
  dashboardSlug,
  dashboardName,
}: AddToDockDialogProps) {
  const [emoji, setEmoji] = useState('📊')
  const [color, setColor] = useState<[string, string]>(['#60a5fa', '#2563eb'])
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const emojiInputRef = useRef<HTMLInputElement>(null)

  const handleOpenEmojiPicker = useCallback(() => {
    // Focus the hidden input so the native emoji picker inserts into it
    emojiInputRef.current?.focus()
    window.electronAPI?.showEmojiPanel()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    renderIcon(canvas, emoji, color, 96)
  }, [emoji, color])

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setError(null)
      setIsCreating(false)
    }
    onOpenChange(next)
  }, [onOpenChange])

  const handleCreate = useCallback(async () => {
    setIsCreating(true)
    setError(null)
    try {
      const offscreen = document.createElement('canvas')
      renderIcon(offscreen, emoji, color, 512)
      const blob = await new Promise<Blob | null>((resolve) =>
        offscreen.toBlob(resolve, 'image/png')
      )
      if (!blob) throw new Error('Failed to generate icon')
      const buffer = await blob.arrayBuffer()

      await window.electronAPI?.createDockShortcut(
        agentSlug,
        dashboardSlug,
        dashboardName,
        new Uint8Array(buffer)
      )
      handleOpenChange(false)
    } catch (err: any) {
      setError(err.message || 'Failed to create dock shortcut')
    } finally {
      setIsCreating(false)
    }
  }, [emoji, color, agentSlug, dashboardSlug, dashboardName, handleOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Dock</DialogTitle>
          <DialogDescription>
            Create a dock shortcut for &ldquo;{dashboardName}&rdquo;
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex justify-center">
            <canvas
              ref={canvasRef}
              width={96}
              height={96}
              className="rounded-[22%]"
              style={{ width: 96, height: 96 }}
            />
          </div>

          <div className="space-y-2">
            <Label>Background Color</Label>
            <div className="grid grid-cols-10 gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c[0]}
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-md border-2 transition-all ${
                    color[0] === c[0] ? 'border-foreground scale-110' : 'border-transparent'
                  }`}
                  style={{ background: `linear-gradient(to bottom, ${c[0]}, ${c[1]})` }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Icon</Label>
            <div className="grid grid-cols-8 gap-1 max-h-[200px] overflow-y-auto">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmoji(e)}
                  className={`w-9 h-9 rounded-md text-lg flex items-center justify-center transition-all ${
                    emoji === e ? 'bg-accent ring-2 ring-foreground scale-110' : 'hover:bg-accent/50'
                  }`}
                >
                  {e}
                </button>
              ))}
              <button
                onClick={handleOpenEmojiPicker}
                className="w-9 h-9 rounded-md border border-dashed border-muted-foreground/40 flex items-center justify-center hover:bg-accent/50 transition-all"
                title="Browse all emojis"
              >
                <Plus className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            {/* Hidden input to capture native emoji picker selection */}
            <input
              ref={emojiInputRef}
              className="sr-only"
              aria-hidden
              value=""
              onChange={(e) => {
                const val = e.target.value
                if (val) {
                  setEmoji(val)
                  e.target.value = ''
                }
              }}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? 'Creating…' : 'Add to Dock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

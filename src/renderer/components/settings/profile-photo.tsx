import { useRef, useState, type ChangeEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { Button } from '@renderer/components/ui/button'
import { useUser } from '@renderer/context/user-context'
import { authClient } from '@renderer/lib/auth-client'
import { apiFetch } from '@renderer/lib/api'

/** Crop to a small square in the browser; the server independently validates it. */
export async function cropProfilePhoto(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('Choose a PNG, JPEG, or WebP photo under 5 MB.')
  }
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare this photo.')
    const side = Math.min(bitmap.width, bitmap.height)
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Could not prepare this photo.')), 'image/png',
    ))
  } finally {
    bitmap.close()
  }
}

export function ProfilePhoto() {
  const { user } = useUser()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!user) return null

  async function save(file: File | null) {
    setPending(true)
    setError(null)
    try {
      const body = file ? await cropProfilePhoto(file) : undefined
      const response = await apiFetch('/api/profile/avatar', {
        method: file ? 'PUT' : 'DELETE',
        ...(body ? { headers: { 'Content-Type': 'image/png' }, body } : {}),
      })
      if (!response.ok) throw new Error('Could not save your photo. Please try again.')
      authClient.$store.notify('$sessionSignal')
      toast.success(file ? 'Photo updated' : 'Account photo restored')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your photo.')
    } finally {
      setPending(false)
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void save(file)
  }

  return (
    <div className="py-4 px-4" data-testid="profile-photo">
      <div className="flex items-center gap-3">
        <UserAvatar user={user} size={48} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">Profile photo</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Your photo in this workspace. Photos are cropped to a square.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => input.current?.click()}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Change photo'}
          </Button>
          {user.avatarOverride && <Button size="sm" variant="ghost" disabled={pending} onClick={() => void save(null)}>Use account photo</Button>}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="Choose profile photo" onChange={onFileChange} />
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}

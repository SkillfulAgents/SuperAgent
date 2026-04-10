import { useState } from 'react'
import { UserRound } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'

interface ChromeProfileSelectProps {
  profiles: Array<{ id: string; name: string; avatarUrl?: string; email?: string }>
  value: string
  onValueChange: (profileId: string) => void
  idPrefix?: string
  disabled?: boolean
}

function ProfileAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [imgError, setImgError] = useState(false)

  if (avatarUrl && !imgError) {
    return (
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      <img
        src={avatarUrl}
        alt=""
        className="h-5 w-5 rounded-full shrink-0"
        onError={() => setImgError(true)}
      />
    )
  }

  return (
    <span className="h-5 w-5 rounded-full shrink-0 bg-muted flex items-center justify-center text-[10px] font-medium text-muted-foreground">
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

export function ChromeProfileSelect({
  profiles,
  value,
  onValueChange,
  idPrefix = 'chrome-profile',
  disabled,
}: ChromeProfileSelectProps) {
  return (
    <div className="space-y-2">
      <Select
        value={value || '__none__'}
        onValueChange={(v) => onValueChange(v === '__none__' ? '' : v)}
        disabled={disabled}
      >
        <SelectTrigger id={`${idPrefix}-select`}>
          <SelectValue placeholder="Select a Chrome profile" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">
            <span className="flex items-center gap-2">
              <span className="h-5 w-5 rounded-full shrink-0 bg-muted flex items-center justify-center">
                <UserRound className="h-3 w-3 text-muted-foreground/40" />
              </span>
              <span>
                None
                <span className="text-muted-foreground/70 text-xs ml-2">Fresh profile</span>
              </span>
            </span>
          </SelectItem>
          {profiles.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              <span className="flex items-center gap-2">
                <ProfileAvatar name={profile.name} avatarUrl={profile.avatarUrl} />
                <span>
                  {profile.name}
                  {profile.email && (
                    <span className="text-muted-foreground/70 text-xs ml-2">{profile.email}</span>
                  )}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'

interface ChromeProfileSelectProps {
  profiles: Array<{ id: string; name: string; avatarUrl?: string }>
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
      <Label htmlFor={`${idPrefix}-select`}>Chrome Profile</Label>
      <Select
        value={value || '__none__'}
        onValueChange={(v) => onValueChange(v === '__none__' ? '' : v)}
        disabled={disabled}
      >
        <SelectTrigger id={`${idPrefix}-select`}>
          <SelectValue placeholder="Select a Chrome profile" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">None (clean profile)</SelectItem>
          {profiles.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              <span className="flex items-center gap-2">
                <ProfileAvatar name={profile.name} avatarUrl={profile.avatarUrl} />
                {profile.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Use cookies and login sessions from a Chrome profile. Data is copied fresh each time the browser launches.
      </p>
    </div>
  )
}

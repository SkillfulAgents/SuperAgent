import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Minus, Users } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import { AccessInvitePicker } from '@renderer/components/sharing/access-invite-picker'
import { MemberRosterPopover } from '@renderer/components/sharing/member-roster-popover'
import { Button } from '@renderer/components/ui/button'
import { invalidateVolumeAccess, useRemoveVolumeOwner, useSaveVolumeDefinition } from '@renderer/hooks/use-volume-definitions'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { VolumeVisibilityLabel, VolumeVisibilitySelect } from './volume-visibility-select'

function OwnersPicker({ volume }: { volume: VolumeDefinitionSummary }) {
  const client = useQueryClient()
  const remove = useRemoveVolumeOwner(volume.id)
  const members = volume.owners.map(({ userId, ...profile }) => ({ ...profile, id: userId }))
  return <>
    {volume.visibility === 'public' && <p className="px-3 pt-3 text-xs text-muted-foreground">Everyone in this workspace can open and attach this drive.</p>}
    <AccessInvitePicker target={{ kind: 'drive', id: volume.id }} members={members}
      role={volume.canManage ? 'owner' : undefined} onGranted={() => { void invalidateVolumeAccess(client) }}
      error={remove.error?.message}
      renderMemberAction={({ id, name }) => <>
        <span className="text-[11px] text-muted-foreground">Owner</span>
        {volume.canManage && id !== null && <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove ${name} as owner`}
          disabled={members.length === 1 || remove.isPending} title={members.length === 1 ? 'Add another owner first' : undefined}
          onClick={() => remove.mutate(id)}><Minus className="size-3.5" /></Button>}
      </>}
    />
  </>
}

export function VolumeAccessHeader({ volume }: { volume: VolumeDefinitionSummary }) {
  const { isAuthMode, isAdmin } = useUser()
  const save = useSaveVolumeDefinition()
  const [error, setError] = useState<string>()
  const reasonId = useId()
  const isPublic = volume.visibility === 'public'
  const people = volume.owners.flatMap(({ userId, ...profile }) => userId === null ? [] : [{ ...profile, id: userId }])
  const blocked = volume.teamBrainDrive ? 'Team Brain requires a public drive.' : volume.globalAccess ? 'Turn off global access before changing visibility.' : undefined
  return <div className="flex shrink-0 flex-col items-end gap-1">
    <div className="flex items-center gap-1">
      {isAuthMode && volume.supportsOwnerSharing !== false && <MemberRosterPopover
        users={people} label={`People with access to ${volume.name}`} rosterLabel="Drive access"
        title={isPublic ? 'Drive owners' : people.map(p => p.name).join(', ')}
        trigger={isPublic ? <><Users className="size-4" />Owners</> : undefined}
        className="gap-1 px-1 text-xs font-medium hover:bg-accent" contentClassName="w-[28rem] p-0"
      >
        <OwnersPicker volume={volume} />
      </MemberRosterPopover>}
      {isAuthMode && isAdmin && volume.canManage ? <span title={blocked}>
        <VolumeVisibilitySelect value={volume.visibility} disabled={!!blocked || save.isPending}
          aria-label="Drive visibility" aria-describedby={blocked ? reasonId : undefined} className="w-auto"
          onValueChange={async visibility => {
            setError(undefined)
            try { await save.mutateAsync({ id: volume.id, visibility }) }
            catch (err) { setError(err instanceof Error ? err.message : 'Could not change drive visibility') }
          }} />
        {blocked && <span id={reasonId} className="sr-only">{blocked}</span>}
      </span> : <span className="text-xs text-muted-foreground"><VolumeVisibilityLabel value={volume.visibility} /></span>}
    </div>
    {error && <p role="alert" className="max-w-48 text-right text-xs text-destructive">{error}</p>}
  </div>
}

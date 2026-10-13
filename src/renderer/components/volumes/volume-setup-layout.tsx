import { useEffect, useRef, type ComponentType, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import type { VolumeDetails } from './volume-details-schema'

export function VolumeSetupHeader({ title, description, Logo, steps, step }: {
  title: string; description: string; Logo: ComponentType<{ className?: string }>; steps: string[]; step: number
}) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [step])
  return <DialogHeader className="space-y-4 text-left">
    <ol aria-label="Setup progress" className="flex items-center gap-2 text-xs text-muted-foreground">
      {steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} className="flex items-center gap-2">
        {index > 0 && <ChevronRight aria-hidden className="h-3 w-3" />}
        <span className={index === step ? 'font-medium text-foreground' : undefined}>{label}</span>
      </li>)}
    </ol>
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><Logo className="h-6 w-6" /></div>
      <div className="space-y-1.5"><DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">{title}</DialogTitle><DialogDescription>{description}</DialogDescription></div>
    </div>
  </DialogHeader>
}

export function VolumeDetailsFields({ value, onChange, disabled, inUse = false, children }: {
  value: VolumeDetails; onChange: (value: VolumeDetails) => void; disabled: boolean; inUse?: boolean; children: ReactNode
}) {
  const { isAuthMode, isAdmin } = useUser()
  return <>
    <div className="space-y-2">
      <Label htmlFor="volume-name">Name</Label>
      <Input id="volume-name" value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} maxLength={255} disabled={disabled} required />
    </div>
    {children}
    {isAuthMode && <div className="space-y-2">
      <Label htmlFor="volume-access">Who can attach this volume?</Label>
      {isAdmin ? <Select value={value.visibility} onValueChange={visibility => onChange({ ...value, visibility: visibility as VolumeDetails['visibility'] })} disabled={disabled || inUse}>
        <SelectTrigger id="volume-access"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="private">Only me</SelectItem><SelectItem value="public">Everyone</SelectItem></SelectContent>
      </Select> : <p className="text-sm">Only me</p>}
      {inUse && isAdmin && <p className="text-xs text-muted-foreground">Detach from all agents before changing access.</p>}
    </div>}
  </>
}

export function VolumeSetupFooter({ onBack, onCancel, isSaving, disabled, submitLabel }: {
  onBack?: () => void; onCancel: () => void; isSaving: boolean; disabled: boolean; submitLabel: string
}) {
  return <DialogFooter className="gap-2 pt-2 sm:space-x-0">
    {onBack && <Button type="button" variant="ghost" className="sm:mr-auto" onClick={onBack} disabled={isSaving}><ArrowLeft className="h-4 w-4" />Back</Button>}
    <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>Cancel</Button>
    <Button type="submit" disabled={disabled || isSaving}>{isSaving && <Loader2 className="h-4 w-4 animate-spin" />}{submitLabel}</Button>
  </DialogFooter>
}

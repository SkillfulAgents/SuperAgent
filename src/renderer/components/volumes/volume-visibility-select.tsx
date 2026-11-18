import { useId, type ComponentProps } from 'react'
import { Globe, Lock } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { cn } from '@shared/lib/utils/cn'
import type { VolumeDetails } from './volume-details-schema'

const options = {
  private: { label: 'Private', Icon: Lock, description: 'Only owners can open it.' },
  public: { label: 'Public', Icon: Globe, description: 'All workspace members can open it.' },
}

export function VolumeVisibilityLabel({ value }: { value: VolumeDetails['visibility'] }) {
  const { Icon, label } = options[value]
  return <span className="inline-flex items-center gap-2 align-middle">
    <Icon aria-hidden="true" className="size-4 shrink-0" />
    {label}
  </span>
}

type VisibilitySelectProps = Pick<ComponentProps<typeof SelectTrigger>, 'id' | 'className' | 'aria-label' | 'aria-describedby'> & {
  value: VolumeDetails['visibility']
  onValueChange: (value: VolumeDetails['visibility']) => void
  disabled: boolean
}

export function VolumeVisibilitySelect({ value, onValueChange, disabled, className, ...triggerProps }: VisibilitySelectProps) {
  const id = useId()
  return (
    <Select value={value} disabled={disabled} onValueChange={next => {
      if (next === 'private' || next === 'public') onValueChange(next)
    }}>
      <SelectTrigger {...triggerProps} className={cn('gap-2 text-sm font-medium', className)}>
        <SelectValue><VolumeVisibilityLabel value={value} /></SelectValue>
      </SelectTrigger>
      <SelectContent align="end" collisionPadding={8} className="w-72 max-w-[calc(100vw-1rem)]">
        {Object.entries(options).map(([visibility, { label, Icon, description }]) => (
          <SelectItem key={visibility} value={visibility} textValue={label}
            aria-labelledby={`${id}-${visibility}-label`} aria-describedby={`${id}-${visibility}-description`}
            className="py-2.5 pl-2.5">
            <span className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-muted text-foreground">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span id={`${id}-${visibility}-label`} className="text-sm font-semibold leading-tight">{label}</span>
                <span id={`${id}-${visibility}-description`} className="text-xs leading-4 text-muted-foreground">{description}</span>
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

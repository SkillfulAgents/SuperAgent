import { Folder } from 'lucide-react'
import type { VolumeType } from '@shared/lib/types/mount'
import { volumeSetupRegistry } from './volume-setup-registry'

/** Each source owns its logo; cards, pickers and details share that definition. */
export function VolumeIcon({ type, className }: { type: VolumeType; className?: string }) {
  const Logo = volumeSetupRegistry[type]?.Logo ?? Folder
  return <Logo className={className} />
}

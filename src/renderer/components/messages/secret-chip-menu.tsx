import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { DropdownMenuItem } from '@renderer/components/ui/dropdown-menu'
import { useCreateSecret, useUpdateSecret } from '@renderer/hooks/use-secrets'
import type { ChipMenuProps } from './composer-chips'
import { ChipMenuAt } from './composer-chip-menu'
import { SecretKeyDialog } from './secret-key-dialog'

/**
 * A secret pill's menu. Editing a saved key renames it or replaces its value;
 * editing one the agent lacks saves it, which makes the pill send as a key again.
 */
export function SecretChipMenu({ chip, context: { agentSlug }, backed, anchor, replace, onClose }: ChipMenuProps) {
  const [editing, setEditing] = useState(false)
  const createSecret = useCreateSecret()
  const updateSecret = useUpdateSecret()

  if (!editing || !agentSlug) {
    return (
      <ChipMenuAt anchor={anchor} onClose={onClose}>
        <DropdownMenuItem
          disabled={!agentSlug}
          onSelect={(event) => {
            event.preventDefault()
            setEditing(true)
          }}
        >
          <Pencil />
          Edit key
        </DropdownMenuItem>
      </ChipMenuAt>
    )
  }

  const save = async ({ key, value }: { key: string; value: string }) => {
    if (backed && key === chip.label && !value) return onClose()
    const saved = backed
      ? await updateSecret.mutateAsync({ agentSlug, secretId: chip.referent, key, value: value || undefined })
      : await createSecret.mutateAsync({ agentSlug, key, value, location: 'composer' })
    replace({ kind: chip.kind, referent: saved.envVar, label: saved.key })
    onClose()
  }

  return (
    <SecretKeyDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Edit key"
      description={backed
        ? "Rename the key or replace its value in the agent's .env file."
        : "This key is not saved for this agent. Enter its value to save it to the agent's .env file."}
      submitLabel="Save"
      initialKey={chip.label}
      keepsValue={backed}
      onSave={save}
      // The editor takes focus back once the dialog is gone.
      onCloseAutoFocus={(event) => event.preventDefault()}
    />
  )
}

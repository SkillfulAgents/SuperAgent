import { useState } from 'react'
import { KeyRound, X } from 'lucide-react'
import { useCreateSecret } from '@renderer/hooks/use-secrets'
import type { PotentialSecret } from '@renderer/lib/secret-detection'
import { SecretKeyDialog } from './secret-key-dialog'

interface SecretDetectionPromptProps {
  agentSlug: string
  candidate: PotentialSecret
  onDismiss: (candidate: PotentialSecret) => void
  onSecure: (candidate: PotentialSecret, secret: { key: string; envVar: string }) => void
}

export function SecretDetectionPrompt({
  agentSlug,
  candidate,
  onDismiss,
  onSecure,
}: SecretDetectionPromptProps) {
  const [open, setOpen] = useState(false)
  const createSecret = useCreateSecret()

  const save = async ({ key, value }: { key: string; value: string }) => {
    const saved = await createSecret.mutateAsync({ agentSlug, key, value, location: 'composer' })
    onSecure(candidate, { key: saved.key, envVar: saved.envVar })
    setOpen(false)
  }

  return (
    <div
      data-testid="secret-detection-prompt"
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dotted border-amber-500/70 bg-amber-500/5 px-2.5 py-2 text-xs"
    >
      <span className="flex items-center gap-1.5 font-medium">
        <KeyRound className="h-3.5 w-3.5 text-amber-600" />
        Is this a Key?
      </span>
      <SecretKeyDialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline">
            Send securely to the agent
          </button>
        }
        title="Send key securely"
        description="Save this value to the agent's .env file. The message will contain only the environment variable name."
        submitLabel="Save securely"
        initialValue={candidate.value}
        onSave={save}
      />
      <span className="text-muted-foreground">or</span>
      <button
        type="button"
        aria-label="Dismiss key suggestion"
        onClick={() => onDismiss(candidate)}
        className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        dismiss
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

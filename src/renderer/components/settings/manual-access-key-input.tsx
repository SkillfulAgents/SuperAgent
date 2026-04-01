import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { useSavePlatformAccessKey } from '@renderer/hooks/use-platform-auth'

export function ManualAccessKeyInput({ className }: { className?: string }) {
  const [showInput, setShowInput] = useState(false)
  const [key, setKey] = useState('')
  const saveKey = useSavePlatformAccessKey()

  if (!showInput) {
    return (
      <button
        type="button"
        className={`text-xs text-muted-foreground hover:text-foreground hover:underline ${className ?? ''}`}
        onClick={() => setShowInput(true)}
      >
        <KeyRound className="inline mr-1 h-3 w-3" />
        Add access key manually
      </button>
    )
  }

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <Label className="text-xs">Paste access key</Label>
      <div className="flex gap-2">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="plat_sa_..."
          className="font-mono text-xs"
        />
        <Button
          size="sm"
          disabled={!key.trim() || saveKey.isPending}
          onClick={() => {
            saveKey.mutate(key.trim(), {
              onSuccess: () => {
                setKey('')
                setShowInput(false)
              },
            })
          }}
        >
          {saveKey.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </Button>
      </div>
      {saveKey.isError && (
        <p className="text-xs text-destructive">{saveKey.error.message}</p>
      )}
    </div>
  )
}

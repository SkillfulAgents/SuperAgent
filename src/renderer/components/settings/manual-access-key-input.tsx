import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { RequestError } from '@renderer/components/messages/request-error'
import { useSavePlatformAccessKey } from '@renderer/hooks/use-platform-auth'

export function ManualAccessKeyInput({ className, prefixText }: { className?: string; prefixText?: string }) {
  const [showInput, setShowInput] = useState(false)
  const [key, setKey] = useState('')
  const saveKey = useSavePlatformAccessKey()

  if (!showInput) {
    return (
      <div className={className ?? ''}>
        {prefixText && <>{prefixText}{' '}</>}
        <button
          type="button"
          className="text-sm underline underline-offset-2 hover:text-foreground transition-colors"
          onClick={() => setShowInput(true)}
        >
          Add access key
        </button>
      </div>
    )
  }

  return (
    <div className={className ?? ''}>
      <div className="flex items-center gap-2">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste account key"
          className="font-mono text-xs h-8 flex-1"
          autoFocus
        />
        <Button
          size="sm"
          className="h-8"
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
      <RequestError message={saveKey.isError ? saveKey.error.message : null} className="mt-2" />
    </div>
  )
}

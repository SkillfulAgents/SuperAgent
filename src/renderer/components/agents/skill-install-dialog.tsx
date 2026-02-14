import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

interface SkillInstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skillName: string
  requiredEnvVars: Array<{ name: string; description: string }>
  onInstall: (envVars: Record<string, string>) => void
}

export function SkillInstallDialog({
  open,
  onOpenChange,
  skillName,
  requiredEnvVars,
  onInstall,
}: SkillInstallDialogProps) {
  const [envVarValues, setEnvVarValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const v of requiredEnvVars) {
      initial[v.name] = ''
    }
    return initial
  })

  const allFilled = requiredEnvVars.every((v) => envVarValues[v.name]?.trim())

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!allFilled) return
    onInstall(envVarValues)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Install {skillName}</DialogTitle>
            <DialogDescription>
              This skill requires the following environment variables to be configured.
              They will be saved securely as agent secrets.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-4">
            {requiredEnvVars.map((envVar) => (
              <div key={envVar.name} className="space-y-1.5">
                <Label htmlFor={`env-${envVar.name}`} className="font-mono text-xs">
                  {envVar.name}
                </Label>
                {envVar.description && (
                  <p className="text-xs text-muted-foreground">{envVar.description}</p>
                )}
                <Input
                  id={`env-${envVar.name}`}
                  type="password"
                  value={envVarValues[envVar.name] || ''}
                  onChange={(e) =>
                    setEnvVarValues((prev) => ({
                      ...prev,
                      [envVar.name]: e.target.value,
                    }))
                  }
                  placeholder={`Enter ${envVar.name}`}
                />
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!allFilled}>
              Install
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

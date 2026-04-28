import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { SkillInstallDialog } from '@renderer/components/agents/skill-install-dialog'
import { useInstallAgentFromSkillset } from '@renderer/hooks/use-agent-templates'
import { useDeleteAgent } from '@renderer/hooks/use-agents'
import { apiFetch } from '@renderer/lib/api'
import type { ApiAgent, ApiDiscoverableAgent } from '@shared/lib/types/api'

interface TemplateInstallDialogProps {
  template: ApiDiscoverableAgent | null
  onClose: () => void
  /** Called after the agent is fully installed (after secrets step if required). */
  onInstalled: (agent: ApiAgent, meta: { hasOnboarding?: boolean }) => void | Promise<void>
}

/**
 * Lightweight template-install dialog that handles the name step + required
 * env vars. Pure UI: it only fires `onInstalled` on success — callers decide
 * what to do with the new agent (select it, track, kick off onboarding, etc).
 */
export function TemplateInstallDialog({ template, onClose, onInstalled }: TemplateInstallDialogProps) {
  const [name, setName] = useState('')
  const install = useInstallAgentFromSkillset()
  const deleteAgent = useDeleteAgent()
  const [secretsPrompt, setSecretsPrompt] = useState<{
    agent: ApiAgent
    requiredEnvVars: Array<{ name: string; description: string }>
    hasOnboarding?: boolean
  } | null>(null)

  useEffect(() => {
    if (template) setName(template.name)
    else {
      setName('')
      install.reset()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- install.reset is stable enough; reinit on template change
  }, [template])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!template || !name.trim()) return
      try {
        const agent = await install.mutateAsync({
          skillsetId: template.skillsetId,
          agentPath: template.path,
          agentName: name.trim(),
          agentVersion: template.version,
        })

        if (agent.requiredEnvVars && agent.requiredEnvVars.length > 0) {
          setSecretsPrompt({
            agent,
            requiredEnvVars: agent.requiredEnvVars,
            hasOnboarding: agent.hasOnboarding,
          })
          return
        }

        await onInstalled(agent, { hasOnboarding: agent.hasOnboarding })
        onClose()
      } catch (error) {
        console.error('Failed to install agent from skillset:', error)
      }
    },
    [template, name, install, onInstalled, onClose],
  )

  const handleSecretsSubmit = useCallback(
    async (envVars: Record<string, string>) => {
      if (!secretsPrompt) return
      const { agent, hasOnboarding } = secretsPrompt
      setSecretsPrompt(null)

      for (const [key, value] of Object.entries(envVars)) {
        if (value && typeof value === 'string') {
          try {
            await apiFetch(`/api/agents/${encodeURIComponent(agent.slug)}/secrets`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key, value }),
            })
          } catch (error) {
            console.error(`Failed to save secret ${key}:`, error)
          }
        }
      }

      await onInstalled(agent, { hasOnboarding })
      onClose()
    },
    [secretsPrompt, onInstalled, onClose],
  )

  return (
    <>
      <Dialog open={!!template && !secretsPrompt} onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Install {template?.name}</DialogTitle>
            <DialogDescription>
              {template?.description || `From ${template?.skillsetName}`}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <Input
              placeholder="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              disabled={install.isPending}
            />
            {install.error && (
              <p className="text-sm text-destructive">{install.error.message}</p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={install.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || install.isPending}>
                {install.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Installing...
                  </>
                ) : (
                  'Install'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {secretsPrompt && (
        <SkillInstallDialog
          open={!!secretsPrompt}
          onOpenChange={(open) => {
            if (!open) {
              deleteAgent.mutate(secretsPrompt.agent.slug)
              setSecretsPrompt(null)
              onClose()
            }
          }}
          skillName="agent template"
          requiredEnvVars={secretsPrompt.requiredEnvVars}
          onInstall={handleSecretsSubmit}
        />
      )}
    </>
  )
}

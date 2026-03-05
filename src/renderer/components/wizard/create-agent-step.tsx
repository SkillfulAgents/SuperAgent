import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { Loader2, Check } from 'lucide-react'

export function CreateAgentStep() {
  const [name, setName] = useState('')
  const [created, setCreated] = useState(false)
  const createAgent = useCreateAgent()
  const { selectAgent } = useSelection()

  const handleCreate = async () => {
    if (!name.trim()) return
    try {
      const newAgent = await createAgent.mutateAsync({ name: name.trim() })
      selectAgent(newAgent.slug)
      setCreated(true)
    } catch (error) {
      console.error('Failed to create agent:', error)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Create Your First Agent</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Create an AI agent to get started. Each agent runs in its own container and can be customized with instructions and tools.
          This step is optional.
        </p>
      </div>

      {created ? (
        <Alert>
          <Check className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700 dark:text-green-400">
            Agent created successfully! Click <strong>Finish</strong> to start using Superagent.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="wizard-agent-name">Agent Name</Label>
            <Input
              id="wizard-agent-name"
              placeholder="My First Agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
              data-testid="wizard-agent-name-input"
            />
          </div>

          <Button
            onClick={handleCreate}
            disabled={!name.trim() || createAgent.isPending}
            data-testid="wizard-create-agent"
          >
            {createAgent.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Agent'
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

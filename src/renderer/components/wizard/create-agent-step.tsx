import { CreateAgentForm } from '@renderer/components/agents/create-agent-form'

interface CreateAgentStepProps {
  onAgentCreated?: () => Promise<void> | void
}

export function CreateAgentStep({ onAgentCreated }: CreateAgentStepProps) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-normal max-w-sm">Let&apos;s create your first agent</h2>
      </div>
      <CreateAgentForm onAgentCreated={onAgentCreated} />
    </div>
  )
}

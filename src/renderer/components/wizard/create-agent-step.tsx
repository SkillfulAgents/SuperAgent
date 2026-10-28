import { CreateAgentForm } from '@renderer/components/agents/create-agent-form'

interface CreateAgentStepProps {
  onAgentCreated?: () => Promise<void> | void
}

export function CreateAgentStep({ onAgentCreated }: CreateAgentStepProps) {
  // The title rides inside the form's centered hero block (see the form's
  // `header` prop for why it cannot sit outside).
  return (
    <CreateAgentForm
      className="h-full"
      header={
        <div className="shrink-0 pb-8">
          <h2 className="text-2xl font-normal max-w-sm">Describe your first AI teammate</h2>
        </div>
      }
      onAgentCreated={onAgentCreated}
      onNavigateAway={onAgentCreated}
    />
  )
}

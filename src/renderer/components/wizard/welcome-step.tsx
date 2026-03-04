export function WelcomeStep() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Welcome to Superagent</h2>
      <p className="text-muted-foreground">
        Superagent lets you create and manage AI agents that run in isolated containers.
        Each agent has its own environment, tools, and can connect to external services.
      </p>
      <div className="space-y-3 pt-2">
        <p className="text-sm font-medium">This wizard will help you set up:</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">1.</span>
            <span><strong>LLM Provider</strong> - Configure your AI model API key</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">2.</span>
            <span><strong>Container Runtime</strong> - Ensure containers can run on your machine</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">3.</span>
            <span><strong>Browser</strong> (optional) - Choose how agents browse the web</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">4.</span>
            <span><strong>Composio</strong> (optional) - Connect OAuth accounts like Gmail, Slack, GitHub</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">5.</span>
            <span><strong>First Agent</strong> (optional) - Create your first AI agent</span>
          </li>
        </ul>
      </div>
      <p className="text-sm text-muted-foreground pt-2">
        You can always change these settings later. Click <strong>Next</strong> to get started.
      </p>
    </div>
  )
}

import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import { AnthropicApiKeyInput } from '@renderer/components/settings/anthropic-api-key-input'
import { ChevronRight } from 'lucide-react'

export function ConfigureLLMStep() {
  const [showInstructions, setShowInstructions] = useState(false)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Configure LLM Provider</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Superagent needs an API key to communicate with AI models.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Provider</Label>
        <div className="flex items-center gap-2 p-2 rounded-md border bg-muted/30">
          <span className="text-sm font-medium">Anthropic (Claude)</span>
          <span className="text-xs text-muted-foreground ml-auto">Only supported provider</span>
        </div>
      </div>

      <AnthropicApiKeyInput
        idPrefix="wizard-api-key"
        showNotConfiguredAlert={false}
        showHelpText={false}
        showRemoveButton={false}
      />

      <div className="pt-2">
        <button
          type="button"
          onClick={() => setShowInstructions(!showInstructions)}
          className="text-sm text-primary hover:underline flex items-center gap-1"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${showInstructions ? 'rotate-90' : ''}`} />
          How to get an API key
        </button>

        {showInstructions && (
          <div className="mt-2 p-3 rounded-md border bg-muted/30 text-sm space-y-2">
            <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
              <li>
                Sign up for an account at{' '}
                <a
                  href="https://console.anthropic.com/login"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  console.anthropic.com
                </a>
              </li>
              <li>Click your Profile in the top right corner and select <strong>API Keys</strong></li>
              <li>Click <strong>Create Key</strong>, name your key, and hit <strong>Create Key</strong></li>
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}

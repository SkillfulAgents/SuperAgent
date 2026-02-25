import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Label } from '@renderer/components/ui/label'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { AnthropicApiKeyInput } from './anthropic-api-key-input'

const MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5', label: 'Claude 4.5 Haiku' },
  { value: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
  { value: 'claude-opus-4-6', label: 'Claude 4.6 Opus' },
]

export function LlmTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  return (
    <div className="space-y-6">
      {/* API Keys Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">API Keys</h3>
        <AnthropicApiKeyInput disabled={isLoading} />
      </div>

      {/* Models Section */}
      <div className="pt-4 border-t space-y-4">
        <h3 className="text-sm font-medium">Models</h3>
        <div className="space-y-2">
          <Label htmlFor="agent-model">Agent Model</Label>
          <Select
            value={settings?.models?.agentModel ?? 'claude-opus-4-6'}
            onValueChange={(value) => {
              updateSettings.mutate({ models: { agentModel: value } })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="agent-model">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Model used for agent sessions
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="summarizer-model">Summarizer Model</Label>
          <Select
            value={settings?.models?.summarizerModel ?? 'claude-haiku-4-5'}
            onValueChange={(value) => {
              updateSettings.mutate({ models: { summarizerModel: value } })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="summarizer-model">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Model used for session name generation and API key validation
          </p>
        </div>
      </div>
    </div>
  )
}

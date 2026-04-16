import { ProviderApiKeyInput } from './provider-api-key-input'

interface ComposioApiKeyInputProps {
  showSourceIndicator?: boolean
  showHelpText?: boolean
  showRemoveButton?: boolean
  validateButtonLabel?: string
  disabled?: boolean
}

export function ComposioApiKeyInput({
  showSourceIndicator = true,
  showHelpText = true,
  showRemoveButton = true,
  validateButtonLabel,
  disabled = false,
}: ComposioApiKeyInputProps) {
  return (
    <ProviderApiKeyInput
      providerId="composio"
      label="Composio API Key"
      placeholder="Enter Composio API key"
      apiKeySettingsField="composioApiKey"
      apiKeyStatusKey="composio"
      validationEndpoint="/api/settings/validate-composio-key"
      validationBody={(apiKey) => ({ apiKey })}
      showSourceIndicator={showSourceIndicator}
      showNotConfiguredAlert={false}
      showHelpText={showHelpText}
      showRemoveButton={showRemoveButton}
      showRemoveConfirm={false}
      validateButtonLabel={validateButtonLabel}
      helpText={
        <>
          Get your API key from{' '}
          <a
            href="https://app.composio.dev/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            Composio Dashboard
          </a>
        </>
      }
      disabled={disabled}
    />
  )
}

import { ProviderApiKeyInput } from './provider-api-key-input'

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'

export function MediaTab() {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground px-1">
        Lets agents generate images, video, and audio with approved models. Runs are billed to
        your Replicate account and auto-cancel after 10 minutes.{' '}
        <a
          href="https://replicate.com/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          View Replicate docs
        </a>
      </p>
      <div className={`${CARD_CLASS} mt-2`}>
        <div className="py-3 px-4">
          <ProviderApiKeyInput
            providerId="replicate"
            label="Replicate API Key"
            apiKeySettingsField="replicateApiKey"
            apiKeyStatusKey="replicate"
            validationEndpoint="/api/settings/validate-replicate-key"
            validationBody={(apiKey) => ({ apiKey })}
            envVarName="REPLICATE_API_TOKEN"
            placeholder="r8_..."
          />
        </div>
      </div>
    </div>
  )
}

import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

export interface McpAdvancedClientValues {
  clientName: string
  clientId: string
  clientSecret: string
}

interface McpAdvancedClientFieldsProps {
  values: McpAdvancedClientValues
  onChange: (next: McpAdvancedClientValues) => void
  /** Open on mount — set when the server cannot register a client for itself. */
  defaultOpen?: boolean
  disabled?: boolean
  /**
   * `labeled` for the settings form, which has room for a caption per field;
   * `compact` for the in-session request card, which does not.
   */
  variant?: 'labeled' | 'compact'
  /** Test ids are `${testIdPrefix}-client-id` and friends. */
  testIdPrefix: string
}

const TEST_ID_SUFFIX: Record<keyof McpAdvancedClientValues, string> = {
  clientName: 'client-name',
  clientId: 'client-id',
  clientSecret: 'client-secret',
}

/**
 * The OAuth client overrides a user supplies when a server rejects dynamic client
 * registration. Shared by the connections form and the in-session request card so
 * the two cannot describe the same three fields differently.
 */
export function McpAdvancedClientFields({
  values,
  onChange,
  defaultOpen,
  disabled,
  variant = 'labeled',
  testIdPrefix,
}: McpAdvancedClientFieldsProps) {
  const labeled = variant === 'labeled'
  const inputClass = labeled ? 'mt-1' : 'h-8 text-sm'

  const field = (
    key: keyof McpAdvancedClientValues,
    label: string,
    placeholder: string,
    options: { type?: string; hint?: string } = {},
  ) => (
    <div>
      {labeled && (
        <Label className="text-xs font-normal text-muted-foreground/70">{label}</Label>
      )}
      <Input
        type={options.type}
        value={values[key]}
        onChange={(e) => onChange({ ...values, [key]: e.target.value })}
        placeholder={placeholder}
        className={inputClass}
        disabled={disabled}
        data-testid={`${testIdPrefix}-${TEST_ID_SUFFIX[key]}`}
      />
      {options.hint && (
        <p className="mt-1 text-[11px] text-muted-foreground/70">{options.hint}</p>
      )}
    </div>
  )

  return (
    <details
      className={`group rounded-md ${labeled ? 'pt-2' : ''}`}
      open={defaultOpen}
      data-testid={`${testIdPrefix}-advanced`}
    >
      <summary className="cursor-pointer list-none text-xs text-muted-foreground/70 select-none hover:text-muted-foreground">
        <span className="inline-block transition-transform group-open:rotate-90">›</span>
        <span className="ml-1">Advanced</span>
      </summary>
      <div className="mt-2 space-y-2">
        {field('clientName', 'Client Name', 'Override OAuth client_name (optional)')}
        {field('clientId', 'Client ID', 'Provide your own OAuth client_id (optional)', {
          hint: "For servers that don't support open dynamic client registration and have issued you a client ID directly.",
        })}
        {field(
          'clientSecret',
          'Client Secret',
          'OAuth client_secret (optional, only if your provider requires one)',
          { type: 'password' },
        )}
      </div>
    </details>
  )
}

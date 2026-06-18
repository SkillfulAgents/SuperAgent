import { useState } from 'react'
import { Pause, Pencil, Trash2 } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { useUpdateChatIntegration } from '@renderer/hooks/use-chat-integrations'
import { parseChatIntegrationConfig, type SlackConfig } from '@shared/lib/chat-integrations/config-schema'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import type { EffortLevel } from '@shared/lib/container/types'
import type { ChatIntegration } from '@shared/lib/db/schema'

function ToggleRow({ label, helperText, checked, onCheckedChange, disabled }: {
  label: string
  helperText?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex w-full items-center justify-between px-2 py-1.5">
      <div className={helperText ? 'flex flex-col gap-0.5' : undefined}>
        <span className="text-xs">{label}</span>
        {helperText && <span className="text-xs text-muted-foreground/70">{helperText}</span>}
      </div>
      <Switch
        className="scale-75 origin-right"
        checked={checked}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

function SessionTimeoutInput({ value, onCommit, disabled, id }: {
  value: number | null
  onCommit: (hours: number | null) => void
  disabled?: boolean
  id: string
}) {
  const [local, setLocal] = useState(value != null && value > 0 ? String(value) : '')

  const commit = () => {
    const parsed = parseInt(local, 10)
    const next = parsed > 0 ? parsed : null
    if (next !== value) onCommit(next)
  }

  return (
    <div className="px-2 py-1.5">
      <Label htmlFor={id} className="text-xs font-normal">
        New session after
        <span className="ml-1 font-normal text-muted-foreground/70">hours, blank = never</span>
      </Label>
      <Input
        id={id}
        type="number"
        min="1"
        step="1"
        className="mt-1 h-7 text-xs shadow-none"
        placeholder="Never"
        value={local}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { e.stopPropagation(); setLocal(e.target.value) }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        disabled={disabled}
      />
    </div>
  )
}

interface IntegrationSettingsMenuProps {
  integration: ChatIntegration
  onRename: () => void
  onDelete: () => void
}

export function IntegrationModelEffort({ integration }: { integration: ChatIntegration }) {
  const updateIntegration = useUpdateChatIntegration()

  const [model, setModelLocal] = useState<string | undefined>(integration.model ?? undefined)
  const [effort, setEffortLocal] = useState<EffortLevel>((integration.effort as EffortLevel) ?? 'medium')

  return (
    <SettingsModelSelect
      model={model}
      onModelChange={(m) => { setModelLocal(m); updateIntegration.mutate({ id: integration.id, model: m }) }}
      includeEffort
      effort={effort}
      onEffortChange={(e) => { setEffortLocal(e); updateIntegration.mutate({ id: integration.id, effort: e }) }}
    />
  )
}

export function IntegrationSettingsMenu({ integration, onRename, onDelete }: IntegrationSettingsMenuProps) {
  const updateIntegration = useUpdateChatIntegration()
  const isPaused = integration.status === 'paused'

  return (
    <>
      <div className="flex w-full items-center justify-between px-2 py-1.5">
        <div
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${
            isPaused
              ? 'bg-muted text-muted-foreground'
              : 'bg-green-500/10 text-green-700 dark:text-green-400'
          }`}
        >
          {isPaused ? (
            <Pause className="h-2.5 w-2.5 fill-current" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          )}
          {isPaused ? 'Paused' : 'Active'}
        </div>
        <Switch
          className="scale-75 origin-right"
          checked={!isPaused}
          disabled={updateIntegration.isPending}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={() =>
            updateIntegration.mutate({
              id: integration.id,
              status: isPaused ? 'active' : 'paused',
            })
          }
          aria-label={isPaused ? 'Resume integration' : 'Pause integration'}
        />
      </div>
      <div className="my-1 h-px bg-border" />
      <ToggleRow
        label="Show tool calls"
        checked={!!integration.showToolCalls}
        disabled={updateIntegration.isPending}
        onCheckedChange={(checked) =>
          updateIntegration.mutate({ id: integration.id, showToolCalls: checked })
        }
      />
      <ToggleRow
        label="Require approval for new conversations"
        helperText="Off makes this a public bot — anyone can message it."
        checked={!!integration.requireApproval}
        disabled={updateIntegration.isPending}
        onCheckedChange={(checked) =>
          updateIntegration.mutate({ id: integration.id, requireApproval: checked })
        }
      />
      <SessionTimeoutInput
        id={`timeout-${integration.id}`}
        value={integration.sessionTimeout ?? null}
        onCommit={(hours) => updateIntegration.mutate({ id: integration.id, sessionTimeout: hours })}
        disabled={updateIntegration.isPending}
      />
      <div className="px-2 py-1.5">
        <Label className="text-xs font-normal mb-1 block">Model &amp; Effort</Label>
        <IntegrationModelEffort integration={integration} />
      </div>
      {integration.provider === 'slack' && (() => {
        const config = parseChatIntegrationConfig('slack', integration.config) as SlackConfig | null
        if (!config) return null
        return (
          <>
            <ToggleRow
              label="Only on @mention"
              checked={!!config.onlyMentioned}
              disabled={updateIntegration.isPending}
              onCheckedChange={(checked) =>
                updateIntegration.mutate({
                  id: integration.id,
                  config: { ...config, onlyMentioned: checked },
                })
              }
            />
            <ToggleRow
              label="Reply in thread"
              checked={!!config.answerInThread}
              disabled={updateIntegration.isPending}
              onCheckedChange={(checked) =>
                updateIntegration.mutate({
                  id: integration.id,
                  config: { ...config, answerInThread: checked, ...(!checked ? { newSessionPerThread: false } : {}) },
                })
              }
            />
            {!!config.answerInThread && (
              <ToggleRow
                label="New session per thread"
                checked={!!config.newSessionPerThread}
                disabled={updateIntegration.isPending}
                onCheckedChange={(checked) =>
                  updateIntegration.mutate({
                    id: integration.id,
                    config: { ...config, newSessionPerThread: checked },
                  })
                }
              />
            )}
          </>
        )
      })()}
      <div className="my-1 h-px bg-border" />
      <button
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
        onClick={(e) => { e.stopPropagation(); onRename() }}
      >
        <Pencil className="h-3.5 w-3.5" />
        Rename
      </button>
      <button
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </button>
    </>
  )
}

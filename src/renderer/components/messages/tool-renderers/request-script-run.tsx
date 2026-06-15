import { Terminal } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ToolRenderer, ToolRendererProps } from './types'
import { Field, FieldLabel } from './shared'
import { requestScriptRunDef, SCRIPT_TYPE_LABELS } from '@shared/lib/tool-definitions/request-script-run'

const parseInput = requestScriptRunDef.parseInput

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { script, explanation, scriptType } = parseInput(input)

  return (
    <div className="space-y-2">
      {explanation && <Field label="Explanation">{explanation}</Field>}

      {scriptType && <Field label="Script Type">{SCRIPT_TYPE_LABELS[scriptType] || scriptType}</Field>}

      {script && (
        <div>
          <FieldLabel>Script</FieldLabel>
          <pre className="bg-background rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
            <code>{script}</code>
          </pre>
        </div>
      )}

      {result && (
        <div>
          <FieldLabel>{isError ? 'Error' : 'Output'}</FieldLabel>
          <pre
            className={cn(
              'bg-background rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all',
              isError ? 'text-red-800 dark:text-red-200' : 'text-green-800 dark:text-green-200'
            )}
          >
            {result}
          </pre>
        </div>
      )}
    </div>
  )
}

export const requestScriptRunRenderer: ToolRenderer = {
  displayName: 'Run Script',
  icon: Terminal,
  getSummary: requestScriptRunDef.getSummary,
  ExpandedView,
}

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import { CurrencyPriceInput } from './catalog-fields'
import { parseOptionalPrice } from './catalog-overrides'

export interface BuiltinPricingDialogProps {
  /** The built-in model being priced; null closes the dialog. */
  model: ModelDefinition | null
  /** Pricing currently stored as an override (drives initial values + reset availability). */
  overridePricing?: { inputPerMtok: number; outputPerMtok: number }
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onSave: (pricing: { inputPerMtok: number; outputPerMtok: number }) => void
  onReset: () => void
}

/** Edit only the display pricing of a built-in model. Body mounts while open. */
export function BuiltinPricingDialog(props: BuiltinPricingDialogProps) {
  return (
    <Dialog open={props.model !== null} onOpenChange={(open) => !open && props.onOpenChange(false)}>
      {props.model && <BuiltinPricingDialogBody {...props} model={props.model} />}
    </Dialog>
  )
}

function BuiltinPricingDialogBody({
  model,
  overridePricing,
  disabled,
  onOpenChange,
  onSave,
  onReset,
}: BuiltinPricingDialogProps & { model: ModelDefinition }) {
  const pricing = overridePricing ?? model.pricing
  const [inputPrice, setInputPrice] = useState(pricing?.inputPerMtok?.toString() ?? '')
  const [outputPrice, setOutputPrice] = useState(pricing?.outputPerMtok?.toString() ?? '')

  const parsedInput = parseOptionalPrice(inputPrice)
  const parsedOutput = parseOptionalPrice(outputPrice)
  const canSave = parsedInput !== undefined && parsedOutput !== undefined

  const save = () => {
    if (parsedInput === undefined || parsedOutput === undefined) return
    onSave({ inputPerMtok: parsedInput, outputPerMtok: parsedOutput })
    onOpenChange(false)
  }

  return (
    <DialogContent aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>{`Edit pricing — ${model.label}`}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 md:grid-cols-2">
        <CurrencyPriceInput
          id="builtin-model-input-price"
          label="Input price"
          value={inputPrice}
          onChange={setInputPrice}
          testId="catalog-builtin-price-input"
          disabled={disabled}
        />
        <CurrencyPriceInput
          id="builtin-model-output-price"
          label="Output price"
          value={outputPrice}
          onChange={setOutputPrice}
          testId="catalog-builtin-price-output"
          disabled={disabled}
        />
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={`catalog-reset-pricing-${model.id}`}
          disabled={disabled || overridePricing === undefined}
          onClick={() => {
            onReset()
            onOpenChange(false)
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset pricing
        </Button>
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="button"
          size="sm"
          data-testid="catalog-save-builtin-pricing"
          disabled={disabled || !canSave}
          onClick={save}
        >
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

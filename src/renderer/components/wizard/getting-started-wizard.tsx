import { useState, useEffect, useMemo, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import {
  Check,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react'
import { WelcomeStep } from './welcome-step'
import { ConfigureLLMStep } from './configure-llm-step'
import { DockerSetupStep } from './docker-setup-step'
import { BrowserSetupStep } from './browser-setup-step'
import { ComposioStep } from './composio-step'
import { CreateAgentStep } from './create-agent-step'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'

type WizardStepId = 'welcome' | 'llm' | 'browser' | 'composio' | 'runtime' | 'agent'

const ALL_STEPS: { id: WizardStepId; label: string; skippable: boolean }[] = [
  { id: 'welcome', label: 'Welcome', skippable: false },
  { id: 'llm', label: 'LLM', skippable: false },
  { id: 'browser', label: 'Browser', skippable: true },
  { id: 'composio', label: 'Composio', skippable: true },
  { id: 'runtime', label: 'Runtime', skippable: true },
  { id: 'agent', label: 'Agent', skippable: true },
]

interface GettingStartedWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GettingStartedWizard({ open, onOpenChange }: GettingStartedWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [composioCanProceed, setComposioCanProceed] = useState(false)
  const composioSaveRef = useRef<(() => Promise<void>) | null>(null)
  const updateUserSettings = useUpdateUserSettings()
  const { data: platformAuth } = usePlatformAuthStatus()

  const steps = useMemo(() => {
    if (platformAuth?.connected) {
      return ALL_STEPS.filter((step) => step.id !== 'llm' && step.id !== 'composio')
    }
    return ALL_STEPS
  }, [platformAuth?.connected])

  const activeStep = steps[currentStep]

  // Reset step when dialog opens
  useEffect(() => {
    if (open) {
      setCurrentStep(0)
    }
  }, [open])

  const handleFinish = async () => {
    await updateUserSettings.mutateAsync({ setupCompleted: true })
    onOpenChange(false)
  }

  const handleComposioNext = async () => {
    if (composioSaveRef.current) {
      try {
        await composioSaveRef.current()
      } catch (error) {
        console.error('Failed to save Composio settings:', error)
        return
      }
    }
    setCurrentStep((s) => s + 1)
  }

  useEffect(() => {
    if (currentStep > steps.length - 1) {
      setCurrentStep(Math.max(steps.length - 1, 0))
    }
  }, [currentStep, steps.length])

  const isLastStep = currentStep === steps.length - 1
  const canSkipStep = activeStep?.skippable ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 [&>button]:hidden" data-testid="wizard-dialog" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Getting Started</DialogTitle>
        <DialogDescription className="sr-only">
          Set up Superagent for the first time
        </DialogDescription>

        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-0 px-8 pt-6 pb-2">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium border-2 transition-colors ${
                    i < currentStep
                      ? 'bg-primary border-primary text-primary-foreground'
                      : i === currentStep
                        ? 'border-primary text-primary bg-primary/10'
                        : 'border-muted-foreground/30 text-muted-foreground'
                  }`}
                >
                  {i < currentStep ? <Check className="h-4 w-4" /> : i + 1}
                </div>
                <span className={`text-[10px] mt-1 ${i === currentStep ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-12 h-0.5 mx-1 mb-4 ${
                    i < currentStep ? 'bg-primary' : 'bg-muted-foreground/30'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="px-6 py-4 min-h-[320px]" data-testid="wizard-step-content" data-step={currentStep}>
          {activeStep?.id === 'welcome' && <WelcomeStep />}
          {activeStep?.id === 'llm' && <ConfigureLLMStep />}
          {activeStep?.id === 'browser' && <BrowserSetupStep />}
          {activeStep?.id === 'composio' && <ComposioStep onCanProceedChange={setComposioCanProceed} saveRef={composioSaveRef} />}
          {activeStep?.id === 'runtime' && <DockerSetupStep />}
          {activeStep?.id === 'agent' && <CreateAgentStep />}
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center justify-between px-6 py-4 border-t">
          <Button
            variant="outline"
            onClick={() => setCurrentStep((s) => s - 1)}
            disabled={currentStep === 0}
            data-testid="wizard-back"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back
          </Button>

          <div className="flex gap-2">
            {canSkipStep && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (isLastStep) {
                    handleFinish()
                  } else {
                    setCurrentStep((s) => s + 1)
                  }
                }}
                data-testid="wizard-skip"
              >
                Skip
              </Button>
            )}
            {isLastStep ? (
              <Button onClick={handleFinish} data-testid="wizard-finish">
                Finish
              </Button>
            ) : (
              <Button
                onClick={activeStep?.id === 'composio' ? handleComposioNext : () => setCurrentStep((s) => s + 1)}
                disabled={activeStep?.id === 'composio' && !composioCanProceed}
                data-testid="wizard-next"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

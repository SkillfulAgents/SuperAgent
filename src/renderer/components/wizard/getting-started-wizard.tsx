import { useState, useEffect, useMemo, useRef } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import {
  ChevronRight,
  ChevronLeft,
} from 'lucide-react'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { WelcomeStep } from './welcome-step'
import { ConfigureLLMStep } from './configure-llm-step'
import { DockerSetupStep } from './docker-setup-step'
import { BrowserSetupStep } from './browser-setup-step'
import { ComposioStep } from './composio-step'
import { CreateAgentStep } from './create-agent-step'
import { PrivacyStep } from './privacy-step'
import { RibbonWave } from './ribbon-wave'

type WizardStepId = 'llm' | 'browser' | 'composio' | 'runtime' | 'privacy' | 'agent'

const MANUAL_STEPS: { id: WizardStepId; label: string; skippable: boolean }[] = [
  { id: 'llm', label: 'LLM', skippable: false },
  { id: 'browser', label: 'Browser', skippable: false },
  { id: 'composio', label: 'Composio', skippable: true },
  { id: 'runtime', label: 'Runtime', skippable: false },
  { id: 'privacy', label: 'Privacy', skippable: false },
  { id: 'agent', label: 'Agent', skippable: true },
]

const PLATFORM_STEPS: { id: WizardStepId; label: string; skippable: boolean }[] = [
  { id: 'browser', label: 'Browser', skippable: false },
  { id: 'runtime', label: 'Runtime', skippable: false },
  { id: 'privacy', label: 'Privacy', skippable: false },
  { id: 'agent', label: 'Agent', skippable: true },
]

interface GettingStartedWizardProps {
  onClose: () => void
}

export function GettingStartedWizard({ onClose }: GettingStartedWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [welcomePath, setWelcomePath] = useState<'platform' | 'manual' | null>(null)
  const [composioCanProceed, setComposioCanProceed] = useState(false)
  const [runtimeCanProceed, setRuntimeCanProceed] = useState(false)
  const [browserCanProceed, setBrowserCanProceed] = useState(true)
  const [llmCanProceed, setLlmCanProceed] = useState(false)
  const composioSaveRef = useRef<(() => Promise<void>) | null>(null)
  // Track whether we're restoring progress to avoid a redundant persist on resume
  const isRestoringRef = useRef(false)
  const { data: userSettings } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()

  const steps = useMemo(() => {
    if (welcomePath === 'platform') return PLATFORM_STEPS
    if (welcomePath === 'manual') return MANUAL_STEPS
    return []
  }, [welcomePath])

  const activeStep = welcomePath ? steps[currentStep] : null

  // Resume at last known step on mount, or reset to beginning.
  const hasRestoredRef = useRef(false)
  useEffect(() => {
    // Wait for settings to load before deciding where to start
    if (!userSettings) return
    // Only restore once per mount
    if (hasRestoredRef.current) return
    hasRestoredRef.current = true

    const progress = userSettings.onboardingProgress
    if (progress) {
      const targetSteps = progress.path === 'platform' ? PLATFORM_STEPS : MANUAL_STEPS
      const idx = targetSteps.findIndex(s => s.id === progress.stepId)
      if (idx >= 0) {
        isRestoringRef.current = true
        setWelcomePath(progress.path)
        setCurrentStep(idx)
      } else {
        setCurrentStep(0)
        setWelcomePath(null)
      }
    } else {
      setCurrentStep(0)
      setWelcomePath(null)
    }
  }, [userSettings])

  // Persist progress on every step change
  useEffect(() => {
    // Skip the persist that fires right after restoring saved progress
    if (isRestoringRef.current) {
      isRestoringRef.current = false
      return
    }
    if (welcomePath && steps[currentStep]) {
      updateUserSettings.mutate({
        onboardingProgress: { path: welcomePath, stepId: steps[currentStep].id },
      })
    }
  }, [currentStep, welcomePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFinish = async () => {
    // Use null (not undefined) so it survives JSON serialization and actually clears the field
    await updateUserSettings.mutateAsync({ setupCompleted: true, onboardingProgress: null })
    onClose()
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

  const handleWelcomePlatformPath = () => {
    setWelcomePath('platform')
    setCurrentStep(0)
  }

  const handleWelcomeManualSetup = () => {
    setWelcomePath('manual')
    setCurrentStep(0)
  }

  const isAgentStep = activeStep?.id === 'agent'

  return (
    <div className="flex h-svh bg-background overflow-hidden" data-testid="wizard-container">
      {/* Draggable title bar region for Electron */}
      {isElectron() && <div className="absolute top-0 left-0 right-0 h-12 app-drag-region z-10" />}

      {/* Left column: wizard content */}
      <div className={`relative flex flex-col h-svh transition-[width] duration-500 ease-in-out ${isAgentStep ? 'w-full' : 'w-full lg:w-1/2'}`}>
        <h1 className="sr-only">Getting Started</h1>

        <div className={`flex flex-1 flex-col justify-center py-10 w-full mx-auto transition-[max-width] duration-500 ${isAgentStep ? 'max-w-[560px]' : 'max-w-[480px]'}`}>
          <div className="w-full">

          {/* Step content */}
          <div className="min-h-[320px]" data-testid="wizard-step-content" data-step={currentStep}>
            {!welcomePath && (
              <WelcomeStep
                onChoosePlatform={handleWelcomePlatformPath}
                onContinueToManualSetup={handleWelcomeManualSetup}
              />
            )}
            {activeStep?.id === 'llm' && (
              <ConfigureLLMStep
                onCanProceedChange={setLlmCanProceed}
              />
            )}
            {activeStep?.id === 'browser' && <BrowserSetupStep onCanProceedChange={setBrowserCanProceed} />}
            {activeStep?.id === 'composio' && <ComposioStep onCanProceedChange={setComposioCanProceed} saveRef={composioSaveRef} />}
            {activeStep?.id === 'runtime' && <DockerSetupStep onCanProceedChange={setRuntimeCanProceed} />}
            {activeStep?.id === 'privacy' && <PrivacyStep />}
            {activeStep?.id === 'agent' && <CreateAgentStep onAgentCreated={handleFinish} />}
          </div>
          </div>
        </div>

        {/* Navigation buttons — hidden on welcome page */}
        <div className={`flex items-center justify-between pb-10 w-full mx-auto transition-[max-width] duration-500 ${isAgentStep ? 'max-w-[560px]' : 'max-w-[480px]'} ${!welcomePath ? 'hidden' : ''}`}>
          {!welcomePath ? (
            <div />
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                if (currentStep === 0) {
                  setWelcomePath(null)
                  return
                }
                setCurrentStep((s) => s - 1)
              }}
              data-testid="wizard-back"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          )}

          <div className="flex gap-2">
            {canSkipStep && (
              <Button
                variant="outline"
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
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
            {!welcomePath || isLastStep ? null : (
              <Button
                onClick={activeStep?.id === 'composio' ? handleComposioNext : () => setCurrentStep((s) => s + 1)}
                disabled={(activeStep?.id === 'llm' && !llmCanProceed) || (activeStep?.id === 'composio' && !composioCanProceed) || (activeStep?.id === 'runtime' && !runtimeCanProceed) || (activeStep?.id === 'browser' && !browserCanProceed)}
                data-testid="wizard-next"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Right column: cover image — slides out on the agent step */}
      <div className={`hidden lg:block p-4 shrink-0 transition-all duration-500 ease-in-out ${isAgentStep ? 'w-0 translate-x-full opacity-0 p-0' : 'w-1/2 translate-x-0 opacity-100'} ${getPlatform() === 'win32' ? 'pt-12' : ''}`}>
        <RibbonWave className="h-full w-full rounded-xl" />
      </div>
    </div>
  )
}

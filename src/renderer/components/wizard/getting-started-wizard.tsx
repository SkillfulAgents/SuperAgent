import { useState, useEffect, useMemo, useRef } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useUserSettings, useUpdateUserSettings, type UserSettingsData } from '@renderer/hooks/use-user-settings'
import { useUpdateSettings } from '@renderer/hooks/use-settings'
import {
  ChevronRight,
  ChevronLeft,
} from 'lucide-react'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { targetIsRemote } from '@renderer/lib/api-target'
import { WelcomeStep } from './welcome-step'
import { ConfigureLLMStep } from './configure-llm-step'
import { ConfigureModelStep } from './configure-model-step'
import { DockerSetupStep } from './docker-setup-step'
import { BrowserSetupStep } from './browser-setup-step'
import { ComposioStep } from './composio-step'
import { AGENT_STEP_MAX_WIDTH, CreateAgentContinueButton, CreateAgentScreenLayout, CreateAgentStep } from './create-agent-step'
import { useCreateAgentFlow } from '@renderer/hooks/use-create-agent-flow'
import { PrivacyStep } from './privacy-step'
import { WelcomeOrbCrowd } from './welcome-orb-crowd'

type WizardStepId = 'llm' | 'model' | 'browser' | 'composio' | 'runtime' | 'privacy' | 'agent'

const MANUAL_STEPS: { id: WizardStepId; label: string; skippable: boolean }[] = [
  { id: 'llm', label: 'LLM', skippable: false },
  { id: 'model', label: 'Model', skippable: false },
  { id: 'browser', label: 'Browser', skippable: false },
  { id: 'composio', label: 'Composio', skippable: true },
  { id: 'runtime', label: 'Runtime', skippable: false },
  { id: 'privacy', label: 'Privacy', skippable: false },
  { id: 'agent', label: 'Agent', skippable: true },
]

const PLATFORM_STEPS: { id: WizardStepId; label: string; skippable: boolean }[] = [
  { id: 'model', label: 'Model', skippable: false },
  { id: 'browser', label: 'Browser', skippable: false },
  { id: 'runtime', label: 'Runtime', skippable: false },
  { id: 'privacy', label: 'Privacy', skippable: false },
  { id: 'agent', label: 'Agent', skippable: true },
]

/**
 * The steps of a path, as this window can actually run them.
 *
 * The runtime step sets up the container runtime of the Superagent being
 * configured — starting a runner, and on the desktop opening the Docker Desktop
 * download or telling you to run `wsl --install` as Administrator. That is
 * exactly what onboarding is for, on the desktop app and on a self-hosted web
 * deployment alike. A cloud workspace is the one case where it is not: the
 * runtime is already provisioned and the machine is out of reach.
 *
 * So the test is `targetIsRemote()`, NOT `canUseHostFeatures()` — the latter is
 * false in every browser and would drop this step from ordinary web onboarding
 * as well.
 *
 * Everything that turns a step id into a position must go through here. Two
 * places do — rendering and restoring saved progress — and indexing one into
 * the filtered list and the other into the constant lands the user on a
 * different step than the one they left.
 */
export function stepsForPath(path: 'platform' | 'manual' | null) {
  const all = path === 'platform' ? PLATFORM_STEPS : path === 'manual' ? MANUAL_STEPS : []
  return targetIsRemote() ? all.filter((step) => step.id !== 'runtime') : all
}

interface GettingStartedWizardProps {
  agentOnly?: boolean
  onClose: () => void
}

export function GettingStartedWizard(props: GettingStartedWizardProps) {
  const { data: settings } = useUserSettings()
  return settings && <LoadedGettingStartedWizard {...props} initialProgress={settings.onboardingProgress} />
}

function LoadedGettingStartedWizard({ agentOnly, onClose, initialProgress }: GettingStartedWizardProps & {
  initialProgress: UserSettingsData['onboardingProgress']
}) {
  const [restored] = useState(() => {
    if (initialProgress) {
      const index = stepsForPath(initialProgress.path).findIndex(step => step.id === initialProgress.stepId)
      if (index >= 0) return { path: initialProgress.path, index }
    }
    return { path: null, index: 0 }
  })
  const [currentStep, setCurrentStep] = useState(restored.index)
  const [welcomePath, setWelcomePath] = useState(restored.path)
  const [composioCanProceed, setComposioCanProceed] = useState(false)
  const [runtimeCanProceed, setRuntimeCanProceed] = useState(false)
  const [browserCanProceed, setBrowserCanProceed] = useState(true)
  const [llmCanProceed, setLlmCanProceed] = useState(false)
  const composioSaveRef = useRef<(() => Promise<void>) | null>(null)
  const { mutate: updateProgress, mutateAsync: saveSettings } = useUpdateUserSettings()
  const updateGlobalSettings = useUpdateSettings()
  const steps = useMemo(() => stepsForPath(welcomePath), [welcomePath])
  const activeStep = steps[currentStep]
  const lastStep = useRef(initialProgress && initialProgress.path + '/' + initialProgress.stepId)
  useEffect(() => {
    if (!welcomePath || !activeStep) return
    const key = welcomePath + '/' + activeStep.id
    if (lastStep.current === key) return
    lastStep.current = key
    updateProgress(current => ({
      onboardingProgress: { ...current.onboardingProgress, path: welcomePath, stepId: activeStep.id },
    }))
  }, [activeStep, welcomePath, updateProgress])

  const handleFinish = async () => {
    await saveSettings({ setupCompleted: true, onboardingProgress: null })
    if (!agentOnly) {
      await updateGlobalSettings.mutateAsync({ app: { setupCompleted: true } }).catch(() => {})
    }
    onClose()
  }

  const agentFlow = useCreateAgentFlow({
    onboardingDraft: initialProgress?.agentDraft,
    saveOnboardingDraft: async agentDraft => {
      await saveSettings(current => ({
        onboardingProgress: { path: welcomePath ?? current.onboardingProgress?.path ?? 'manual', stepId: 'agent', agentDraft },
      }))
    },
    onAgentCreated: handleFinish,
  })

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

  const isAgentStep = agentOnly || activeStep?.id === 'agent'

  if (agentOnly) {
    return (
      <CreateAgentScreenLayout
        flow={agentFlow}
        data-testid="wizard-container"
        onAgentCreated={handleFinish}
        onNavigateAway={handleFinish}
        footer={(flow) => flow.stage === 'templates' || (flow.named && flow.stage !== 'name') ? (
          <Button variant="outline" onClick={flow.back}>Back</Button>
        ) : (
          <Button
            variant="outline"
            className="ml-auto"
            onClick={() => void handleFinish()}
            data-testid="wizard-skip"
          >
            Skip
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        )}
      />
    )
  }

  return (
    <div className="flex h-svh bg-background overflow-hidden" data-testid="wizard-container">
      {/* Draggable title bar region for Electron */}
      {isElectron() && <div className="absolute top-0 left-0 right-0 h-12 app-drag-region z-10" />}

      {/* Left column: wizard content */}
      <div className={`relative flex flex-col h-svh transition-[width] duration-500 ease-in-out ${isAgentStep ? 'w-full' : 'w-full lg:w-1/2'}`}>
        <h1 className="sr-only">Getting Started</h1>

        <div className={`flex flex-1 min-h-0 flex-col ${isAgentStep ? 'overflow-hidden' : 'justify-center'}`}>
          <div className={`w-full mx-auto transition-[max-width] duration-500 ${isAgentStep ? `${AGENT_STEP_MAX_WIDTH} flex h-full min-h-0 flex-col pt-10` : 'max-w-[480px] py-10'}`}>

          {/* Step content. The agent step fills the column height (its roster
              scrolls internally); the rest keep the centered min-height block. */}
          <div className={isAgentStep ? 'min-h-0 flex-1' : 'min-h-[320px]'} data-testid="wizard-step-content" data-step={currentStep}>
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
            {activeStep?.id === 'model' && <ConfigureModelStep />}
            {activeStep?.id === 'browser' && <BrowserSetupStep onCanProceedChange={setBrowserCanProceed} />}
            {activeStep?.id === 'composio' && <ComposioStep onCanProceedChange={setComposioCanProceed} saveRef={composioSaveRef} />}
            {activeStep?.id === 'runtime' && <DockerSetupStep onCanProceedChange={setRuntimeCanProceed} />}
            {activeStep?.id === 'privacy' && <PrivacyStep />}
            {activeStep?.id === 'agent' && <CreateAgentStep flow={agentFlow} onAgentCreated={handleFinish} onNavigateAway={handleFinish} />}
          </div>
          </div>
        </div>

        {/* Navigation buttons — hidden on welcome page */}
        <div className={`flex items-center justify-between pb-10 w-full mx-auto transition-[max-width] duration-500 ${isAgentStep ? `${AGENT_STEP_MAX_WIDTH} max-sm:py-6` : 'max-w-[480px]'} ${!welcomePath ? 'hidden' : ''}`}>
          {!welcomePath ? (
            <div />
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                // Inside the agent step, Back walks its own steps first.
                if (activeStep?.id === 'agent' && agentFlow.back()) return
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
            {canSkipStep && !(activeStep?.id === 'agent' && agentFlow.named) && (
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
            {activeStep?.id === 'agent' && <CreateAgentContinueButton flow={agentFlow} />}
          </div>
        </div>
      </div>

      {/* Right column: the cover, a crowd of agent orbs — slides out on the agent step */}
      <div className={`hidden lg:block p-4 shrink-0 transition-all duration-500 ease-in-out ${isAgentStep ? 'w-0 translate-x-full opacity-0 p-0' : 'w-1/2 translate-x-0 opacity-100'} ${getPlatform() === 'win32' ? 'pt-12' : ''}`}>
        <WelcomeOrbCrowd paused={isAgentStep} className="h-full w-full rounded-dialog" />
      </div>
    </div>
  )
}

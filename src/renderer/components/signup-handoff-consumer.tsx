// Always-mounted (route-layouts, above the wizard branch): moves the marketing
// signup handoff from the URL into the in-memory one-shot, then strips the
// params. A template-only first run also starts today's install here, because
// the create form never mounts on that path.
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { toast } from 'sonner'
import { TemplateInstallDialog } from '@renderer/components/agents/template-install-dialog'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useUser } from '@renderer/context/user-context'
import { useDiscoverableAgents, slugFromAgentPath } from '@renderer/hooks/use-agent-templates'
import { useCompleteTemplateInstall } from '@renderer/hooks/use-complete-template-install'
import { useSettings } from '@renderer/hooks/use-settings'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'
import { homeSearchSchema } from '@renderer/router/search-schemas'
import { lenient } from '@renderer/router/zod-search'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

export const HANDOFF_TEMPLATE_WAIT_MS = 10000

function toastTemplateNotFound() {
  toast.error("Couldn't load that template", {
    description: 'Pick one from Discover or create your own agent.',
  })
}

export function SignupHandoffConsumer() {
  // location.search is raw parseSearch output (router-core) — not route-validated.
  // Run the home schema here so truncate + model regex actually gate the one-shot.
  const search = useRouterState({
    select: (s) => s.location.search as Record<string, unknown>,
  })
  const navigate = useNavigate()
  const { setSignupHandoff } = useNavTransient()
  const { isAuthMode } = useUser()
  const { data: userSettings } = useUserSettings()
  const { data: globalSettings } = useSettings()
  const setupCompleted = userSettings?.setupCompleted
  const settingsReady = userSettings !== undefined
  const updateUserSettings = useUpdateUserSettings()
  const { data: discoverableAgents, isError: discoverableAgentsFailed } = useDiscoverableAgents()
  const completeInstall = useCompleteTemplateInstall()
  const [template, setTemplate] = useState<ApiDiscoverableAgent | null>(null)
  const resolvedRef = useRef(false)
  const slugRef = useRef<string | null>(null)

  const { prompt, model, template_slug } = lenient(homeSearchSchema)(search)
  if (!slugRef.current && template_slug && !prompt) {
    slugRef.current = template_slug
  }
  const slug = slugRef.current
  // RootLayout skips the create wizard only for an auth user's agent-only
  // first run. Full/local setup still needs the wizard, whose create step owns
  // the existing handoff flow.
  const canAutoInstallTemplate =
    isAuthMode && globalSettings?.setupCompleted === true && settingsReady && !setupCompleted

  useEffect(() => {
    if (!prompt && !model && !template_slug) return
    setSignupHandoff({ prompt, model, template_slug })
    // Explicit '/' — the params live on homeSearchSchema, registered only on the
    // home route (routes.ts:57); the sibling search mutation uses to: '/' too
    // (home-page.tsx:922).
    void navigate({
      to: '/',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        prompt: undefined,
        model: undefined,
        template_slug: undefined,
      }),
      replace: true,
    })
  }, [prompt, model, template_slug, setSignupHandoff, navigate])

  useEffect(() => {
    if (slug && canAutoInstallTemplate) setSignupHandoff(null)
  }, [slug, canAutoInstallTemplate, setSignupHandoff])

  useEffect(() => {
    if (!slug || resolvedRef.current) return
    if (!canAutoInstallTemplate) return
    if (discoverableAgentsFailed) {
      resolvedRef.current = true
      toastTemplateNotFound()
      return
    }
    if (!discoverableAgents || discoverableAgents.length === 0) {
      const timer = setTimeout(() => {
        if (resolvedRef.current) return
        resolvedRef.current = true
        toastTemplateNotFound()
      }, HANDOFF_TEMPLATE_WAIT_MS)
      return () => clearTimeout(timer)
    }
    const target = discoverableAgents.find(
      (a) => a.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && slugFromAgentPath(a.path) === slug,
    )
    resolvedRef.current = true
    if (!target) {
      toastTemplateNotFound()
      return
    }
    setTemplate(target)
  }, [canAutoInstallTemplate, discoverableAgents, discoverableAgentsFailed, slug])

  return (
    <TemplateInstallDialog
      template={template}
      onClose={() => setTemplate(null)}
      onInstalled={async (agent) => {
        try {
          await completeInstall(agent)
          await updateUserSettings.mutateAsync({ setupCompleted: true, onboardingProgress: null })
        } catch (error) {
          console.error('Template installed but setup finish failed:', error)
          toast.error('Agent installed, but setup status could not be saved.', {
            description: error instanceof Error ? error.message : 'Please try again from Settings.',
          })
        }
      }}
    />
  )
}

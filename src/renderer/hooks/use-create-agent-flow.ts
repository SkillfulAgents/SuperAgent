import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { v4 as uuid } from 'uuid'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useCreateAgent, useDeleteAgent, useStartAgent, useUpdateAgent, useUpdateAgentAvatar } from '@renderer/hooks/use-agents'
import { useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { creationDraftKey, readCreationDraft, saveCreationDraft, type ChosenAgentIdentity, type CreationDraft } from '@renderer/components/agents/creation-draft'
import type { CreateAgentFormProps } from '@renderer/components/agents/create-agent-form'
import { AGENT_AVATAR_SHAPES, DEFAULT_AGENT_AVATAR_COLORS, type AgentAvatar } from '@shared/lib/types/agent-avatar'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { startViewTransition } from '@renderer/lib/view-transition'

/** A first orb to start from, drawn like the server draws one for an agent created without a pick. */
function randomAgentAvatar(): AgentAvatar {
  const pick = <T,>(options: readonly T[]) => options[Math.floor(Math.random() * options.length)]
  return { color: pick(DEFAULT_AGENT_AVATAR_COLORS), shape: pick(AGENT_AVATAR_SHAPES) }
}

export type CreationOptions = Pick<CreateAgentFormProps, 'onAgentCreated' | 'surface'> & {
  onboardingDraft?: CreationDraft
  saveOnboardingDraft?: (draft: CreationDraft) => Promise<void>
  onIdentityCreated?: (agent: { slug: string }) => void | Promise<void>
}

export function useCreateAgentFlow({ onIdentityCreated, onAgentCreated, surface, onboardingDraft, saveOnboardingDraft }: CreationOptions = {}) {
  const [key] = useState(() => {
    const entry = creationDraftKey()
    return entry && saveOnboardingDraft ? entry + ':onboarding' : entry
  })
  const [draft] = useState(() => readCreationDraft(key) ?? onboardingDraft)
  const { signupHandoff } = useNavTransient()
  const [stage, setStage] = useState<CreationDraft['stage']>(() =>
    draft?.stage ?? (signupHandoff?.template_slug && !signupHandoff.prompt ? 'describe' : 'name'))
  const [identity, setIdentity] = useState<ChosenAgentIdentity>(() => draft?.identity ?? { name: '', avatar: randomAgentAvatar() })
  const initialIdentity = useRef(identity)
  const [agent, setAgent] = useState(draft?.agent)
  // Read when an import lands, which can be long after the click that started it.
  const latestAgent = useRef(agent)
  useEffect(() => { latestAgent.current = agent }, [agent])
  const [prompt, setPrompt] = useState(draft?.prompt ?? '')
  const [runtimeOptions, setRuntimeOptions] = useState(draft?.runtimeOptions)
  const [sessionRequestId] = useState(() => draft?.sessionRequestId ?? uuid())
  const requestId = useRef(draft?.requestId)
  const resumeCreation = useRef(!!draft?.requestId && !draft.agent && draft.stage === 'describe')
  const [saving, setSaving] = useState(resumeCreation.current)
  const [dreamSelected, setDreamSelected] = useState(draft?.dreamSelected ?? false)
  const [addonBusy, setAddonBusy] = useState(false)
  const busy = useRef(false)
  const finished = useRef(false)
  const confirmed = useRef(draft?.agent ? draft.identity : undefined)
  const submitRef = useRef<(() => Promise<void>) | null>(null)
  const continueRef = useRef<(() => Promise<void>) | null>(null)
  const createAgent = useCreateAgent()
  const rename = useUpdateAgent()
  const updateAvatar = useUpdateAgentAvatar()
  const deleteAgent = useDeleteAgent()
  const startAgent = useStartAgent()
  const warmStartEnabled = useWarmStartOnTypeEnabled()
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()

  useEffect(() => {
    if (!finished.current && (agent || requestId.current || identity !== initialIdentity.current)) {
      saveCreationDraft(key, { agent, sessionRequestId, requestId: agent ? undefined : requestId.current, identity: confirmed.current ?? identity, stage, prompt, runtimeOptions, dreamSelected })
    }
  }, [key, agent, identity, sessionRequestId, saving, stage, prompt, runtimeOptions, dreamSelected])

  useEffect(() => {
    if (resumeCreation.current) {
      resumeCreation.current = false
      void confirmIdentity()
    }
  })

  /**
   * A change of step is one view transition: the orb carries the same
   * `view-transition-name` on every step (CREATE_AGENT_ORB_TRANSITION), so it
   * travels from its place on one to its place on the next while the rest
   * cross-fades. Where the API is missing the step just changes.
   */
  function moveTo(next: CreationDraft['stage'], alongside?: () => void) {
    startViewTransition(() => flushSync(() => {
      alongside?.()
      setStage(next)
    }))
  }

  async function confirmIdentity() {
    if (busy.current || !identity.name.trim()) return
    busy.current = true
    setSaving(true)
    const chosen = { ...identity, name: identity.name.trim() }
    setIdentity(chosen)
    // A resumed creation is already on the job step: nothing to move.
    if (stage !== 'describe') moveTo('describe')
    try {
      let target = agent
      if (!target) {
        requestId.current ??= uuid()
        // Store the request before dispatch. A refresh can replay this exact create.
        const checkpoint: CreationDraft = { requestId: requestId.current, sessionRequestId, identity: chosen, stage: 'describe', prompt, runtimeOptions, dreamSelected }
        saveCreationDraft(key, checkpoint)
        await saveOnboardingDraft?.(checkpoint)
        const created = await createAgent.mutateAsync({ ...chosen, requestId: requestId.current })
        target = { slug: created.slug, displaySlug: created.displaySlug }
        confirmed.current = { name: created.name, avatar: created.avatar ?? chosen.avatar }
        setAgent(target)
        if (!created.replayed) track('agent_created', { source: 'new', ...(surface && { surface }), num_skills_added_at_creation: 0 })
        if (warmStartEnabled) startAgent.mutate({ slug: created.slug, source: 'warm-start' })
        await onIdentityCreated?.(created)
      }
      if (confirmed.current?.name !== chosen.name) {
        const updated = await rename.mutateAsync({ slug: target.slug, name: chosen.name })
        target = { slug: target.slug, displaySlug: updated.displaySlug }
        setAgent(target)
        if (confirmed.current) confirmed.current = { ...confirmed.current, name: chosen.name }
      }
      if (confirmed.current?.avatar.color !== chosen.avatar.color || confirmed.current.avatar.shape !== chosen.avatar.shape) {
        await updateAvatar.mutateAsync({ slug: target.slug, avatar: chosen.avatar })
      }
      confirmed.current = chosen
      await saveOnboardingDraft?.({ agent: target, identity: chosen, sessionRequestId, stage: 'describe', prompt, runtimeOptions, dreamSelected })
    } catch (error) {
      toast.error('Could not save your agent', { description: error instanceof Error ? error.message : undefined })
      moveTo('name')
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  const complete = async (result: { slug: string }) => {
    await onAgentCreated?.(result)
    finished.current = true
    saveCreationDraft(key, null)
  }

  /**
   * An agent imported on the job step takes the place of the one the name
   * step made. It was imported under the chosen name; here it gets the chosen
   * orb and that agent's place in the sidebar, and the empty one is deleted.
   * Nothing here can undo the import, so a step that fails is reported and
   * the imported agent still opens.
   */
  async function replaceWithImported(imported: { slug: string }) {
    const replaced = latestAgent.current
    // The flow ends here: a refresh must not resume an agent about to be deleted.
    finished.current = true
    saveCreationDraft(key, null)
    try {
      await updateAvatar.mutateAsync({ slug: imported.slug, avatar: identity.avatar })
    } catch {
      toast.error('Agent imported, but its avatar could not be set', { description: 'You can change it from the agent’s settings.' })
    }
    await onIdentityCreated?.(imported)
    if (!replaced || replaced.slug === imported.slug) return
    try {
      await deleteAgent.mutateAsync(replaced.slug)
    } catch (error) {
      toast.error(`Agent imported, but the empty “${identity.name}” could not be removed`, { description: error instanceof Error ? error.message : undefined })
    }
  }

  async function continueToAddons(job: string, options: NonNullable<CreationDraft['runtimeOptions']>) {
    if (busy.current || !agent) return
    busy.current = true
    setSaving(true)
    try {
      await saveOnboardingDraft?.({ agent, identity, sessionRequestId, stage: 'addons', prompt: job, runtimeOptions: options, dreamSelected })
      moveTo('addons', () => {
        setPrompt(job)
        setRuntimeOptions(options)
      })
    } catch (error) {
      toast.error('Could not save your first job', { description: error instanceof Error ? error.message : undefined })
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  async function finish(destination: 'home' | 'session') {
    if (busy.current || finished.current || !agent || addonBusy) return
    busy.current = true
    setSaving(true)
    try {
      if (destination === 'home') {
        await navigate({ to: '/agents/$slug', params: { slug: agent.displaySlug }, replace: true })
        await complete(agent)
      } else {
        await submitRef.current?.()
      }
    } catch (error) {
      toast.error('Could not finish setup', { description: error instanceof Error ? error.message : undefined })
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  function back() {
    if (busy.current || addonBusy) return true
    if (stage === 'name') return false
    moveTo(stage === 'addons' ? 'describe' : 'name')
    return true
  }
  return {
    stage, identity, setIdentity, agent, sessionRequestId, prompt, setPrompt, named: !!agent || saving,
    initialRuntimeOptions: runtimeOptions, setRuntimeOptions,
    saving, addonBusy, setAddonBusy, dreamSelected, setDreamSelected, confirmIdentity, complete, finish, back, replaceWithImported,
    backToName: () => { if (!busy.current && !addonBusy) moveTo('name') },
    continueToAddons,
    submitRef, continueRef,
  }
}

export type CreateAgentFlow = ReturnType<typeof useCreateAgentFlow>

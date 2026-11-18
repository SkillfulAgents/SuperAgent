import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useCreateAgent, useStartAgent, useUpdateAgent, useUpdateAgentAvatar } from '@renderer/hooks/use-agents'
import { useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { creationDraftKey, readCreationDraft, saveCreationDraft, type ChosenAgentIdentity, type CreationDraft } from '@renderer/components/agents/creation-draft'
import { useEffect, useRef, useState } from 'react'
import type { CreateAgentFormProps } from '@renderer/components/agents/create-agent-form'
import { AGENT_AVATAR_SHAPES, DEFAULT_AGENT_AVATAR_COLORS, type AgentAvatar } from '@shared/lib/types/agent-avatar'
import { useNavTransient } from '@renderer/context/nav-transient-context'

/** A first orb to start from, drawn like the server draws one for an agent created without a pick. */
function randomAgentAvatar(): AgentAvatar {
  const pick = <T,>(options: readonly T[]) => options[Math.floor(Math.random() * options.length)]
  return { color: pick(DEFAULT_AGENT_AVATAR_COLORS), shape: pick(AGENT_AVATAR_SHAPES) }
}

export type CreationOptions = Pick<CreateAgentFormProps, 'onAgentCreated' | 'surface'> & {
  onIdentityCreated?: (agent: { slug: string }) => void | Promise<void>
}

export function useCreateAgentFlow({ onIdentityCreated, onAgentCreated, surface }: CreationOptions = {}) {
  const [key] = useState(creationDraftKey)
  const [draft] = useState(() => readCreationDraft(key))
  const { signupHandoff } = useNavTransient()
  const [stage, setStage] = useState<CreationDraft['stage'] | 'templates'>(() =>
    draft?.stage ?? (signupHandoff?.template_slug && !signupHandoff.prompt ? 'describe' : 'name'))
  const [identity, setIdentity] = useState<ChosenAgentIdentity>(() => draft?.identity ?? { name: '', avatar: randomAgentAvatar() })
  const [agent, setAgent] = useState(draft?.agent)
  const [prompt, setPrompt] = useState(draft?.prompt ?? '')
  const [importing, setImporting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addonBusy, setAddonBusy] = useState(false)
  const busy = useRef(false)
  const finished = useRef(false)
  const confirmed = useRef(draft?.identity)
  const submitRef = useRef<(() => Promise<void>) | null>(null)
  const continueRef = useRef<(() => Promise<void>) | null>(null)
  const createAgent = useCreateAgent()
  const rename = useUpdateAgent()
  const updateAvatar = useUpdateAgentAvatar()
  const startAgent = useStartAgent()
  const warmStartEnabled = useWarmStartOnTypeEnabled()
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()

  useEffect(() => {
    if (!finished.current && agent && stage !== 'templates') saveCreationDraft(key, { agent, identity: confirmed.current ?? identity, stage, prompt })
  }, [key, agent, identity, stage, prompt])

  async function confirmIdentity() {
    if (busy.current || !identity.name.trim()) return
    busy.current = true
    setSaving(true)
    const chosen = { ...identity, name: identity.name.trim() }
    setIdentity(chosen)
    setStage('describe')
    try {
      if (!agent) {
        const created = await createAgent.mutateAsync(chosen)
        confirmed.current = chosen
        setAgent({ slug: created.slug, displaySlug: created.displaySlug })
        track('agent_created', { source: 'new', ...(surface && { surface }), num_skills_added_at_creation: 0 })
        if (warmStartEnabled) startAgent.mutate({ slug: created.slug, source: 'warm-start' })
        await onIdentityCreated?.(created)
      } else {
        if (confirmed.current?.name !== chosen.name) {
          const updated = await rename.mutateAsync({ slug: agent.slug, name: chosen.name })
          setAgent({ slug: agent.slug, displaySlug: updated.displaySlug })
          if (confirmed.current) confirmed.current = { ...confirmed.current, name: chosen.name }
        }
        if (confirmed.current?.avatar.color !== chosen.avatar.color || confirmed.current.avatar.shape !== chosen.avatar.shape) {
          await updateAvatar.mutateAsync({ slug: agent.slug, avatar: chosen.avatar })
        }
        confirmed.current = chosen
      }
    } catch (error) {
      toast.error('Could not save your agent', { description: error instanceof Error ? error.message : undefined })
      setStage('name')
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  const complete = async (result: { slug: string }) => {
    finished.current = true
    saveCreationDraft(key, null)
    await onAgentCreated?.(result)
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
    setStage(stage === 'addons' ? 'describe' : 'name')
    return true
  }
  function showChoices(openImport: boolean) {
    setImporting(openImport)
    setStage('templates')
  }
  return {
    stage, identity, setIdentity, agent, prompt, setPrompt, named: !!agent || saving,
    saving, addonBusy, setAddonBusy, confirmIdentity, complete, finish, back, showChoices, importing,
    backToName: () => { if (!busy.current && !addonBusy) setStage('name') },
    continueToAddons: () => { if (!busy.current && agent) setStage('addons') },
    submitRef, continueRef,
  }
}

export type CreateAgentFlow = ReturnType<typeof useCreateAgentFlow>

// Always-mounted (route-layouts, above the wizard branch): moves the marketing
// signup handoff from the URL into the in-memory one-shot, then strips the
// params. One effect, one shot.
import { useEffect } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'

import { useNavTransient } from '@renderer/context/nav-transient-context'
import { homeSearchSchema } from '@renderer/router/search-schemas'
import { lenient } from '@renderer/router/zod-search'

export function SignupHandoffConsumer() {
  // location.search is raw parseSearch output (router-core) — not route-validated.
  // Run the home schema here so truncate + model regex actually gate the one-shot.
  const search = useRouterState({
    select: (s) => s.location.search as Record<string, unknown>,
  })
  const navigate = useNavigate()
  const { setSignupHandoff } = useNavTransient()

  const { prompt, model } = lenient(homeSearchSchema)(search)
  useEffect(() => {
    if (!prompt && !model) return
    setSignupHandoff({ prompt, model })
    // Explicit '/' — the params live on homeSearchSchema, registered only on the
    // home route (routes.ts:57); the sibling search mutation uses to: '/' too
    // (home-page.tsx:922).
    void navigate({
      to: '/',
      search: (prev: Record<string, unknown>) => ({ ...prev, prompt: undefined, model: undefined }),
      replace: true,
    })
  }, [prompt, model, setSignupHandoff, navigate])

  return null
}

import { useState } from 'react'
import { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'
import { useUpdateSettings } from '@renderer/hooks/use-settings'

const validationSchema = z.object({ valid: z.boolean(), error: z.string().optional() })
export type SteelKeyValidation = z.infer<typeof validationSchema>

/**
 * The Steel API key form shared by Settings → Browser Use and the setup
 * wizard: what is typed, the check against Steel before it is saved, and
 * removing a saved key. A saved key is never read back; the form clears once
 * it is saved.
 */
export function useSteelCredentials() {
  const updateSettings = useUpdateSettings()
  const [apiKey, setApiKeyState] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<SteelKeyValidation | null>(null)

  const setApiKey = (value: string) => {
    setApiKeyState(value)
    setValidationResult(null)
  }

  const validateAndSave = async () => {
    const key = apiKey.trim()
    if (!key) {
      setValidationResult({ valid: false, error: 'Enter your API key.' })
      return
    }
    setIsValidating(true)
    setValidationResult(null)
    try {
      const res = await apiFetch('/api/settings/validate-steel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      })
      const parsed = validationSchema.safeParse(await res.json().catch(() => null))
      const result = parsed.success ? parsed.data : { valid: false, error: 'Failed to validate the API key' }
      setValidationResult(result)
      if (result.valid) {
        await updateSettings.mutateAsync({ apiKeys: { steelApiKey: key } })
        // Clear the input so the button hides; the saved state shows in the placeholder.
        setApiKeyState('')
      }
    } catch {
      setValidationResult({ valid: false, error: 'Failed to validate the API key' })
    } finally {
      setIsValidating(false)
    }
  }

  const remove = async () => {
    setIsValidating(true)
    try {
      await updateSettings.mutateAsync({ apiKeys: { steelApiKey: '' } })
      setApiKeyState('')
      setValidationResult(null)
    } finally {
      setIsValidating(false)
    }
  }

  return { apiKey, setApiKey, isValidating, validationResult, validateAndSave, remove }
}

export type SteelCredentialsForm = ReturnType<typeof useSteelCredentials>

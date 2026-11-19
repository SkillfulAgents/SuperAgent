import { useState } from 'react'
import { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'

const validationSchema = z.object({ valid: z.boolean(), error: z.string().optional(), url: z.string().optional() })
export type TabtenderValidation = z.infer<typeof validationSchema>

/**
 * The Tab Tender server form shared by Settings → Browser Use and the setup
 * wizard: the server URL and API key typed, the check against that server
 * before they are saved, and removing them. The saved URL is shown and
 * editable; a saved key is never read back, and its input clears once saved.
 */
export function useTabtenderCredentials() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  /** Null until edited: the saved URL shows until then. */
  const [editedUrl, setEditedUrl] = useState<string | null>(null)
  const [apiKey, setApiKeyState] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<TabtenderValidation | null>(null)

  const savedUrl = settings?.tabtenderUrl ?? ''
  const url = editedUrl ?? savedUrl

  const setUrl = (value: string) => {
    setEditedUrl(value)
    setValidationResult(null)
  }
  const setApiKey = (value: string) => {
    setApiKeyState(value)
    setValidationResult(null)
  }

  const validateAndSave = async () => {
    const serverUrl = url.trim()
    const key = apiKey.trim()
    if (!serverUrl || !key) {
      setValidationResult({ valid: false, error: 'Enter the server URL and API key.' })
      return
    }
    setIsValidating(true)
    setValidationResult(null)
    try {
      const res = await apiFetch('/api/settings/validate-tabtender', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: serverUrl, apiKey: key }),
      })
      const parsed = validationSchema.safeParse(await res.json().catch(() => null))
      const result = parsed.success ? parsed.data : { valid: false, error: 'Failed to check the server' }
      setValidationResult(result)
      if (result.valid) {
        await updateSettings.mutateAsync({ apiKeys: { tabtenderUrl: result.url ?? serverUrl, tabtenderApiKey: key } })
        // Clear the inputs so the button hides; the saved URL shows again and the key's saved state in its placeholder.
        setEditedUrl(null)
        setApiKeyState('')
      }
    } catch {
      setValidationResult({ valid: false, error: 'Failed to check the server' })
    } finally {
      setIsValidating(false)
    }
  }

  const remove = async () => {
    setIsValidating(true)
    try {
      await updateSettings.mutateAsync({ apiKeys: { tabtenderUrl: '', tabtenderApiKey: '' } })
      setEditedUrl(null)
      setApiKeyState('')
      setValidationResult(null)
    } finally {
      setIsValidating(false)
    }
  }

  return { url, setUrl, apiKey, setApiKey, isValidating, validationResult, validateAndSave, remove }
}

export type TabtenderCredentialsForm = ReturnType<typeof useTabtenderCredentials>

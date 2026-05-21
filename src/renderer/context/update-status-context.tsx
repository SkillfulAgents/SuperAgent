import { createContext, useContext, useEffect, useState } from 'react'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
}

const UpdateStatusContext = createContext<UpdateStatus>({ state: 'idle' })

export function UpdateStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    if (!window.electronAPI) return
    let cancelled = false
    window.electronAPI.getUpdateStatus()
      .then((s) => { if (!cancelled) setStatus(s) })
      .catch(() => { /* IPC handler may briefly be unavailable; status stays idle */ })
    const unsubscribe = window.electronAPI.onUpdateStatus((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return <UpdateStatusContext.Provider value={status}>{children}</UpdateStatusContext.Provider>
}

export function useUpdateStatus(): UpdateStatus {
  return useContext(UpdateStatusContext)
}

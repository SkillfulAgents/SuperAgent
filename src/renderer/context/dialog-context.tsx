import { createContext, useContext, useState, useEffect, useCallback } from 'react'

interface DialogContextType {
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  settingsTab: string | undefined
  openSettings: (tab?: string) => void
  createAgentOpen: boolean
  setCreateAgentOpen: (open: boolean) => void
  openWizard: () => void
}

const DialogContext = createContext<DialogContextType | null>(null)

export function DialogProvider({
  children,
  onOpenWizard,
}: {
  children: React.ReactNode
  onOpenWizard: () => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>()
  const [createAgentOpen, setCreateAgentOpen] = useState(false)

  const openSettings = useCallback((tab?: string) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])

  const openWizard = useCallback(() => {
    setSettingsOpen(false)
    onOpenWizard()
  }, [onOpenWizard])

  // Listen for menu commands from Electron main process
  useEffect(() => {
    if (!window.electronAPI) return

    window.electronAPI.onOpenSettings?.(() => {
      setSettingsOpen(true)
    })

    window.electronAPI.onOpenCreateAgent?.(() => {
      setCreateAgentOpen(true)
    })

    return () => {
      window.electronAPI?.removeOpenSettings?.()
      window.electronAPI?.removeOpenCreateAgent?.()
    }
  }, [])

  return (
    <DialogContext.Provider
      value={{
        settingsOpen,
        setSettingsOpen,
        settingsTab,
        openSettings,
        createAgentOpen,
        setCreateAgentOpen,
        openWizard,
      }}
    >
      {children}
    </DialogContext.Provider>
  )
}

export function useDialogs(): DialogContextType {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialogs must be used within DialogProvider')
  return ctx
}

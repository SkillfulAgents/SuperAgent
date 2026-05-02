import { createContext, useContext, useState, useEffect, useCallback } from 'react'

interface DialogContextType {
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  settingsTab: string | undefined
  openSettings: (tab?: string) => void
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
  const [settingsOpen, setSettingsOpenRaw] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>()

  // Clear deep-link tab when closing so the next plain open lands on the default section.
  const setSettingsOpen = useCallback((open: boolean) => {
    if (!open) setSettingsTab(undefined)
    setSettingsOpenRaw(open)
  }, [])

  const openSettings = useCallback((tab?: string) => {
    setSettingsTab(tab)
    setSettingsOpenRaw(true)
  }, [])

  const openWizard = useCallback(() => {
    setSettingsOpen(false)
    onOpenWizard()
  }, [onOpenWizard, setSettingsOpen])

  // Listen for menu commands from Electron main process
  useEffect(() => {
    if (!window.electronAPI) return

    window.electronAPI.onOpenSettings?.(() => {
      setSettingsOpenRaw(true)
    })

    return () => {
      window.electronAPI?.removeOpenSettings?.()
    }
  }, [])

  return (
    <DialogContext.Provider
      value={{
        settingsOpen,
        setSettingsOpen,
        settingsTab,
        openSettings,
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

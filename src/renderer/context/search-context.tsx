import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

interface SearchContextType {
  open: boolean
  openSearch: () => void
  closeSearch: () => void
}

const SearchContext = createContext<SearchContextType | null>(null)

export function SearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  const openSearch = useCallback(() => setOpen(true), [])
  const closeSearch = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // The dialog itself renders from RootLayout (inside the router) so it can use
  // the useNavigate hook (R11 §7.7); this provider just owns the open state + the
  // cmd/ctrl-K shortcut.
  return (
    <SearchContext.Provider value={{ open, openSearch, closeSearch }}>
      {children}
    </SearchContext.Provider>
  )
}

export function useSearch(): SearchContextType {
  const ctx = useContext(SearchContext)
  if (!ctx) throw new Error('useSearch must be used within a SearchProvider')
  return ctx
}

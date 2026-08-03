import { create } from 'zustand'

interface AppState {
  sidebarOpen: boolean
  theme: 'dark' | 'light'
  settingsOpen: boolean
  rightPanelOpen: boolean
  rightPanelTab: 'activity' | 'files' | 'terminal' | 'review'
  searchQuery: string
  cliInstalled: boolean
  cliVersion: string | null
  cliError: string | null

  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setTheme: (theme: 'dark' | 'light') => void
  toggleSettings: () => void
  setRightPanelOpen: (open: boolean) => void
  setRightPanelTab: (tab: 'activity' | 'files' | 'terminal' | 'review') => void
  setSearchQuery: (query: string) => void
  setCliStatus: (installed: boolean, version: string | null, error: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  theme: (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark',
  settingsOpen: false,
  rightPanelOpen: false,
  rightPanelTab: 'activity',
  searchQuery: '',
  cliInstalled: false,
  cliVersion: null,
  cliError: null,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('cc-theme', theme) } catch {}
    set({ theme })
  },
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab, rightPanelOpen: true }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setCliStatus: (installed, version, error) => set({ cliInstalled: installed, cliVersion: version, cliError: error }),
}))

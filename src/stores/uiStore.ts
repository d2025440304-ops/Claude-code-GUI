import { create } from 'zustand'

interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
}

interface UIState {
  confirmDialog: ConfirmDialogState | null
  apiKey: string
  apiKeyVisible: boolean
  apiKeySaved: boolean
  historyOpen: boolean
  editingTitleId: string | null
  editingTitle: string

  showConfirm: (dialog: ConfirmDialogState) => void
  dismissConfirm: () => void
  setApiKey: (key: string) => void
  setApiKeyVisible: (visible: boolean) => void
  setApiKeySaved: (saved: boolean) => void
  setHistoryOpen: (open: boolean) => void
  startEditingTitle: (id: string, title: string) => void
  cancelEditingTitle: () => void
  setEditingTitle: (title: string) => void
}

export const useUIStore = create<UIState>((set) => ({
  confirmDialog: null,
  apiKey: '',
  apiKeyVisible: false,
  apiKeySaved: false,
  historyOpen: false,
  editingTitleId: null,
  editingTitle: '',

  showConfirm: (dialog) => set({ confirmDialog: dialog }),
  dismissConfirm: () => set({ confirmDialog: null }),
  setApiKey: (key) => set({ apiKey: key }),
  setApiKeyVisible: (visible) => set({ apiKeyVisible: visible }),
  setApiKeySaved: (saved) => set({ apiKeySaved: saved }),
  setHistoryOpen: (open) => set({ historyOpen: open }),
  startEditingTitle: (id, title) => set({ editingTitleId: id, editingTitle: title }),
  cancelEditingTitle: () => set({ editingTitleId: null, editingTitle: '' }),
  setEditingTitle: (title) => set({ editingTitle: title }),
}))

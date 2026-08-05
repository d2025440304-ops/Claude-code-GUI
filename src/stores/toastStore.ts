/**
 * Toast notification store — 全局错误/通知系统。
 * 所有被静默吞没的错误现在都会显示给用户。
 */
import { create } from 'zustand'

export interface Toast {
  id: string
  type: 'error' | 'warning' | 'success' | 'info'
  message: string
  detail?: string
  timestamp: number
}

interface ToastState {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id' | 'timestamp'>) => void
  removeToast: (id: string) => void
  /** 全局错误处理：替换 .catch(() => {}) */
  handleError: (context: string, err: unknown) => void
}

let counter = 0

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${++counter}-${Date.now()}`
    const t: Toast = { ...toast, id, timestamp: Date.now() }
    set((s) => ({ toasts: [...s.toasts.slice(-19), t] }))
    // 自动移除（错误 15s，其他 5s）
    const duration = toast.type === 'error' ? 15000 : 5000
    setTimeout(() => {
      get().removeToast(id)
    }, duration)
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  handleError: (context, err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${context}]`, err)
    get().addToast({ type: 'error', message, detail: context })
  },
}))
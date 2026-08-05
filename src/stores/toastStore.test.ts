/**
 * ToastStore — 全局错误通知系统单元测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToastStore } from './toastStore'

describe('toastStore', () => {
  beforeEach(() => {
    // Reset store
    useToastStore.setState({ toasts: [] })
  })

  it('starts empty', () => {
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('adds a toast', () => {
    useToastStore.getState().addToast({ type: 'error', message: 'Test error' })
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('Test error')
    expect(toasts[0].type).toBe('error')
    expect(toasts[0].id).toBeTruthy()
    expect(toasts[0].timestamp).toBeGreaterThan(0)
  })

  it('removes a toast', () => {
    useToastStore.getState().addToast({ type: 'info', message: 'Test' })
    const id = useToastStore.getState().toasts[0].id
    useToastStore.getState().removeToast(id)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('caps at 20 toasts', () => {
    for (let i = 0; i < 25; i++) {
      useToastStore.getState().addToast({ type: 'info', message: `Toast ${i}` })
    }
    expect(useToastStore.getState().toasts.length).toBeLessThanOrEqual(20)
  })

  it('handleError logs and adds error toast', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('Something went wrong')

    useToastStore.getState().handleError('TestComponent', err)

    expect(consoleSpy).toHaveBeenCalledWith('[TestComponent]', err)
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].type).toBe('error')
    expect(toasts[0].message).toBe('Something went wrong')
    expect(toasts[0].detail).toBe('TestComponent')

    consoleSpy.mockRestore()
  })

  it('handleError works with string errors', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    useToastStore.getState().handleError('Test', 'raw string error')

    expect(consoleSpy).toHaveBeenCalled()
    const toasts = useToastStore.getState().toasts
    expect(toasts[0].message).toBe('raw string error')

    consoleSpy.mockRestore()
  })
})
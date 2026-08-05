/**
 * 真正的 Error Boundary — 捕获 React 渲染异常，显示恢复界面并上报。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught error:', error, info)
    this.props.onError?.(error, info)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div
          className="flex flex-col items-center justify-center gap-4 p-8"
          style={{
            minHeight: 300,
            background: 'var(--bg-surface-1)',
            borderRadius: 12,
            border: '1px solid rgba(239,68,68,0.2)',
          }}
        >
          <AlertTriangle size={32} style={{ color: '#ef4444' }} />
          <div className="text-center">
            <h2 className="text-[16px] font-semibold" style={{ color: 'var(--fg-primary)' }}>
              渲染异常
            </h2>
            <p className="text-[12px] mt-1" style={{ color: 'var(--fg-tertiary)', maxWidth: 400 }}>
              {this.state.error?.message || '发生了意外的渲染错误'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
              style={{ background: 'var(--tint-subtle)', color: 'var(--fg-secondary)' }}
            >
              <RefreshCw size={12} />
              重试
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
              style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-bright)' }}
            >
              <RefreshCw size={12} />
              重新加载
            </button>
          </div>
          {this.state.error?.stack && (
            <details className="w-full max-w-lg">
              <summary className="text-[10px] cursor-pointer" style={{ color: 'var(--fg-quaternary)' }}>
                错误详情
              </summary>
              <pre className="mt-1 p-2 rounded text-[10px] font-mono overflow-auto max-h-40" style={{ background: 'var(--code-bg)', color: 'var(--fg-tertiary)' }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      )
    }

    return this.props.children
  }
}